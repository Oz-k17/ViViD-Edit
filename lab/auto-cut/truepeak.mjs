/**
 * **真のピークの打ち直しを速くする**（2026-10-06）。
 *
 *   npm run lab:truepeak
 *   LAB_TP_LONG=600 npm run lab:truepeak   # 長尺のほうも踏む（メモリを食う）
 *
 * 2026-10-02（2 回目）に「打ち直しが測りの時間の 8 割以上を持っている」と測れていて、
 * **省くことはできない**（倍率を決めるのに真のピークが要る）。残っていたのは速くする側だけで、
 * そこが手付かずだったので今回の題材にした。
 *
 * 入れた手は 2 つ。どちらも**値を 1 ビットも動かさない**（検算が素直な形と突き合わせている）。
 *
 *   1. **3 つの位相を 1 本の輪にまとめる**（同じ 12 標本を 3 回読まない）。
 *   2. **山が無いと先に分かる升を、丸ごう飛ばす**（最大だけが要る場面に限る）。
 *
 * 見ているのは 4 つ。
 *
 *   1. 値が素直な形とビット単位で同じか（違えば以後の数字に意味が無い）。
 *   2. 素材ごとの速さと、**飛ばせた升の割合**。
 *   3. **飛ばす手が効かない素材**でも遅くなっていないか（1 の融合だけが残る）。
 *   4. 測りぜんたい（`measureLoudness` / 流す形 / リミッタ）で、打ち直しの取り分がどう動いたか。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';

const {
  measureLoudness,
  measureLoudnessStream,
  truePeakOf,
  truePeakEnvelope,
  truePeakWindowBound,
  applyKWeighting,
  kWeighting,
  ABSOLUTE_GATE_LUFS,
  TP_FILTER,
  TP_TAPS,
  TP_BLOCK,
} = await import('./src/lufs.ts');
const { blockSourceOf } = await import('./src/loudness.ts');
const { limitTruePeak } = await import('./src/limiter.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = path.join(root, 'lab/fixtures/out');
const sr = 48000;

// ---------- 比べる相手（2026-10-06 より前の形）----------
//
// **速い形を正解にしないため**に、タップから素直な形を組み直す。
// 位相ごとに素材をなめ直し、飛ばしもしない。これが 10/05 まで動いていたもの。

function plainTruePeakOf(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (data.length < TP_TAPS) return peak;
  for (let p = 1; p < TP_FILTER.length; p += 1) {
    const taps = TP_FILTER[p];
    for (let i = 0; i + TP_TAPS <= data.length; i += 1) {
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k];
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

function plainTruePeakEnvelope(data) {
  const env = new Float64Array(data.length);
  for (let i = 0; i < data.length; i += 1) env[i] = Math.abs(data[i]);
  if (data.length < TP_TAPS) return env;
  for (let p = 1; p < TP_FILTER.length; p += 1) {
    const taps = TP_FILTER[p];
    const at = TP_TAPS / 2 + Math.round(p / TP_FILTER.length);
    for (let i = 0; i + TP_TAPS <= data.length; i += 1) {
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k];
      const a = Math.abs(acc);
      const j = i + at;
      if (j < env.length && a > env[j]) env[j] = a;
    }
  }
  return env;
}

/**
 * K 特性を通す。`chunk` が 0 なら 2026-10-06 より前の形（塊に割らず、履歴を 0 へ寄せない）。
 *
 * **前と後を別々の関数に書いて測ってはいけない。** 2026-10-06 に実際そうやって、
 * 塊に割ったほうが 1.8 倍遅いという数字を出した。中身を揃えて同じ関数の中で振り直したら
 * **割ったほうが速かった**（48.7 → 29.5ms）。V8 がどちらをどこまで畳むかの差が、
 * 測りたい差（1 割）より大きい。だから 1 つの関数に引数で持たせる。
 */
