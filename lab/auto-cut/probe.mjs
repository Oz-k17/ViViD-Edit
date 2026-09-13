/**
 * 「どの特徴量なら声とそれ以外を分けられるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:fixtures
 *   npm run lab:probe
 *
 * 思いつきで 1 つ選んで実装すると、たまたま手元の素材で効いただけのものを掴む。
 * 先にここで並べて比べてから決める。
 *
 * 出す数字は AUC（0.5 = まったく分けられない、1.0 = 完全に分けられる）。
 * しきい値をどこに置くかに依存しないので、特徴量そのものの素性が見える。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';
import { isSpeechAt, SHORT_FIXTURES } from '../fixtures/spec.mjs';

const { analyzeLoudness } = await import('./src/loudness.ts');
const { analyzeFeatures, FEATURE_NAMES } = await import('./src/features.ts');
const { autoThresholdDb, DEFAULT_JET_CUT } = await import('./src/silence.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'lab/fixtures/out');
if (!fs.existsSync(out)) {
  console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
  process.exit(1);
}

/**
 * AUC（ROC 曲線の下の面積）を順位から求める。
 * 「声のコマからひとつ、それ以外からひとつ選んだとき、
 *   声のほうが値が大きい確率」と読める。
 */
function auc(positive, negative) {
  if (positive.length === 0 || negative.length === 0) return null;
  const all = [...positive.map((v) => [v, 1]), ...negative.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  // 同点は順位を平均する。
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (all[k][1] === 1) rankSum += rank;
    i = j + 1;
  }
  const n1 = positive.length;
  const n0 = negative.length;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/** 重心の下降率で門を置くとしたらどこか（下の段で使う。勘で置かず表を見て決め直せるように定数にしておく）。 */
const DESCENT_GATE = 0.65;
/** 「高い帯域だけが動いた割合」で門を置くとしたらどこか。同じく表を見て決め直せるように。 */
const HIGH_ALONE_GATE = 0.5;

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, n) => (v === null ? pad('—', n) : String(v.toFixed(3)).padStart(n, ' '));

console.log('声のコマとそれ以外のコマを、どれくらい分けられるか（AUC / 0.5 = 分けられない）\n');
console.log(`${pad('素材', 22)}${FEATURE_NAMES.map((f) => num(null, 0) && pad(f, 12)).join('')}`);
console.log('-'.repeat(22 + FEATURE_NAMES.length * 12));

const totals = new Map(FEATURE_NAMES.map((f) => [f, []]));

for (const fixture of SHORT_FIXTURES) {
  const file = path.join(out, fixture.name);
  if (!fs.existsSync(file)) continue;
  const buffer = readWav(file);
  const track = analyzeLoudness(buffer, 0.02);
  const features = analyzeFeatures(buffer, track);

  // 正解のラベルを付ける。境目のコマは、どちらとも言えないので外す。
  const positive = new Map(FEATURE_NAMES.map((f) => [f, []]));
  const negative = new Map(FEATURE_NAMES.map((f) => [f, []]));
  for (let i = 0; i < track.db.length; i += 1) {
    const t = i * track.hop;
    const speech = isSpeechAt(fixture, t);
    const nearEdge = isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15);
    if (nearEdge) continue;
    for (const name of FEATURE_NAMES) {
      (speech ? positive : negative).get(name).push(features[name][i]);
    }
  }

  const row = FEATURE_NAMES.map((name) => {
    const value = auc(positive.get(name), negative.get(name));
    if (value !== null) totals.get(name).push(value);
    return pad(num(value, 6), 12);
  }).join('');
  console.log(`${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 22)}${row}`);
}

console.log('-'.repeat(22 + FEATURE_NAMES.length * 12));
const average = FEATURE_NAMES.map((name) => {
  const values = totals.get(name);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return pad(num(mean, 6), 12);
}).join('');
console.log(`${pad('  平均', 22)}${average}`);

