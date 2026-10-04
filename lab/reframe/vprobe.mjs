/**
 * 「どの手なら**被写体が縦のどこに居るか**を指せるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:reframe:vprobe
 *
 * 横の軸（`probe.mjs`）とまったく同じ表を、**畳む向きだけ替えて**出す。
 * 同じ形にしてあるのは、**どこが鏡像でどこが鏡像でないかを並べて読む**ため——
 * 「縦でも同じ手が勝ちました」で済むのか、そうでないのかが先に分かっていないと、
 * 横の答えをそのまま縦へ持ってきてしまう。
 *
 * 向きは `native`（最初から縦で撮った 9:16）。切り出しの縦型（`portrait`）ではないのは、
 * **1:1 を切るときに余るのが縦なのは、もともと縦で撮った素材のほう**だから。
 * 窓の高さは 9/16 ＝ 0.5625（受け皿の幅がそのまま 1:1 の 1 辺になる）。
 */

import { REFRAME_V_FIXTURES, SCENE_FIXTURES, leadSubjectAt } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';

const {
  backgroundOdds,
  contrast,
  diffLuma,
  diffRgb,
  diffShifted,
  readCentroid,
  readPeak,
  keepBand,
  spatialOdds,
  summarizeAllRows,
  trendOdds,
} = await import('./src/columns.ts');

function normalize(w) {
  let max = 0;
  for (let c = 0; c < w.length; c += 1) if (w[c] > max) max = w[c];
  if (max <= 0) return w;
  const out = new Float64Array(w.length);
  for (let c = 0; c < w.length; c += 1) out[c] = w[c] / max;
  return out;
}

/** 1:1 の窓の高さ（画面の何割か）。9:16 の受け皿から 1 辺＝幅ぶんを切るので 9/16。 */
const CROP_V = 9 / 16;
const HALF = CROP_V / 2;
const ASPECT = 'native';
/** 軸の上で探してよい範囲。横の `rowBand` と同じ 0.15。 */
const CAPTION_BAND = { from: 0.15, to: 0.85 };

const CUES = {
  diff: (rows) => (i) => diffLuma(rows, i),
  diffRgb: (rows) => (i) => diffRgb(rows, i),
  diffShift: (rows) => (i) => diffShifted(rows, i),
  bg: (rows) => backgroundOdds(rows),
  spatial: (rows) => (i) => spatialOdds(rows, i),
  // **階調を外してから浮いている帯を探す**（縦の軸で足した。上の注を参照）。
  trend: (rows) => (i) => trendOdds(rows, i),
  // **字幕の帯を締め出してから**読む。横の軸で `rowBand` が上下 15% を落としているのと
  // 同じ仮定（「字幕は上下にある」）を、縦の軸では畳んだあとに当てる形。
  // **2 つを 1 つずつ外した列を並べてある**——どちらが効いたのかは、
  // 片方だけの行が無いと読めない（実際、片方だけではどちらも足りなかった）。
  'trend+band': (rows) => (i) => keepBand(trendOdds(rows, i), CAPTION_BAND),
  'spatial+band': (rows) => (i) => keepBand(spatialOdds(rows, i), CAPTION_BAND),
  either: (rows) => {
    const bg = backgroundOdds(rows);
    return (i) => {
      const a = normalize(bg(i));
      const b = normalize(spatialOdds(rows, i));
      const w = new Float64Array(a.length);
      for (let c = 0; c < a.length; c += 1) w[c] = Math.max(a[c], b[c]);
      return w;
    };
  },
  both: (rows) => {
    const bg = backgroundOdds(rows);
    return (i) => {
      const a = bg(i);
      const b = spatialOdds(rows, i);
      const w = new Float64Array(a.length);
      for (let c = 0; c < a.length; c += 1) w[c] = a[c] * b[c];
      return w;
    };
  },
};

const READS = { centroid: readCentroid, peak: readPeak };

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