const FLUSH_FLOOR = 1e-100;
function kFiltered(src, chunk, into) {
  const out = into ?? new Float64Array(src.length);
  out.set(src);
  const len = out.length;
  for (const f of kWeighting(sr)) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let from = 0; from < len; from += chunk === 0 ? len : chunk) {
      if (chunk !== 0 && y1 > -FLUSH_FLOOR && y1 < FLUSH_FLOOR && y2 > -FLUSH_FLOOR && y2 < FLUSH_FLOOR) {
        y1 = 0;
        y2 = 0;
        if (x1 > -FLUSH_FLOOR && x1 < FLUSH_FLOOR) x1 = 0;
        if (x2 > -FLUSH_FLOOR && x2 < FLUSH_FLOOR) x2 = 0;
      }
      const to = chunk === 0 ? len : len < from + chunk ? len : from + chunk;
      for (let i = from; i < to; i += 1) {
        const x = out[i];
        const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = y;
      }
    }
  }
  return out;
}

/** 1 段目（棚）だけを通す。**非正規化数はまずここに出る**（2 段目の出口だけ見ると素通りする）。 */
function shelfOnly(src, chunk) {
  const out = new Float64Array(src.length);
  out.set(src);
  const f = kWeighting(sr)[0];
  const len = out.length;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let from = 0; from < len; from += chunk === 0 ? len : chunk) {
    if (chunk !== 0 && y1 > -FLUSH_FLOOR && y1 < FLUSH_FLOOR && y2 > -FLUSH_FLOOR && y2 < FLUSH_FLOOR) {
      y1 = 0;
      y2 = 0;
    }
    const to = chunk === 0 ? len : len < from + chunk ? len : from + chunk;
    for (let i = from; i < to; i += 1) {
      const x = out[i];
      const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
  }
  return out;
}

/** 升のうち何割を飛ばせるか（実装と同じ升・同じ床で数える）。 */
function skipRate(data) {
  let floor = 0;
  for (let i = 0; i < data.length; i += 1) {
    const a = Math.abs(data[i]);
    if (a > floor) floor = a;
  }
  if (data.length < TP_TAPS) return { rate: 1, blocks: 0 };
  const iTo = data.length - TP_TAPS;
  const hi = data.length - 1;
  let peak = floor;
  let blocks = 0;
  let skipped = 0;
  const minMax = (from, to) => {
    let big = -Infinity;
    let small = Infinity;
    for (let i = from; i <= to; i += 1) {
      const v = data[i];
      if (v > big) big = v;
      if (v < small) small = v;
    }
    return [big, small];
  };
  let [bigPrev, smallPrev] = minMax(0, Math.min(hi, TP_BLOCK - 1));
  for (let s = 0; s <= iTo; s += TP_BLOCK) {
    const next = s + TP_BLOCK;
    const [bigNext, smallNext] = next > hi ? [-Infinity, Infinity] : minMax(next, Math.min(hi, next + TP_BLOCK - 1));
    const big = Math.max(bigPrev, bigNext);
    const small = Math.min(smallPrev, smallNext);
    blocks += 1;
    if (truePeakWindowBound(big, small) * (1 + 2 ** -40) <= peak) skipped += 1;
    else {
      const last = Math.min(next - 1, iTo);
      for (let i = s; i <= last; i += 1) {
        for (let p = 1; p < TP_FILTER.length; p += 1) {
          let acc = 0;
          for (let k = 0; k < TP_TAPS; k += 1) acc += TP_FILTER[p][k] * data[i + k];
          const a = Math.abs(acc);
          if (a > peak) peak = a;
        }
      }
    }
    bigPrev = bigNext;
    smallPrev = smallNext;
  }
  return { rate: blocks === 0 ? 1 : skipped / blocks, blocks };
}

// ---------- いじめる素材 ----------
//
// **飛ばす手が効かない形を先に作る。** 無いと「速くなった」の中身が
// 「自分に都合のいい素材で測っただけ」になる。効かないのは「上限いっぱいで、窓の中が暴れている」形。