// --- しきい値も勘で決めない ---
// 声のコマを取りこぼす率と、それ以外を拾ってしまう率の釣り合いが
// いちばん良くなるところを、全素材をまたいで探す。
{
  const samples = { positive: [], negative: [] };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    for (let i = 0; i < track.db.length; i += 1) {
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      // 音量で明らかに落ちるコマ（無音）は、声らしさを見るまでもないので外す。
      if (features.level[i] < -70) continue;
      (isSpeechAt(fixture, t) ? samples.positive : samples.negative).push(features.speechScore[i]);
    }
  }

  let best = { threshold: 0, score: -1, hit: 0, falseAlarm: 0 };
  for (let th = 0; th <= 0.6; th += 0.005) {
    const hit = samples.positive.filter((v) => v >= th).length / Math.max(1, samples.positive.length);
    const falseAlarm = samples.negative.filter((v) => v >= th).length / Math.max(1, samples.negative.length);
    const balanced = (hit + (1 - falseAlarm)) / 2;
    if (balanced > best.score) best = { threshold: th, score: balanced, hit, falseAlarm };
  }
  console.log(
    `\nspeechScore のしきい値を全素材で探した結果: ${best.threshold.toFixed(3)}` +
      `（声を拾えた率 ${(best.hit * 100).toFixed(0)}% / 声でないのに拾った率 ${(best.falseAlarm * 100).toFixed(0)}%）`,
  );
  console.log(`対象コマ: 声 ${samples.positive.length} / それ以外 ${samples.negative.length}（無音は除外）`);
}

// --- 声の無い素材は AUC では測れない ---
// AUC は「声のコマ」と「それ以外のコマ」を比べる指標なので、声が 1 つも無い素材は
// 上の表では — になる。**守りたいのはまさにそこ**（音楽だけの素材を切り刻まないこと）
// なので、別の見方で並べる。声らしさをそのまま信じるとどれだけ誤るか、と、
// 形の動きでそれを弾けるか。
{
  console.log('\n声の無い素材で、どれだけ誤って「声だ」と言うか\n');
  console.log(`${pad('素材', 22)}${pad('声らしいコマの割合', 20)}${pad('形が動いた秒数', 16)}${pad('包絡が動いた秒数', 18)}`);
  console.log('-'.repeat(76));
  for (const fixture of SHORT_FIXTURES) {
    if (fixture.speech) continue;
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    const threshold = autoThresholdDb(track, 0.25);
    let sounding = 0;
    let speechLike = 0;
    let moving = 0;
    let envMoving = 0;
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      sounding += 1;
      if (features.speechScore[i] >= 0.2) speechLike += 1;
      if (features.shapeChange[i] >= 0.09) moving += 1;
      // 2026-09-11 の 3 回目からは、これがそのままコマ単位の門になっている。
      // ここで手打ちにすると判定とずれるので、判定側の既定値をそのまま使う。
      if (features.envelopeChange[i] >= DEFAULT_JET_CUT.minEnvelopeChange) envMoving += 1;
    }
    const ratio = sounding > 0 ? speechLike / sounding : 0;
    console.log(
      `${pad('※ ' + fixture.name, 22)}${pad(`${(ratio * 100).toFixed(0)}%`, 20)}${pad(`${(moving * track.hop).toFixed(2)} 秒`, 16)}${pad(`${(envMoving * track.hop).toFixed(2)} 秒`, 18)}`,
    );
  }
  console.log('割合が高いのに形が動かない素材は、声らしさだけでは弾けない（震える楽器がそれ）。');
}