function measure(fixture) {
  const clip = renderFixture(fixture.name, { aspect: ASPECT });
  const rows = summarizeAllRows(clip.frames, clip.times);
  const out = {};
  for (const [cueName, build] of Object.entries(CUES)) {
    const weightsAt = build(rows);
    for (const [readName, read] of Object.entries(READS)) {
      const errors = [];
      const sharp = [];
      let inside = 0;
      let counted = 0;
      for (let i = 1; i < rows.length; i += 1) {
        const truth = leadSubjectAt(fixture, clip.times[i], ASPECT);
        if (truth && (truth.v < 0 || truth.v > 1)) continue;
        const w = weightsAt(i);
        const v = read(w);
        sharp.push(contrast(w));
        if (!truth) continue;
        counted += 1;
        if (Number.isNaN(v)) continue;
        const err = Math.abs(v - truth.v);
        errors.push(err);
        if (err < HALF) inside += 1;
      }
      out[`${cueName}/${readName}`] = {
        error: median(errors),
        inside: counted ? (inside / counted) * 100 : null,
        contrast: median(sharp),
      };
    }
  }
  return out;
}

const withSubject = REFRAME_V_FIXTURES.filter((f) => leadSubjectAt(f, 6.5, ASPECT));
// 泳ぎを見る相手は、縦の軸をいちばん強く揺らすもの（カメラが縦に流れる・字幕が書き換わる）。
const without = SCENE_FIXTURES.filter((f) => !leadSubjectAt(f, 6.5, ASPECT));

const keys = Object.keys(CUES).flatMap((c) => Object.keys(READS).map((r) => `${c}/${r}`));

console.log('被写体を指せるか（正解と突き合わせ・最初から縦 9:16 ・ 15fps ・ 窓の高さ 0.5625）\n');
console.log('ずれの中央値（画面の高さに対する割合。0.281 を超えると枠から出る）\n');
console.log(`${pad('素材', 22)}${keys.map((k) => right(k, 16)).join('')}`);
console.log('-'.repeat(22 + keys.length * 16));

const rows = [];
for (const f of withSubject) {
  const m = measure(f);
  rows.push({ f, m });
  console.log(
    `${pad(f.name, 22)}${keys.map((k) => right(Number.isNaN(m[k].error) ? '—' : m[k].error.toFixed(3), 16)).join('')}`,
  );
}
console.log('-'.repeat(22 + keys.length * 16));
console.log(
  `${pad('  中央値', 22)}` +
    keys.map((k) => right(median(rows.map((r) => r.m[k].error).filter((v) => !Number.isNaN(v))).toFixed(3), 16)).join(''),
);

console.log('\n\n枠に入る率（その位置をそのまま枠の中心にしたとき、被写体の中心が枠に収まる割合）\n');
console.log(`${pad('素材', 22)}${keys.map((k) => right(k, 16)).join('')}`);
console.log('-'.repeat(22 + keys.length * 16));
for (const { f, m } of rows) {
  console.log(`${pad(f.name, 22)}${keys.map((k) => right(`${m[k].inside.toFixed(1)}%`, 16)).join('')}`);
}
console.log('-'.repeat(22 + keys.length * 16));
console.log(
  `${pad('  ぜんぶ', 22)}` +
    keys.map((k) => right(`${(rows.reduce((s, r) => s + r.m[k].inside, 0) / rows.length).toFixed(1)}%`, 16)).join(''),
);

console.log('\n\n尖り（いちばん強い帯 − 真ん中の帯）の中央値。被写体が居るときと居ないときで分かれるか\n');
console.log(`${pad('素材', 22)}${keys.map((k) => right(k, 16)).join('')}`);
console.log('-'.repeat(22 + keys.length * 16));
for (const { f, m } of rows) {
  console.log(`${pad('◎ ' + f.name, 22)}${keys.map((k) => right(m[k].contrast.toFixed(4), 16)).join('')}`);
}
const noneRows = [];
for (const f of without) {
  const m = measure(f);
  noneRows.push({ f, m });
  console.log(`${pad('× ' + f.name, 22)}${keys.map((k) => right(m[k].contrast.toFixed(4), 16)).join('')}`);
}
console.log('-'.repeat(22 + keys.length * 16));
console.log(
  `${pad('  ◎ の最小', 22)}` + keys.map((k) => right(Math.min(...rows.map((r) => r.m[k].contrast)).toFixed(4), 16)).join(''),
);
console.log(
  `${pad('  × の最大', 22)}` +
    keys.map((k) => right(Math.max(...noneRows.map((r) => r.m[k].contrast)).toFixed(4), 16)).join(''),
);
