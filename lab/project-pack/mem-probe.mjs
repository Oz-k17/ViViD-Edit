/**
 * メモリの山を、**別のプロセスで**測る。
 *
 *   node lab/project-pack/mem-probe.mjs <構成の番号> <baseline|json|pack>
 *
 * 同じプロセスの中で `rss` の前後を引くやり方では測れない。
 * V8 は一度伸ばした領域を返さないので、先に大きい文字列を作っていると
 * 次の測りは差が 0 に見える（実際 1 度そう出た）。
 *
 * **ただし子プロセスに分けても安全ではない。** Linux の `ru_maxrss` は fork した時点の
 * 親の常駐量を引き継ぐので、親が 600MB 抱えていると子の山も 600MB から始まる
 * （測って確かめた。親 600MB のとき、何もしない子も base64 を作る子も同じ 618MB を返した）。
 * なので**走り出しの値を子自身が報告して、それを引く**。
 * `memoryUsage().rss` の方は引き継がない（どちらも測って確かめた）。
 */

const [, , indexArg, mode] = process.argv;
const { layoutPack, realizePack } = await import('./src/container.ts');
const { buildJsonPack } = await import('./src/json-pack.ts');
const { memoryBodies, scenarioAt } = await import('./src/scenarios.ts');

const at0 = { max: process.resourceUsage().maxRSS * 1024, rss: process.memoryUsage().rss };
const s = scenarioAt(Number(indexArg));
const bodies = memoryBodies(s.bodies);
const toBase64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

// 素材を用意しただけの山（これを引き算して、やり方そのものの費用を出す）。
let held;
if (mode === 'json') {
  held = (await buildJsonPack(s.project, s.assets, bodies, toBase64)).text;
} else if (mode === 'pack') {
  const layout = layoutPack(s.project, s.assets, bodies);
  held = await realizePack(layout, bodies);
}

// 捨てられないように触っておく（触らないと最適化で消える余地を残す）。
const keep = mode === 'json' ? held.length : mode === 'pack' ? held.length : s.bodies.size;
console.log(
  JSON.stringify({
    // 引き継いだ床を引いた「このプロセス自身が積んだ山」。
    peak: process.resourceUsage().maxRSS * 1024 - at0.max,
    alive: process.memoryUsage().rss - at0.rss,
    floor: at0.max,
    keep,
  }),
);
