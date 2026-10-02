/**
 * リミッタのメモリの山を、**別のプロセスで**測る。
 *
 *   node lab/auto-cut/limit-mem.mjs <秒> <whole|stream> [区間の秒] [ch]
 *
 * 同じプロセスの中で前後を引く形では測れない（V8 は一度伸ばした領域を返さない）。
 * `project-pack/mem-probe.mjs` と同じ理由・同じ作り: 子の `ru_maxrss` は fork した時点の
 * 親の常駐量を引き継ぐので、**走り出しの値を子自身が報告して、それを引く。**
 *
 * `whole` は素材を丸ごと起こしてから `limitTruePeak` に通す（＝これまでの形）。
 * `stream` は `generatedSource` をそのまま流す（**標本の列をどこにも持たない**）。
 * 出口はどちらも捨てる（書き出し先のことは測っていない）。
 */

const [, , secondsArg, mode, blockArg, chArg] = process.argv;
const { limitTruePeak, limitTruePeakStream } = await import('./src/limiter.ts');
const { generatedSource, materialize, foldHash } = await import('./limit-signal.mjs');

const seconds = Number(secondsArg);
const channels = Number(chArg ?? 1);
const blockSeconds = Number(blockArg ?? 5);
const at0 = { max: process.resourceUsage().maxRSS * 1024 };

let report;
// **チャンネルごとに別の数へ畳む。** 1 つに混ぜると、一括（ch ごとに通す）と
// 流す形（区間ごとに ch を回す）で足す順が違うので、同じ波でも値が違ってしまう
// （一度それで「ちがう」と出た）。
const hashes = new Array(channels).fill(2166136261);
let ms;
if (mode === 'none') {
  // 床を測るためだけの空回し（モジュールを読む手間までは同じ）。
  report = { maxReductionDb: 0, activeSeconds: 0, meanReductionDb: 0, truePeakDb: 0, clamped: false };
  ms = 0;
} else if (mode === 'whole') {
  const buffer = materialize(seconds, { channels });
  const t0 = performance.now();
  const r = limitTruePeak(buffer);
  ms = performance.now() - t0;
  report = r.report;
  for (let c = 0; c < channels; c += 1) hashes[c] = foldHash(hashes[c], r.buffer.getChannelData(c));
} else {
  const source = generatedSource(seconds, { channels });
  const t0 = performance.now();
  report = limitTruePeakStream(source, (blocks) => {
    for (let c = 0; c < blocks.length; c += 1) hashes[c] = foldHash(hashes[c], blocks[c]);
  }, { blockSeconds });
  ms = performance.now() - t0;
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
    hashes,
    report: {
      maxReductionDb: Number(report.maxReductionDb.toFixed(6)),
      activeSeconds: Number(report.activeSeconds.toFixed(6)),
      meanReductionDb: Number(report.meanReductionDb.toFixed(6)),
      truePeakDb: Number(report.truePeakDb.toFixed(6)),
      clamped: report.clamped,
    },
  }),
);