// --- AUC では見えない比べ方 ---
// 上の AUC は「声のコマ」と「それ以外のコマ（無音を含む）」を比べている。
// ところが無音のコマは、乾いた素材ではほぼ雑音なので、形も包絡も毎コマ暴れる。
// そのせいで「声かどうか」ではなく「鳴っているかどうか」を測ってしまい、
// 形や包絡の良し悪しがまったく見えない（乾いた素材の AUC は shapeFlux 0.189 /
// envelopeFlux 0.289。0.5 を下回る＝声のほうが小さい、という意味になってしまう）。
//
// 判定が本当に見たいのは「鳴っているコマの中で、声と音楽を分けられるか」なので、
// そちらを直に並べる。
{
  console.log('\n鳴っているコマだけで、声と音楽を直に比べる（中央値）\n');
  console.log(`${pad('素材', 24)}${pad('区分', 6)}${pad('shapeChange', 14)}${pad('envelopeChange', 14)}`);
  console.log('-'.repeat(58));
  const median = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: { shape: [], env: [] }, 他: { shape: [], env: [] } };
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      // 境目のコマはどちらとも言えないので外す（上の AUC と同じ扱い）。
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      const group = groups[isSpeechAt(fixture, t) ? '声' : '他'];
      group.shape.push(features.shapeChange[i]);
      group.env.push(features.envelopeChange[i]);
    }
    for (const [label, group] of Object.entries(groups)) {
      if (group.shape.length === 0) continue;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(label, 6)}` +
          `${pad(num(median(group.shape), 6), 14)}${pad(num(median(group.env), 6), 14)}`,
      );
    }
  }
  console.log('\n「乾いた声」と「震える楽器」を見比べること。');
  console.log('形では 3.8 倍しか開かない（0.188 と 0.050）が、包絡なら 30 倍開く（0.270 と 0.009）。');
  console.log('ただし ※ speech-sustained（母音を伸ばす声）は 0.037 まで落ちる。');
  console.log('本物の声にある性質なので、門だけを置くとここで声を切る。');
  console.log('（2026-09-11 の 3 回目に 0.5 秒の保持を足して、ここは戻した）');
  console.log('music-wah（フォルマントが動く楽器）と music-chords-fast / faster（和音が速く変わる音楽）は、');
  console.log('声がゼロなのに包絡が動く。門を置いても、この 3 本は通り抜ける。');
  console.log('とくに music-chords-faster（0.2 秒ごとに和音）は shapeChange の中央値が 0.093 で、');
  console.log('しきい値 0.09 をすでに上回っている。素材単位の形の判定も、ここは支えられない。');
}

// --- 子音の痕跡（広帯域の雑音の粒）を測る ---
// 2026-09-12 の 2 回目に `speak()` へ子音と息を足したので、ここを初めて測れるようになった。
// 上の AUC の表では `zcr` が 0.000〜0.007 と出るが、あれは「声のコマ」を
// **無音のコマと**比べているせい（乾いた素材の無音はほぼ雑音なので zcr が最も高い）。
// 判定が見たいのは「鳴っているコマの中で、声と音楽を分けられるか」なので、そちらを出す。
//
// 子音は音節の 1〜3 割しか占めないので、**中央値では出ない**。
// 「その素材に雑音の粒が混じっているか」を見るには上側の分位が要る。
{
  console.log('\n鳴っているコマの zcr と flux（子音は少数なので、中央値ではなく上位 10% を見る）\n');
  console.log(
    `${pad('素材', 24)}${pad('区分', 6)}${pad('zcr 中央', 11)}${pad('zcr 上位10%', 13)}` +
      `${pad('flux 中央', 11)}${pad('flux 上位10%', 13)}${pad('平坦さ 上位10%', 15)}`,
  );
  console.log('-'.repeat(93));
  const quantile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: { zcr: [], flux: [], flat: [] }, 他: { zcr: [], flux: [], flat: [] } };
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      const group = groups[isSpeechAt(fixture, t) ? '声' : '他'];
      group.zcr.push(features.zcr[i]);
      group.flux.push(features.flux[i]);
      group.flat.push(features.flatness[i]);
    }
    for (const [label, group] of Object.entries(groups)) {
      if (group.zcr.length === 0) continue;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(label, 6)}` +
          `${pad(num(quantile(group.zcr, 0.5), 6), 11)}${pad(num(quantile(group.zcr, 0.9), 6), 13)}` +
          `${pad(num(quantile(group.flux, 0.5), 6), 11)}${pad(num(quantile(group.flux, 0.9), 6), 13)}` +
          `${pad(num(quantile(group.flat, 0.9), 6), 15)}`,
      );
    }
  }
  console.log('\n※ speech-vowels-only（子音も息も無い声）を必ず併せて見ること。');
  console.log('ここで声と音楽が分かれても、その素材が音楽の側に落ちるなら、');
  console.log('その手がかりは「声があるか」ではなく「子音があるか」を見ているだけ。');
}