const lcg = (n, amp) => {
  const d = new Float32Array(n);
  let s = 1;
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = amp * (s / 0x40000000 - 1);
  }
  return d;
};
const wave = (n, f, amp, shape = 'sine') => {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin((2 * Math.PI * f * i) / sr);
    d[i] = amp * (shape === 'sine' ? v : v >= 0 ? 1 : -1);
  }
  return d;
};
/** タップの符号に合わせた並び。**上限をちょうど満たす＝飛ばす手がいちばん効かない形。** */
const worstCase = (n, amp) => {
  const taps = TP_FILTER[2];
  const d = new Float32Array(n);
  for (let i = 0; i < n; i += 1) d[i] = taps[i % TP_TAPS] > 0 ? amp : -amp;
  return d;
};

const N = 573300; // 素材の尺（11.9 秒）に揃える
const hard = [
  ['*上限をちょうど満たす並び', worstCase(N, 0.9)],
  ['*全振幅の雑音', lcg(N, 1)],
  ['*全振幅の 1kHz', wave(N, 1000, 1)],
  ['*全振幅の矩形波', wave(N, 200, 0.999, 'square')],
  ['*全振幅の 60Hz', wave(N, 60, 1)],
  ['*-20dB の雑音', lcg(N, 0.1)],
];

if (!fs.existsSync(fixtures)) {
  console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
  process.exit(1);
}
const real = fs
  .readdirSync(fixtures)
  .filter((f) => f.endsWith('.wav'))
  .map((f) => [f.replace(/\.wav$/, ''), readWav(path.join(fixtures, f)).getChannelData(0)]);

const med = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
/** **設定を交互に回す**（固めて測ると 5% 前後の差は出ない。2026-09-26・2 回目に確定）。 */
const runInterleaved = (runs, rounds = 5) => {
  const got = Object.fromEntries(Object.keys(runs).map((k) => [k, []]));
  for (let r = 0; r < rounds; r += 1) {
    for (const [k, fn] of Object.entries(runs)) {
      const t0 = performance.now();
      fn();
      got[k].push(performance.now() - t0);
    }
  }
  return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, med(v)]));
};

console.log('# 真のピークの打ち直しを速くする（2026-10-06）\n');
console.log(`位相 ${TP_FILTER.length} / タップ ${TP_TAPS} / 升 ${TP_BLOCK} 標本\n`);

// ---------- 1. 値が動いていないこと ----------

console.log('## 1. 値が動いていないこと\n');
console.log('**ここが崩れたら、以下の速さの数字には意味が無い。**');
console.log('比べる相手はタップから組み直した素直な形（位相ごとになめ直し、飛ばさない）。\n');
let worst = 0;
let worstName = '';
let envBad = 0;
for (const [name, data] of [...hard, ...real]) {
  if (truePeakOf(data) !== plainTruePeakOf(data)) {
    worst += 1;
    worstName = name;
  }
  const a = truePeakEnvelope(data);
  const b = plainTruePeakEnvelope(data);
  for (let i = 0; i < b.length; i += 1) if (a[i] !== b[i]) envBad += 1;
}
console.log(
  `素材 ${hard.length + real.length} 本（いじめる ${hard.length} ＋ 試し用 ${real.length}）: ` +
    `1 つの数 ${worst === 0 ? '全部一致' : `${worst} 本ずれた（${worstName}）`} / ` +
    `標本ごとの列 ${envBad === 0 ? '全標本一致' : `${envBad} 標本ずれた`}\n`,
);

// ---------- 2. 素材ごとの速さ ----------

