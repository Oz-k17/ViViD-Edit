/**
 * クリップごとの音量合わせのメモリの山を、**別のプロセスで**測る。
 *
 *   node lab/auto-cut/clipmatch-mem.mjs <本数> <1 本の秒> <none|measure-whole|measure-stream|chain-whole|chain-stream> [区間の秒] [ch]
 *
 * 同じプロセスの中で前後を引く形では測れない（V8 は一度伸ばした領域を返さない）。
 * `loudness-mem.mjs` と同じ理由・同じ作り: 子の `ru_maxrss` は fork した時点の
 * 親の常駐量を引き継ぐので、**走り出しの値を子自身が報告して、それを引く。**
 *
 * `measure-*` は「クリップを 1 本ずつ測る」段だけ。**一括はここで全部のクリップを
 * 同時に抱える**（`measureClips` の引数が `ClipSource[]` なので、測り始める前に全部起きている）。
 * `chain-*` は書き出しの道すじぜんたい——**クリップごとに揃える → 繋ぐ → 全体を目標へ → 均す**。
 * 出口はどちらも畳んだ値だけ持つ（書き出し先のことは測っていない）。
 *
 * 素材は `limit-signal.mjs` と同じ波に、クリップごとの倍率を掛けたもの
 * （揃える相手が無いと `clip-match` が何もしないので、わざと 12dB ばらけさせてある）。
 */

const [, , countArg, secondsArg, mode, blockArg, chArg] = process.argv;

const { measureLoudness, measureLoudnessStream, planLoudnessNormalization } = await import('./src/lufs.ts');
const { limitTruePeak, limitTruePeakStream } = await import('./src/limiter.ts');
const {
  measureClips,
  measureClipsStream,
  planClipMatch,
  applyClipGains,
  applyClipGainSources,
  concatSources,
  gainSource,
} = await import('./src/clip-match.ts');
const { generatedSource, materialize, foldHash } = await import('./limit-signal.mjs');

const count = Number(countArg);
const seconds = Number(secondsArg);
const channels = Number(chArg ?? 1);
const blockSeconds = Number(blockArg ?? 5);
const at0 = { max: process.resourceUsage().maxRSS * 1024 };

/** クリップごとの大きさの差。12dB ぶんを 4 段で回す（揃える仕事を実際に作るため）。 */
const ampOf = (i) => [1, 0.5, 0.25, 0.7][i % 4];

/** 丸ごと起こしたクリップ 1 本。 */
const clipBuffer = (i) => {
  const b = materialize(seconds, { channels });
  const amp = ampOf(i);
  for (let c = 0; c < channels; c += 1) {
    const a = b.getChannelData(c);
    for (let k = 0; k < a.length; k += 1) a[k] *= amp;
  }
  return b;
};

/**
 * 流すクリップ 1 本。`generatedSource` は読むたびに新しい列を返すので、
 * ここだけはその場で掛けてよい（`gainSource` が写すのは `blockSourceOf` の上に
 * 置かれたときに元を壊さないため。ここは元が無い）。
 */
const clipSource = (i) => {
  const base = generatedSource(seconds, { channels });
  const amp = ampOf(i);
  return {
    sampleRate: base.sampleRate,
    numberOfChannels: base.numberOfChannels,
    length: base.length,
    read(from, to) {
      const got = base.read(from, to);
      for (const a of got) for (let k = 0; k < a.length; k += 1) a[k] *= amp;
      return got;
    },
  };
};

/** 丸ごと起こした列を端から繋ぐ（一括の「繋ぐ」段）。 */
const joinBuffers = (buffers) => {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const planes = [];
  for (let c = 0; c < channels; c += 1) {
    const out = new Float32Array(total);
    let k = 0;
    for (const b of buffers) {
      out.set(b.getChannelData(c), k);
      k += b.length;
    }
    planes.push(out);
  }
  return { sampleRate: 48000, numberOfChannels: channels, length: total, getChannelData: (c) => planes[c] };
};

const hashOf = (fn) => {
  const hashes = new Array(channels).fill(2166136261);
  fn((blocks) => {
    for (let c = 0; c < blocks.length; c += 1) hashes[c] = foldHash(hashes[c], blocks[c]);
  });
  return hashes;
};

let out = null;
let ms = 0;
let reads = 0;