// --- 「音程のある粒と雑音の粒が隣り合っているか」 ---
// 上の分位で分かるのは「雑音の粒があるか」だけで、それだけなら打楽器にも雑音はある。
// 声に固有なのは **2 種類の粒が短い間に混じること**（子音の雑音 → 母音の音程）で、
// 正弦波を足して作った楽器（和音・wah・トレモロ）には音程の粒しか無く、
// 打楽器には雑音の粒しか無い。これが、子音を足して初めて測れるようになった手がかり。
{
  console.log('\n短い窓（0.3 秒）の中に「雑音の粒」と「音程の粒」が両方あるか\n');
  console.log(`${pad('素材', 24)}${pad('声', 6)}${pad('雑音の粒', 11)}${pad('音程の粒', 11)}${pad('両方あった秒数', 16)}`);
  console.log('-'.repeat(68));
  // しきい値は勘で置かず、下の表を見て決め直せるように定数として出しておく。
  const NOISY_FLATNESS = 0.18;
  const TONAL_HARMONICITY = 0.3;
  const WINDOW_SECONDS = 0.3;
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    const threshold = autoThresholdDb(track, 0.25);
    const noisy = [];
    const tonal = [];
    for (let i = 0; i < track.db.length; i += 1) {
      const sounding = track.db[i] > threshold;
      noisy.push(sounding && features.flatness[i] >= NOISY_FLATNESS);
      tonal.push(sounding && features.harmonicity[i] >= TONAL_HARMONICITY);
    }
    const half = Math.round(WINDOW_SECONDS / 2 / track.hop);
    let both = 0;
    for (let i = 0; i < noisy.length; i += 1) {
      let n = false;
      let t = false;
      for (let k = -half; k <= half; k += 1) {
        const j = i + k;
        if (j < 0 || j >= noisy.length) continue;
        if (noisy[j]) n = true;
        if (tonal[j]) t = true;
      }
      if (n && t) both += 1;
    }
    const count = (list) => list.filter(Boolean).length * track.hop;
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(fixture.speech ? 'あり' : 'なし', 6)}` +
        `${pad(`${count(noisy).toFixed(2)} 秒`, 11)}${pad(`${count(tonal).toFixed(2)} 秒`, 11)}` +
        `${pad(`${(both * track.hop).toFixed(2)} 秒`, 16)}`,
    );
  }
  console.log(`\n判定に使ったしきい値: 平坦さ >= ${NOISY_FLATNESS} / 倍音らしさ >= ${TONAL_HARMONICITY}`);
}

// --- 打点の減衰と、口の動きを分ける ---
// 2026-09-13 の 1 回目に、`envelopeChange`（包絡の動き）が「口が動いたか」ではなく
// **打点の減衰にも同じだけ反応する**ことが分かった（`music-hats` で 1.44 → 12.98 秒）。
// そのとき記録に書いた見立てが「違いは動き方の**向き**にあるはず」。
// 打点は立ち上がりで重心が一気に上がり、減衰のあいだ単調に下がり続ける。
// 口の動きは向きがばらばらなので、下がった歩みと上がった歩みがほぼ半々になる。
//
// 0.3 秒の窓で「重心が下がった歩み」の割合を数えて、そこを直に見る。
// **見るのは中央値だけでは足りない。** 門にするなら「声のコマが何割ひっかかるか」が要る。
{
  console.log('\n重心が下がり続けている割合（0.3 秒の窓。打点の減衰なら高い）\n');
  console.log(
    `${pad('素材', 24)}${pad('区分', 6)}${pad('中央', 8)}${pad('下位10%', 10)}${pad('上位10%', 10)}` +
      `${pad(`${DESCENT_GATE} 超えのコマ`, 16)}`,
  );
  console.log('-'.repeat(74));
  const quantile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: [], 他: [] };
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      groups[isSpeechAt(fixture, t) ? '声' : '他'].push(features.centroidDescent[i]);
    }
    for (const [label, values] of Object.entries(groups)) {
      if (values.length < 5) continue;
      const over = values.filter((v) => v >= DESCENT_GATE).length / values.length;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(label, 6)}` +
          `${pad(num(quantile(values, 0.5), 6), 8)}${pad(num(quantile(values, 0.1), 6), 10)}` +
          `${pad(num(quantile(values, 0.9), 6), 10)}${pad(`${(over * 100).toFixed(0)}%`, 16)}`,
      );
    }
  }
  console.log(`\n門にするなら ${DESCENT_GATE} のあたり（music-hats の下位 10% と、素の声の上位 10% の間）。`);
  console.log('**それでも判定には入れなかった**（2026-09-13・2 回目に測って捨てた）。');
  console.log('music-hats 97% に対し、同じハイハットの上でしゃべる speech-hats は 29% まで落ちるので、');
  console.log('「ハイハットがあるか」を見ているだけではない。ところが下の 2 本で破れる:');
  console.log('  ※ speech-vowels-hats（子音も息も無い声＋ハイハット）… 声のコマの 83% が超える');
  console.log('  ※ speech-sparse-hats（音楽の上でまばらにしゃべる）… 素材全体の 99% が超える');
  console.log('重心はいちばん高い所にある弱い音に引きずられるので、声が高い帯域を覆っていないと');
  console.log('打点の減衰だけが残る。つまりこの量は「口が動いたか」ではなく');
  console.log('「高い帯域が何かで覆われているか」を見ている。');
}