console.log('## 2. 素材ごとの速さ（1 つの数を出す側。`measureLoudness` が通る道）\n');
console.log('**上の 3 本が「飛ばす手が効かない」側。** そこでも遅くなっていないことが要る。');
console.log('`*` はこの台本がその場で作る素材（試し用の素材より意地悪）。\n');
console.log('**「飛ばせた升」だけが数（時間ではない）なので、そこがいちばん当てになる。**');
console.log('前後の時間は**別の関数どうしの比べ**なので ±2 割は揺れる（4 節の注と同じ理由）。');
console.log('揺れない前後の表は README の「打ち直しを速くする」にある');
console.log('（10/05 の `lufs.ts` を取り出して別の process で走らせたもの。1.21〜9.49 倍・試し用 43 本で 7.00 倍）。\n');
console.log('| 素材 | 標本の最大 | 真のピーク | 飛ばせた升 | 前 | 後 | 速さ |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
const rows = [];
for (const [name, data] of hard) {
  let sp = 0;
  for (let i = 0; i < data.length; i += 1) {
    const a = Math.abs(data[i]);
    if (a > sp) sp = a;
  }
  const tp = truePeakOf(data);
  const { rate } = skipRate(data);
  const m = runInterleaved({ before: () => plainTruePeakOf(data), after: () => truePeakOf(data) });
  rows.push([name, sp, tp, rate, m.before, m.after]);
  console.log(
    `| ${name} | ${sp.toFixed(4)} | ${tp.toFixed(4)} (+${(20 * Math.log10(tp / sp)).toFixed(2)}dB) | ` +
      `${(rate * 100).toFixed(1)}% | ${m.before.toFixed(1)}ms | ${m.after.toFixed(1)}ms | **${(m.before / m.after).toFixed(1)} 倍** |`,
  );
}
// 試し用の素材は 1 行にまとめる（43 本を並べても読めない）。
{
  let sumBefore = 0;
  let sumAfter = 0;
  let sumRate = 0;
  let minRatio = Infinity;
  let minName = '';
  for (const [name, data] of real) {
    const { rate } = skipRate(data);
    const m = runInterleaved({ before: () => plainTruePeakOf(data), after: () => truePeakOf(data) }, 3);
    sumBefore += m.before;
    sumAfter += m.after;
    sumRate += rate;
    if (m.before / m.after < minRatio) {
      minRatio = m.before / m.after;
      minName = name;
    }
  }
  console.log(
    `| 試し用の素材 ${real.length} 本（合計） | — | — | ${((sumRate / real.length) * 100).toFixed(1)}% | ` +
      `${sumBefore.toFixed(0)}ms | ${sumAfter.toFixed(0)}ms | **${(sumBefore / sumAfter).toFixed(1)} 倍** |`,
  );
  console.log(`\nいちばん効かなかった試し用の素材: \`${minName}\`（${minRatio.toFixed(1)} 倍）`);
}

// ---------- 3. 列を返す側（リミッタが見るほう）----------

console.log('\n## 3. 列を返す側（リミッタが見るほう。飛ばす手は使えない）\n');
console.log('**どの標本の値も要るので、飛ばせない。** 残るのは 1 の融合だけ。\n');
console.log('ここも別の関数どうしなので、当てになる前後は README の表（試し用 43 本で 1.51 倍）。\n');
console.log('| 素材 | 前 | 後 | 速さ |');
console.log('| --- | ---: | ---: | ---: |');
for (const [name, data] of [hard[1], hard[5], real.find(([n]) => n === 'speech') ?? real[0]]) {
  const m = runInterleaved({ before: () => plainTruePeakEnvelope(data), after: () => truePeakEnvelope(data) });
  console.log(`| ${name} | ${m.before.toFixed(1)}ms | ${m.after.toFixed(1)}ms | ${(m.before / m.after).toFixed(2)} 倍 |`);
}

// ---------- 4. 無音で IIR の履歴が非正規化数へ落ちる ----------
//
// 打ち直しを速くしたら、山が K 特性の側へ移った。そこを測って出たのがこれ。

console.log('\n## 4. 無音で IIR の履歴が非正規化数へ落ちる\n');
console.log('**打ち直しを速くしたので山が K 特性へ移り、測り直したら出てきた穴。**');
console.log('無音が続くと履歴が 2.2e-308 より小さい数まで落ち、1 標本ごとの演算が CPU の遅い道へ逸れる。');
console.log('手当ては「落ちる手前（1e-100）で 0 へ寄せる」だけ。**毎標本見に行くと損**なので塊ごとに 1 回見る。\n');
console.log('前と後は**同じ関数に塊の幅を渡して**測る（別々の関数に書くと V8 の差が乗る。上の注）。\n');

{
  const length = 60 * sr;
  const silent = new Float32Array(length);
  const dense = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sr;
    const on = Math.max(0, Math.sin(2 * Math.PI * 0.35 * t)) ** 2;
    silent[i] = on === 0 ? 0 : 0.6 * on * Math.sin(2 * Math.PI * 220 * t);
    dense[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.02 * Math.sin(2 * Math.PI * 3100 * t);
  }
  const SUBNORMAL = 2.2250738585072014e-308;
  const subs = (a) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== 0 && Math.abs(a[i]) < SUBNORMAL) n += 1;
    return n;
  };
  const sizes = [0, 64, 512, 4096, 65536];
  console.log('| 素材 | 非正規化数の標本（潰さない。1 段目 / 2 段目） | ' + sizes.map((c) => (c === 0 ? '潰さない' : `塊 ${c}`)).join(' | ') + ' |');
  console.log('| --- | ---: | ' + sizes.map(() => '---:').join(' | ') + ' |');
  for (const [name, data] of [['鳴って休む（休みはちょうど 0）', silent], ['鳴りっぱなし', dense]]) {
    const one = subs(shelfOnly(data, 0));
    const two = subs(kFiltered(data, 0));
    const runs = Object.fromEntries(sizes.map((c) => [String(c), () => kFiltered(data, c)]));
    const m = runInterleaved(runs);
    console.log(
      `| ${name} | ${((one / length) * 100).toFixed(0)}% / ${((two / length) * 100).toFixed(0)}% | ` +
        sizes.map((c) => `${m[String(c)].toFixed(1)}ms`).join(' | ') + ' |',
    );
  }
  console.log('\n**非正規化数はまず 1 段目（棚）に出る。** 2 段目（38Hz の高域通過）は極が直流に近く、');
  console.log('1e-308 まで落ちるのに無音 3 秒ぶん要るので、**実素材の 0.7 秒の切れ目では 1 段目だけが落ちる。**');
  console.log('大きい塊で遅さが戻るのは、落ちてから次に見に行くまでの間が長くなるから。');
}