/** `read` の呼ばれ方を数える（道すじが素材を何周読むか）。 */
const counted = (source) => ({
  sampleRate: source.sampleRate,
  numberOfChannels: source.numberOfChannels,
  length: source.length,
  read(from, to) {
    reads += to - from;
    return source.read(from, to);
  },
});

if (mode === 'none') {
  out = {};
} else if (mode === 'measure-whole') {
  const clips = [];
  for (let i = 0; i < count; i += 1) clips.push({ id: `c${i}`, buffer: clipBuffer(i) });
  const t0 = performance.now();
  const measured = measureClips(clips, {});
  const plan = planClipMatch(measured, {});
  ms = performance.now() - t0;
  out = { ref: plan.referenceLufs, spreadBefore: plan.spreadBefore, spreadAfter: plan.spreadAfter };
} else if (mode === 'measure-stream') {
  const clips = [];
  for (let i = 0; i < count; i += 1) clips.push({ id: `c${i}`, source: clipSource(i) });
  const t0 = performance.now();
  const measured = measureClipsStream(clips, { blockSeconds });
  const plan = planClipMatch(measured, {});
  ms = performance.now() - t0;
  out = { ref: plan.referenceLufs, spreadBefore: plan.spreadBefore, spreadAfter: plan.spreadAfter };
} else if (mode === 'chain-whole') {
  const clips = [];
  for (let i = 0; i < count; i += 1) clips.push({ id: `c${i}`, buffer: clipBuffer(i) });
  const t0 = performance.now();
  const plan = planClipMatch(measureClips(clips, {}), {});
  const timeline = joinBuffers(applyClipGains(clips, plan));
  const m = measureLoudness(timeline, {});
  const norm = planLoudnessNormalization(m, { limiterHeadroomDb: 12 });
  const scaled = {
    sampleRate: timeline.sampleRate,
    numberOfChannels: channels,
    length: timeline.length,
    getChannelData: (c) => {
      const src = timeline.getChannelData(c);
      const a = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 1) a[i] = src[i] * norm.gain;
      return a;
    },
  };
  const r = limitTruePeak(scaled, { maxReductionDb: 12 });
  ms = performance.now() - t0;
  const hashes = new Array(channels).fill(2166136261);
  for (let c = 0; c < channels; c += 1) hashes[c] = foldHash(hashes[c], r.buffer.getChannelData(c));
  out = { ref: plan.referenceLufs, lufs: m.integratedLufs, gainDb: norm.gainDb, tpAfter: r.report.truePeakDb, hashes };
} else if (mode === 'chain-stream') {
  const t0 = performance.now();
  // 1 周め: クリップごとに測る。
  const first = [];
  for (let i = 0; i < count; i += 1) first.push({ id: `c${i}`, source: counted(clipSource(i)) });
  const plan = planClipMatch(measureClipsStream(first, { blockSeconds }), {});
  // 2 周め: 倍率を当てて繋いだタイムラインを測る。**ここが丸ごと 1 周ぶん増える。**
  const second = [];
  for (let i = 0; i < count; i += 1) second.push({ id: `c${i}`, source: counted(clipSource(i)) });
  const m = measureLoudnessStream(concatSources(applyClipGainSources(second, plan)), { blockSeconds });
  const norm = planLoudnessNormalization(m, { limiterHeadroomDb: 12 });
  // 3 周め: 全体の倍率を掛けながらリミッタへ流す。
  const third = [];
  for (let i = 0; i < count; i += 1) third.push({ id: `c${i}`, source: counted(clipSource(i)) });
  const timeline = gainSource(concatSources(applyClipGainSources(third, plan)), norm.gain);
  let report = null;
  const hashes = hashOf((fold) => {
    report = limitTruePeakStream(timeline, (blocks) => fold(blocks), { blockSeconds, maxReductionDb: 12 });
  });
  ms = performance.now() - t0;
  out = {
    ref: plan.referenceLufs,
    lufs: m.integratedLufs,
    gainDb: norm.gainDb,
    tpAfter: report.truePeakDb,
    hashes,
    // 素材ぜんたいを何周読んだか（標本の数 ÷ 素材の標本の数）。
    passes: reads / (count * Math.round(seconds * 48000) * channels),
  };
} else {
  throw new Error(`知らない形です: ${mode}`);
}

console.log(
  JSON.stringify({
    mode,
    count,
    seconds,
    channels,
    blockSeconds,
    peak: process.resourceUsage().maxRSS * 1024,
    floor: at0.max,
    ms: Math.round(ms),
    out,
  }),
);