// --- 帯域ごとの時間の形（高い帯域だけが動いていないか） ---
// 2026-09-13 の 2 回目に「重心・平坦さ系は打ち止め」と決めた。どちらも
// **スペクトルを 1 つの数へ潰してから**時間で見る量で、倍音の上に何かあるかしか見ていない。
// 残っていた方向が「潰さずに、どの帯域がどう動いたかを見る」。3 回目にそれを測った。
//
// ハイハットは下の和音を動かさずに高い帯域だけを叩いて減衰する。
// 人がしゃべると音節の切れ目で帯域をまたいで一緒に動く。そこを直に数える。
{
  console.log('\n高い帯域だけが動いた歩みの割合（0.3 秒の窓。打点なら高い）\n');
  console.log(
    `${pad('素材', 26)}${pad('区分', 6)}${pad('中央', 8)}${pad('上位10%', 10)}` +
      `${pad(`${HIGH_ALONE_GATE} 超えのコマ`, 16)}${pad('歩みを数えた率', 16)}`,
  );
  console.log('-'.repeat(82));
  const quantile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: [], 他: [] };
    // 「どちらの帯域も動かなかった」歩みは分母に入れていないので、
    // 値が 0 でも「打点が無い」とは限らない（そもそも何も起きていないだけかもしれない）。
    // その 2 つを取り違えないように、歩みを数えられた割合も並べる。
    // 判定と同じ式なので、features.ts の中身を変えたらここも合わなくなる。
    const bands = features.bandCount;
    const split = features.bandSplit;
    let counted = 0;
    let steps = 0;
    for (let i = 1; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold || track.db[i - 1] <= threshold) continue;
      steps += 1;
      let low = 0;
      for (let b = 0; b < split; b += 1) low += features.bandLog[i * bands + b] - features.bandLog[(i - 1) * bands + b];
      let high = 0;
      for (let b = split; b < bands; b += 1) high += features.bandLog[i * bands + b] - features.bandLog[(i - 1) * bands + b];
      if (Math.abs(low / split) >= 0.1 || Math.abs(high / (bands - split)) >= 0.1) counted += 1;
    }
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      groups[isSpeechAt(fixture, t) ? '声' : '他'].push(features.highBandAlone[i]);
    }
    for (const [label, values] of Object.entries(groups)) {
      if (values.length < 5) continue;
      const over = values.filter((v) => v >= HIGH_ALONE_GATE).length / values.length;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 26)}${pad(label, 6)}` +
          `${pad(num(quantile(values, 0.5), 6), 8)}${pad(num(quantile(values, 0.9), 6), 10)}` +
          `${pad(`${(over * 100).toFixed(0)}%`, 16)}${pad(`${((counted / Math.max(1, steps)) * 100).toFixed(0)}%`, 16)}`,
      );
    }
  }
  console.log('\n**当ては当たった。** music-hats は 72% のコマが門を超えるのに、');
  console.log('同じハイハットの上で子音のある声がしゃべる speech-hats は声のコマの 1% しか超えない。');
  console.log('しかも speech-sparse-hats は素材の**中で** 声 0% 対 他 64% と割れる。');
  console.log('素材単位でしか使えなかった centroidDescent（同じ素材で全体の 99% が超える）とはそこが違う。');
  console.log('\n**それでも判定には入れなかった**（2026-09-13・3 回目に測って捨てた）。');
  console.log('入れると失うものが 1 本あり、その 1 本を守る置き方だと効きが丸ごと消えるため:');
  console.log('  ※ speech-sustained-hats（ハイハットの上で母音を伸ばす声。この日に足した）');
  console.log('    伸ばした母音は低い帯域を動かさないので、声のコマが打点と同じ顔になる');
  console.log('    （中央 0.571 / 61% 超え。music-hats の 0.571 / 72% とほぼ並ぶ）。');
  console.log('  門を 0.5 に置くと music-hats の削減 0% → 35% と引き換えに、この素材の');
  console.log('  声を残せた率が 100% → 73% に落ちる。0.7 まで緩めると効きだけが先に消える');
  console.log('  （music-hats の削減は 0% に戻り、残せた率は 83% までしか戻らない）。');
  console.log('  包絡の門と同じ 0.5 秒の保持を足すと残せた率は 100% に戻るが、');
  console.log('  そのとき speech-sparse-hats の削減が 13% → 0% になり、得たものが残らない。');
  console.log('\n「歩みを数えた率」が低い素材（鳴りっぱなしの音楽）は、値が 0 でも');
  console.log('「打点が無い」ではなく「そもそも何も動いていない」だけ。取り違えないこと。');
}

console.log('\n※ は意地悪な素材（BGM が大きい / 刻む打楽器 / 震える楽器 / 母音を伸ばす声 など）。');
console.log('声の無い素材（bgm・drums・music-tremolo）は「声のコマ」が無いので AUC では測れない（—）。');
console.log('0.5 を下回るのは「逆向きに効いている」という意味で、それはそれで使える。');