// 値が動いていないことを、試し用の素材ぜんぶで確かめる。
// **升がビット単位で同じにはならない**（無音だけの升は前が 1e-199 の桁・後が 0）。
// 主張は「ずれる升はどれも、どちらの形でも捨てられる」。
{
  const step = Math.round(0.1 * sr);
  const lufsOf = (sum) => (sum === 0 ? -Infinity : -0.691 + 10 * Math.log10(sum / step));
  let differing = 0;
  let overGate = 0;
  let loudest = -Infinity;
  let blocks = 0;
  for (const [, data] of real) {
    const before = kFiltered(data, 0);
    const after = kFiltered(data, 512);
    for (let b = 0; (b + 1) * step <= data.length; b += 1) {
      let sa = 0;
      let sb = 0;
      for (let i = b * step; i < (b + 1) * step; i += 1) {
        sa += before[i] * before[i];
        sb += after[i] * after[i];
      }
      blocks += 1;
      if (sa === sb) continue;
      differing += 1;
      const level = Math.max(lufsOf(sa), lufsOf(sb));
      if (level > loudest) loudest = level;
      if (level > ABSOLUTE_GATE_LUFS) overGate += 1;
    }
  }
  console.log(
    `\n試し用の素材 ${real.length} 本・${blocks} 升: ずれた升 ${differing}（` +
      `${loudest === -Infinity ? 'ずれなし' : `いちばん大きいものが ${loudest.toFixed(0)} LUFS`}）/ ` +
      `絶対ゲート（${ABSOLUTE_GATE_LUFS} LUFS）より上でずれた升 **${overGate}**`,
  );
}

