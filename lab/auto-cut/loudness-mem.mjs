/**
 * ラウドネスの測りのメモリの山を、**別のプロセスで**測る。
 *
 *   node lab/auto-cut/loudness-mem.mjs <秒> <none|whole|stream|chain-whole|chain-stream> [区間の秒] [ch]
 *
 * 同じプロセスの中で前後を引く形では測れない（V8 は一度伸ばした領域を返さない）。
 * `limit-mem.mjs` と同じ理由・同じ作り: 子の `ru_maxrss` は fork した時点の
 * 親の常駐量を引き継ぐので、**走り出しの値を子自身が報告して、それを引く。**
 *
 * `whole` は素材を丸ごと起こしてから `measureLoudness` に通す（＝これまでの形）。
 * `stream` は `generatedSource` をそのまま流す（**標本の列をどこにも持たない**）。
 * `chain-*` は書き出しの道すじぜんたい——**測る → 倍率を決める → リミッタを通す**——を
 * 通したときの山。倍率は測り終わるまで決まらないので、流す形は**素材を 2 回読む。**
 * 出口はどちらも捨てる（書き出し先のことは測っていない）。
 *
 * `kw-old` / `kw-new` は K 特性を通す段だけ。`kw-old` は 2026-10-02（2 回目）**より前**の形
 * （段ごとに新しい列を作る）をここに写したもので、いまのコードからは消えている。
 * **消した側を測れるように残してある**——流す形のために漸化式を 1 か所へまとめたら、
 * 一括のほうが 2.3 分の 1・5.7 倍速になったので、その差の出所をここで示せるようにしておく。
 *
 * 素材は `limit-signal.mjs` と同じ波（2026-10-02・1 回目のリミッタの表と並べて読めるように）。
 */

const [, , secondsArg, mode, blockArg, chArg] = process.argv;
const { measureLoudness, measureLoudnessStream, planLoudnessNormalization } = await import('./src/lufs.ts');
const { limitTruePeak, limitTruePeakStream } = await import('./src/limiter.ts');
const { blockSourceOf } = await import('./src/loudness.ts');
const { generatedSource, materialize, foldHash } = await import('./limit-signal.mjs');

const seconds = Number(secondsArg);
const channels = Number(chArg ?? 1);
const blockSeconds = Number(blockArg ?? 5);
const at0 = { max: process.resourceUsage().maxRSS * 1024 };

/** 倍率を掛けた列を返す入り口（元の `read` の上に重ねるだけ。列を持たない）。 */
const gained = (source, gain) => ({
  sampleRate: source.sampleRate,
  numberOfChannels: source.numberOfChannels,
  length: source.length,
  read(from, to) {
    const got = source.read(from, to);
    for (const a of got) for (let i = 0; i < a.length; i += 1) a[i] *= gain;
    return got;
  },
});

let out = null;
let ms = 0;
if (mode === 'none') {
  // 床を測るためだけの空回し（モジュールを読む手間までは同じ）。
  out = {};
} else if (mode === 'whole') {
  const buffer = materialize(seconds, { channels });
  const t0 = performance.now();
  const m = measureLoudness(buffer);
  ms = performance.now() - t0;
  out = { lufs: m.integratedLufs, tp: m.truePeakDb, gated: m.gatedBlocks, dropped: m.droppedBlocks };
} else if (mode === 'stream') {
  const source = generatedSource(seconds, { channels });
  const t0 = performance.now();
  const m = measureLoudnessStream(source, { blockSeconds });
  ms = performance.now() - t0;
  out = { lufs: m.integratedLufs, tp: m.truePeakDb, gated: m.gatedBlocks, dropped: m.droppedBlocks };
} else if (mode === 'chain-whole') {
  const buffer = materialize(seconds, { channels });
  const t0 = performance.now();
  const m = measureLoudness(buffer);
  const plan = planLoudnessNormalization(m, { limiterHeadroomDb: 12 });
  // 倍率を当てた列を作らずに済ませたいが、一括の道では `AudioLike` しか受けないので包む。
  const scaled = {
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    getChannelData: (c) => {
      const src = buffer.getChannelData(c);
      const a = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 1) a[i] = src[i] * plan.gain;
      return a;
    },
  };
  const r = limitTruePeak(scaled, { maxReductionDb: 12 });
  ms = performance.now() - t0;
  const hashes = new Array(channels).fill(2166136261);
  for (let c = 0; c < channels; c += 1) hashes[c] = foldHash(hashes[c], r.buffer.getChannelData(c));
  out = { lufs: m.integratedLufs, gainDb: plan.gainDb, limitedBy: plan.limitedBy, tpAfter: r.report.truePeakDb, hashes };
} else if (mode === 'chain-stream') {
  const t0 = performance.now();
  // 1 回め: 測る。**ここが終わるまで倍率が決まらない**ので、読みは 2 回になる。
  const m = measureLoudnessStream(generatedSource(seconds, { channels }), { blockSeconds });
  const plan = planLoudnessNormalization(m, { limiterHeadroomDb: 12 });
  // 2 回め: 倍率を当てながらリミッタへ流す。
  const hashes = new Array(channels).fill(2166136261);
  const report = limitTruePeakStream(
    gained(generatedSource(seconds, { channels }), plan.gain),
    (blocks) => {
      for (let c = 0; c < blocks.length; c += 1) hashes[c] = foldHash(hashes[c], blocks[c]);
    },
    { blockSeconds, maxReductionDb: 12 },
  );
  ms = performance.now() - t0;
  out = { lufs: m.integratedLufs, gainDb: plan.gainDb, limitedBy: plan.limitedBy, tpAfter: report.truePeakDb, hashes };
} else if (mode === 'kw-old' || mode === 'kw-new') {
  // 昔の形（`kw-old`）: 1 段ごとに新しい列を作る。写し ＋ 1 段目の出口 ＋ 2 段目の出口で 3 本。
  const runBiquad = (input, f) => {
    const out = new Float64Array(input.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < input.length; i += 1) {
      const x = input[i];
      const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    return out;
  };
  const { kWeighting, applyKWeighting } = await import('./src/lufs.ts');
  const oldApply = (samples, sampleRate) => {
    const [shelf, highpass] = kWeighting(sampleRate);
    const copy = new Float64Array(samples.length);
    copy.set(samples);
    return runBiquad(runBiquad(copy, shelf), highpass);
  };
  const buffer = materialize(seconds, { channels });
  const apply = mode === 'kw-old' ? oldApply : applyKWeighting;
  const t0 = performance.now();
  // **両端を足して外へ出す。** 使わないと、列ごと消される最適化が入ったときに測りが嘘になる。
  let edge = 0;
  for (let c = 0; c < channels; c += 1) {
    const filtered = apply(buffer.getChannelData(c), buffer.sampleRate);
    edge += filtered[0] + filtered[filtered.length - 1];
  }
  ms = performance.now() - t0;
  out = { edge };
} else {
  throw new Error(`知らない形です: ${mode}`);
}

console.log(
  JSON.stringify({
    mode,
    seconds,
    channels,
    blockSeconds,
    // 山そのものと、走り出しの床。**引き算した値だけを出すと 0 に潰れる**
    // （流す形は床を 1 バイトも超えないことがある。それが分かるように両方出す）。
    peak: process.resourceUsage().maxRSS * 1024,
    floor: at0.max,
    ms: Math.round(ms),
    out,
  }),
);