// ---------- 5. 測りぜんたい ----------

console.log('\n## 5. 測りぜんたい\n');
console.log('**「前」は推し量り**——いまの合計から「いまの 2 段（打ち直し＋K 特性）」を引いて、');
console.log('「前の 2 段（素直な打ち直し＋素直な K 特性）」を足したもの。');
console.log('2 段の中身は 2 節と 4 節でそのまま測っているので、引き算の両辺は実測。\n');
console.log('**丸ごと前後を測った数字は README の「打ち直しを速くする」にある**');
console.log('（10/05 の `lufs.ts` を `git show` で取り出して別の process で走らせたもの。素材 43 本で 2.82 倍、');
console.log('値は 9 欄すべてビット単位で一致）。\n');
console.log('| 素材 | 尺 | ch | 前（推し量り） | 後（実測） | 速さ | 打ち直しの取り分（前 → 後） |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
const longSeconds = Number(process.env.LAB_TP_LONG ?? 60);
for (const [kind, seconds, channels] of [
  ['鳴って休む', longSeconds, 1],
  ['鳴って休む', longSeconds, 2],
  ['鳴りっぱなし', longSeconds, 2],
]) {
  const length = Math.round(seconds * sr);
  const planes = [];
  for (let c = 0; c < channels; c += 1) {
    const d = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const t = i / sr;
      const on = kind === '鳴って休む' ? Math.max(0, Math.sin(2 * Math.PI * 0.35 * t + c)) ** 2 : 1;
      d[i] = on === 0 ? 0 : 0.6 * on * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(2 * Math.PI * 3 * t)) * t);
    }
    planes.push(d);
  }
  const buffer = { sampleRate: sr, numberOfChannels: channels, length, getChannelData: (c) => planes[c] };
  const source = blockSourceOf(buffer);
  const m = runInterleaved(
    {
      whole: () => measureLoudness(buffer, {}),
      wholeSkip: () => measureLoudness(buffer, { skipTruePeak: true }),
      stream: () => measureLoudnessStream(source, {}),
      beforeStages: () => {
        for (let c = 0; c < channels; c += 1) {
          plainTruePeakOf(planes[c]);
          kFiltered(planes[c], 0);
        }
      },
      afterStages: () => {
        for (let c = 0; c < channels; c += 1) {
          truePeakOf(planes[c]);
          kFiltered(planes[c], 512);
        }
      },
      beforeTp: () => {
        for (let c = 0; c < channels; c += 1) plainTruePeakOf(planes[c]);
      },
      afterTp: () => {
        for (let c = 0; c < channels; c += 1) truePeakOf(planes[c]);
      },
    },
    3,
  );
  const guess = m.whole - m.afterStages + m.beforeStages;
  const share = (total, tp) => `${((tp / total) * 100).toFixed(0)}%`;
  console.log(
    `| ${kind} | ${seconds}s | ${channels} | ${guess.toFixed(0)}ms | ${m.whole.toFixed(0)}ms | ` +
      `**${(guess / m.whole).toFixed(2)} 倍** | ${share(guess, m.beforeTp)} → ${share(m.whole, m.afterTp)} |`,
  );
}
console.log('\n**鳴りっぱなしの行は当てにならない**——推し量りの揺れ（別の関数どうしなので ±2 割）が');
console.log('効きの大きさ（1.2 倍）と同じ桁。実測は README の表の **1.19 倍**。');
console.log('\n流す形（`measureLoudnessStream`）も同じ漸化式・同じ打ち直しを通るので、ここでは別に並べない');
console.log('（一致は検算が区間の幅を振って固定している）。');
