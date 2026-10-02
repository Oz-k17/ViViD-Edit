/**
 * ラウドネスの測りを**長尺に当てられるか**を測る（2026-10-02・2 回目）。
 *
 *   npm run lab:loudness:stream
 *   LAB_LONG=1800 npm run lab:loudness:stream   # 一括のほうも 30 分で踏む（メモリを食う）
 *   LAB_SKIP_MEM=1 npm run lab:loudness:stream  # 子プロセスの測りを飛ばす（速い）
 *
 * 2026-10-02（1 回目）にリミッタを流せるようにしたが、**書き出しの道すじでは
 * 倍率を決める側（ここ）が先に詰まる。** リミッタの一括が 10 分 1ch で 558MB のところ、
 * `measureLoudness` は同じ素材で 881MB だった（下の表）。
 *
 * 見ているのは 4 つ。
 *
 *   1. **流す形が一括とビット単位で同じか**（同じでなければ、以後の数字に意味が無い）。
 *      継ぎ目は**1 標本きざみで総当たり**する。2026-10-02（1 回目）に、区間が素材の長さを
 *      割り切るときだけ落ちる穴を踏んだので、ここは先に書いてある。
 *   2. **メモリが尺で決まらなくなったか**（これが本題）。
 *   3. **まだ尺に比例して持っているもの**（相対ゲートのために 0.1 秒ごとの二乗和は捨てられない）。
 *   4. **書き出しの道すじぜんたい**（測る → 倍率 → リミッタ）で、何回素材を読むことになるか。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';

const { measureLoudness, measureLoudnessStream, planLoudnessNormalization, STEP_SECONDS, DEFAULT_LOUDNESS_BLOCK_SECONDS } =
  await import('./src/lufs.ts');
const { blockSourceOf } = await import('./src/loudness.ts');
const { materialize, generatedSource } = await import('./limit-signal.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixtures = path.join(root, 'lab/fixtures/out');
const sr = 48000;

// ---------- メモリの測りは、いちばん最初にやる ----------
//
// 子の `ru_maxrss` は fork した時点の親の常駐量を引き継ぐ（`project-pack/mem-probe.mjs` に経緯）。
// この台本が素材を抱えてから子を起こすと、**何もしない子でも 161MB を返す**（2026-10-02・1 回目に実際そう出た）。
// なので測るのは先、刷るのは後。

const longSeconds = Number(process.env.LAB_LONG ?? 600);
const memory = { skipped: process.env.LAB_SKIP_MEM === '1', floor: null, pairs: [], blocks: [], chain: [] };
if (!memory.skipped) {
  const child = (seconds, mode, blockSeconds = 5, channels = 1) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(here, 'loudness-mem.mjs'), String(seconds), mode, String(blockSeconds), String(channels)],
        { encoding: 'utf8', maxBuffer: 1 << 24 },
      ),
    );
  memory.floor = child(13, 'none');
  for (const [seconds, channels] of [[13, 1], [60, 1], [longSeconds, 1], [longSeconds, 2]]) {
    memory.pairs.push([seconds, channels, child(seconds, 'whole', 5, channels), child(seconds, 'stream', 5, channels)]);
  }
  for (const blockSeconds of [0.01, 0.1, 0.5, 1, 5, 30]) {
    memory.blocks.push([blockSeconds, child(60, 'stream', blockSeconds, 1)]);
  }
  for (const [seconds, channels] of [[60, 1], [longSeconds, 1], [longSeconds, 2]]) {
    memory.chain.push([seconds, channels, child(seconds, 'chain-whole', 5, channels), child(seconds, 'chain-stream', 5, channels)]);
  }
  // 漸化式を 1 か所へまとめた副作用（**一括のほうに効いた**）。交互に 3 回。
  memory.kw = [];
  for (const [seconds, channels] of [[60, 1], [longSeconds, 1], [longSeconds, 2]]) {
    const olds = [];
    const news = [];
    for (let r = 0; r < 3; r += 1) {
      olds.push(child(seconds, 'kw-old', 5, channels));
      news.push(child(seconds, 'kw-new', 5, channels));
    }
    memory.kw.push([seconds, channels, olds, news]);
  }
}

// ---------- 1. 一括と流す形が、ビット単位で同じか ----------

// 返り値の欄はぜんぶ見る（`integratedLufs` だけ合っていても、瞬間の最大やゲートの数が
// ずれていたら別物。**「主な数字だけ比べる」は、違いを隠す向きの手抜き**）。
const KEYS = [
  'integratedLufs',
  'momentaryMaxLufs',
  'shortTermMaxLufs',
  'samplePeakDb',
  'truePeakDb',
  'quietBlockLufs',
  'gatedBlocks',
  'droppedBlocks',
  'duration',
  'channels',
];
const same = (a, b) => KEYS.every((k) => a[k] === b[k] || (a[k] === null && b[k] === null));
const diffKeys = (a, b) => KEYS.filter((k) => !(a[k] === b[k] || (a[k] === null && b[k] === null)));

// **列は 1 回だけ作って持つ。** `blockSourceOf` は `read` ごとに `getChannelData` を呼ぶので、
// そのつど作る形にすると区間を細かく振ったときだけ二乗の手間になる（一度それで測りが終わらなかった）。
const mono = (length, f, sampleRate = sr) => {
  const a = new Float32Array(length);
  for (let i = 0; i < length; i += 1) a[i] = f(i);
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => a };
};

console.log('## 1. 一括と流す形が同じか\n');
console.log('返ってくる 10 個の欄をぜんぶ突き合わせる。**1 ビットでも違えば駄目**としている');
console.log('（「耳で分からないから良い」を許すと、あとで何が原因か分からなくなる）。\n');
console.log('| 素材 | ch | 区間 0.001s | 0.01s | 0.1s | 1s | 5s | 一括と同じ区間 | 測った値 |');
console.log('| --- | ---: | --- | --- | --- | --- | --- | --- | ---: |');

const cases = [];
cases.push(['合成（打点つき・8 秒）', materialize(8, { sampleRate: sr, channels: 1 })]);
cases.push(['合成（同じものを 2ch）', materialize(8, { sampleRate: sr, channels: 2 })]);
cases.push(['無音（2 秒）', mono(sr * 2, () => 0)]);
cases.push(['0.1 秒を割り切らない長さ', mono(sr * 3 + 1234, (i) => 0.4 * Math.sin((2 * Math.PI * 180 * i) / sr))]);
if (fs.existsSync(fixtures)) {
  for (const name of ['speech.wav', 'speech-click.wav', 'music-hats.wav', 'speech-quiet.wav', 'room-tone.wav']) {
    const file = path.join(fixtures, name);
    if (!fs.existsSync(file)) continue;
    cases.push([name, readWav(file)]);
  }
}

const blockList = [0.001, 0.01, 0.1, 1, 5, Infinity];
let allSame = true;
for (const [name, buffer] of cases) {
  const ref = measureLoudness(buffer);
  const cols = [];
  for (const blockSeconds of blockList) {
    const got = measureLoudnessStream(blockSourceOf(buffer), { blockSeconds });
    const ok = same(ref, got);
    if (!ok) allSame = false;
    cols.push(ok ? '同じ' : `**ちがう**（${diffKeys(ref, got).join('・')}）`);
  }
  const v = ref.integratedLufs === null ? '測れない' : `${ref.integratedLufs.toFixed(3)} LUFS / ${ref.truePeakDb.toFixed(3)} dBTP`;
  console.log(`| ${name} | ${buffer.numberOfChannels} | ${cols.join(' | ')} | ${v} |`);
}
console.log(`\n${allSame ? '**全部ビット単位で同じ。**' : '**ちがうものがある。**'}`);

// つまみの組み合わせも振る（1ch を 2ch 扱い・真のピークを省く）。
{
  let n = 0;
  let bad = 0;
  for (const [, buffer] of cases) {
    for (const monoAsDualMono of [false, true]) {
      for (const skipTruePeak of [false, true]) {
        const ref = measureLoudness(buffer, { monoAsDualMono, skipTruePeak });
        for (const blockSeconds of [0.01, 1, Infinity]) {
          n += 1;
          if (!same(ref, measureLoudnessStream(blockSourceOf(buffer), { monoAsDualMono, skipTruePeak, blockSeconds }))) bad += 1;
        }
      }
    }
  }
  console.log(`つまみの組み合わせ（1ch を 2ch 扱い × 真のピークを省く × 区間 3 通り）: ${n} 通り / ちがい ${bad}`);
}

// ---------- 継ぎ目を 1 標本きざみで総当たり ----------

console.log('\n### 継ぎ目をあらゆる位置へずらす\n');
console.log('2026-10-02（1 回目）に、**区間が素材の長さをちょうど割り切るときだけ**落ちる穴を踏んだ。');
console.log('継ぎ目は 3 つの格子（0.1 秒の部分和・打ち直す窓の 12 標本・素材の端）と好きな所で交わるので、');
console.log('区間の長さを**1 標本から素材の長さまで 1 きざみで**振って突き合わせる。\n');
console.log('総当たりは **4.8kHz** で回す（0.1 秒の格子が 480 標本になるので、同じ交わり方を 10 分の 1 の手間で踏める。');
console.log('K 特性はその場の標本化周波数から作り直すので、低い周波数でも成り立つ）。48kHz のほうは幅を決めて振る。\n');
console.log('| 素材 | 標本化周波数 | 長さ（標本） | 振った区間 | ちがい |');
console.log('| --- | ---: | ---: | ---: | ---: |');

const lowSr = 4800; // 0.1 秒 = 480 標本
const sweeps = [
  // 0.1 秒の格子をまたぎ、末尾に端切れが出る長さ。
  ['打点つき・端切れあり', lowSr, 480 * 3 + 37, (i) => 0.4 * Math.sin((2 * Math.PI * 180 * i) / lowSr) + (i % 481 < 5 ? 1.3 : 0)],
  // 格子をちょうど割り切る長さ（1 回目に踏んだ穴はこの形で出た）。
  ['格子をちょうど割り切る', lowSr, 480 * 4, (i) => 0.4 * Math.sin((2 * Math.PI * 180 * i) / lowSr) + (i % 97 < 3 ? 1.3 : 0)],
  // 0.1 秒に満たない（部分和が 1 つもできない）。
  ['0.1 秒より短い', lowSr, 479, (i) => 0.9 * Math.sin((2 * Math.PI * 997 * i) / lowSr)],
  // 打ち直す窓（12 標本）と同じ桁の長さ。
  ['12 標本ちょうど', lowSr, 12, (i) => (i % 2 ? 0.95 : -0.95)],
  ['11 標本（畳み込まない側）', lowSr, 11, (i) => (i % 2 ? 0.95 : -0.95)],
  ['無音（格子ぴったり）', lowSr, 480 * 2, () => 0],
];
let sweepBad = 0;
for (const [name, rate, length, f] of sweeps) {
  const buffer = mono(length, f, rate);
  const ref = measureLoudness(buffer);
  let bad = 0;
  const src = blockSourceOf(buffer);
  for (let b = 1; b <= length; b += 1) {
    if (!same(ref, measureLoudnessStream(src, { blockSeconds: b / rate }))) bad += 1;
  }
  sweepBad += bad;
  console.log(`| ${name} | ${rate} | ${length} | 1〜${length} 標本（${length} 通り） | ${bad === 0 ? '**0**' : `**${bad}**`} |`);
}

// 48kHz のほうは、効きそうな所を選んで振る（総当たりは手間が二乗で伸びる）。
{
  const length = 4800 * 3 + 37;
  const buffer = mono(length, (i) => 0.4 * Math.sin((2 * Math.PI * 180 * i) / sr) + (i % 4801 < 5 ? 1.3 : 0));
  const ref = measureLoudness(buffer);
  const src = blockSourceOf(buffer);
  const list = new Set();
  for (let b = 1; b <= 64; b += 1) list.add(b); // 打ち直す窓（12）をまたぐ所
  for (const base of [480, 2400, 4800, 9600, length]) {
    for (let d = -3; d <= 3; d += 1) if (base + d >= 1 && base + d <= length) list.add(base + d);
  }
  for (const n of [1, 2, 3, 4, 5, 7, 8, 16]) list.add(Math.floor(length / n)); // 長さを割り切る側
  let bad = 0;
  for (const b of list) if (!same(ref, measureLoudnessStream(src, { blockSeconds: b / sr }))) bad += 1;
  sweepBad += bad;
  console.log(`| 打点つき・端切れあり | ${sr} | ${length} | 選んだ ${list.size} 通り（1〜64・格子の前後・長さを割り切る値） | ${bad === 0 ? '**0**' : `**${bad}**`} |`);
}
console.log(`\n${sweepBad === 0 ? '**どこで切っても同じ。**' : '**切り所で変わる所がある。**'}`);

// ---------- 2. 何回読むことになるか ----------

console.log('\n## 2. 流す形は素材を何回読むか\n');
console.log('`read` の呼ばれ方を数える（絶対位置の重なり・読み直し・読み落としを全部見る）。\n');
console.log('| 通した道 | 読んだ標本（素材の何倍） | read の回数 | 前へ進むだけか |');
console.log('| --- | ---: | ---: | --- |');

const countingSource = (length, channels = 1) => {
  const stat = { read: 0, calls: 0, backwards: 0, overlap: 0 };
  let highest = 0;
  return {
    stat,
    source: {
      sampleRate: sr,
      numberOfChannels: channels,
      length,
      read(from, to) {
        stat.calls += 1;
        stat.read += to - from;
        if (from < highest) stat.overlap += 1;
        if (to <= from) stat.backwards += 1;
        highest = Math.max(highest, to);
        const out = [];
        for (let c = 0; c < channels; c += 1) {
          const a = new Float32Array(to - from);
          for (let i = from; i < to; i += 1) a[i - from] = 0.4 * Math.sin((2 * Math.PI * 180 * i) / sr) + (i % 38400 < 200 ? 1.2 : 0);
          out.push(a);
        }
        return out;
      },
    },
  };
};

{
  const length = sr * 8;
  const a = countingSource(length);
  measureLoudnessStream(a.source, {});
  console.log(
    `| 測るだけ | ${a.stat.read}（${(a.stat.read / length).toFixed(2)} 倍） | ${a.stat.calls} | ` +
      `${a.stat.overlap === 0 && a.stat.backwards === 0 ? 'はい' : '**いいえ**'} |`,
  );

  // 書き出しの道すじ: 測る → 倍率 → リミッタ。
  const { limitTruePeakStream } = await import('./src/limiter.ts');
  const b = countingSource(length);
  const m = measureLoudnessStream(b.source, {});
  const plan = planLoudnessNormalization(m, { limiterHeadroomDb: 12 });
  const c = countingSource(length);
  limitTruePeakStream(
    {
      sampleRate: c.source.sampleRate,
      numberOfChannels: c.source.numberOfChannels,
      length: c.source.length,
      read(from, to) {
        const got = c.source.read(from, to);
        for (const ch of got) for (let i = 0; i < ch.length; i += 1) ch[i] *= plan.gain;
        return got;
      },
    },
    () => {},
    { maxReductionDb: 12 },
  );
  const total = b.stat.read + c.stat.read;
  console.log(
    `| 測る → 倍率 → リミッタ | ${total}（${(total / length).toFixed(2)} 倍） | ${b.stat.calls + c.stat.calls} | ` +
      `各回とも はい |`,
  );
  console.log(
    `\n**倍率は測り終わるまで決まらない**ので、流す形は素材を**2 回読む**ことになる（上の 2.00 倍）。` +
      `\n一括は 1 回しか起こさないが、そのぶん列を抱える。**メモリと読み直しの取り替え**であって、どちらも只ではない。` +
      `\nデコーダを直に繋ぐなら、2 回めはデコードのやり直しになる（9/30 の範囲読みで 1 時間から 10 秒を起こすのが 135ms だったので、` +
      `\n全体をもう 1 周するのはそれなりに高い）。`,
  );
}

// ---------- 3. メモリと時間 ----------

console.log('\n## 3. メモリと時間\n');
if (memory.skipped) {
  console.log('（`LAB_SKIP_MEM=1` なので飛ばした）');
} else {
  const mb = (v) => `${(v / (1 << 20)).toFixed(0)}MB`;
  const floor = memory.floor.peak;
  console.log(`走り出しの床（何もしない子）: ${mb(floor)}。以下は**山そのもの**（床を含む値）。\n`);
  console.log('| 尺 | ch | 一括の山 | 流す形（区間 5s） | 何分の 1 | 一括の時間 | 流す形の時間 |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [seconds, channels, whole, stream] of memory.pairs) {
    const a = whole.peak - whole.floor;
    const b = stream.peak - stream.floor;
    console.log(
      `| ${seconds}s | ${channels} | ${mb(a)} | ${mb(b)} | ${b > 0 ? (a / b).toFixed(1) : '—'} | ` +
        `${whole.ms}ms | ${stream.ms}ms |`,
    );
    if (whole.out.lufs !== stream.out.lufs || whole.out.tp !== stream.out.tp) {
      console.log(`| ↑ | | **測った値がちがう** | ${whole.out.lufs} / ${stream.out.lufs} | | | |`);
    }
  }
  console.log('\n区間の長さで振ると（60 秒 1ch）:\n');
  console.log('| 区間 | 山 | 時間 |');
  console.log('| ---: | ---: | ---: |');
  for (const [blockSeconds, got] of memory.blocks) {
    console.log(`| ${blockSeconds}s | ${mb(got.peak - got.floor)} | ${got.ms}ms |`);
  }
  console.log(`\n既定は ${DEFAULT_LOUDNESS_BLOCK_SECONDS} 秒（リミッタと同じ刻み）。`);
  console.log(
    '\n**上の「流す形の時間」には素材をその場で作る手間が入っている。**' +
      '\n列を持たないことがメモリの前提なので、ここはそう測るしかない。' +
      '\n測りの手間を抜いた時間は 5 節（同じ列を一括と流す形へ渡す形）を見ること。',
  );

  console.log('\n書き出しの道すじぜんたい（測る → 倍率 → リミッタ）:\n');
  console.log('| 尺 | ch | 一括の山 | 流す形の山 | 何分の 1 | 一括の時間 | 流す形の時間 | 出口の波 |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const [seconds, channels, whole, stream] of memory.chain) {
    const a = whole.peak - whole.floor;
    const b = stream.peak - stream.floor;
    const hashSame = JSON.stringify(whole.out.hashes) === JSON.stringify(stream.out.hashes);
    console.log(
      `| ${seconds}s | ${channels} | ${mb(a)} | ${mb(b)} | ${b > 0 ? (a / b).toFixed(1) : '—'} | ` +
        `${whole.ms}ms | ${stream.ms}ms | ${hashSame ? '同じ' : '**ちがう**'} |`,
    );
  }
}

// ---------- 3' 漸化式を 1 か所へまとめた副作用 ----------

console.log('\n### 流す形のために変えたことが、一括のほうに効いた\n');
console.log('K 特性は 2 段の IIR で、漸化式は位置 `i` の値しか見ない（前の入力は履歴が持っている）。');
console.log('だから**その場で書き換えられる**——流す形で入れ物を 1 本に抑えるために気づいたことだが、');
console.log('昔の形は「写し ＋ 1 段目の出口 ＋ 2 段目の出口」で**全長の倍精度の列を 3 本**作っていた。\n');
if (memory.skipped || !memory.kw) {
  console.log('（`LAB_SKIP_MEM=1` なので飛ばした）');
} else {
  const mb = (v) => `${(v / (1 << 20)).toFixed(0)}MB`;
  const med = (xs, pick) => {
    const v = xs.map(pick).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  console.log('| 尺 | ch | 昔の形の山 | いまの形の山 | 何分の 1 | 昔の形の時間 | いまの形の時間 | 何倍速 | 同じ値か |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const [seconds, channels, olds, news] of memory.kw) {
    const a = med(olds, (x) => x.peak - x.floor);
    const b = med(news, (x) => x.peak - x.floor);
    const ta = med(olds, (x) => x.ms);
    const tb = med(news, (x) => x.ms);
    const sameEdge = olds.every((x) => x.out.edge === news[0].out.edge) && news.every((x) => x.out.edge === news[0].out.edge);
    console.log(
      `| ${seconds}s | ${channels} | ${mb(a)} | ${mb(b)} | ${b > 0 ? (a / b).toFixed(1) : '—'} | ${ta}ms | ${tb}ms | ` +
        `${tb > 0 ? (ta / tb).toFixed(1) : '—'} | ${sameEdge ? '同じ' : '**ちがう**'} |`,
    );
  }
  console.log(
    '\n（3 回ずつ交互に回した中央値。「同じ値か」は通した列の両端を突き合わせたもの）' +
      '\n\n**狙っていたのは流す形のメモリで、効いたのは一括の時間だった。**' +
      '\n列を 3 本ぶん確保して触ることが、漸化式そのものより重かったという話。',
  );
}

// ---------- 4. まだ尺に比例して持っているもの ----------

console.log('\n## 4. まだ尺に比例して持っているもの\n');
console.log('相対ゲートは「全部の 0.4 秒窓の平均から 10 LU 下」を線にするので、');
console.log('**1 周めの終わりまで捨てる窓が決まらない。** なので 0.1 秒ごとの二乗和（`sums`）は全部持つ。\n');
console.log('| 尺 | 持つ数 | バイト | 標本の側（2ch・参考） | 比 |');
console.log('| ---: | ---: | ---: | ---: | ---: |');
for (const seconds of [13, 60, 600, 3600, 36000]) {
  const n = Math.floor((seconds * sr) / Math.round(STEP_SECONDS * sr));
  const bytes = n * 8;
  const raw = seconds * sr * 4 * 2;
  const fmt = (v) => (v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(2)}GB` : v >= 1 << 20 ? `${(v / (1 << 20)).toFixed(1)}MB` : `${(v / (1 << 10)).toFixed(0)}KB`);
  console.log(`| ${seconds}s | ${n} | ${fmt(bytes)} | ${fmt(raw)} | 1 / ${Math.round(raw / bytes)} |`);
}
console.log(
  '\n**桁が違うので、ここは追わない。** 1 時間で 288KB。' +
    '\n消すには素材を 2 周読む（1 周めで線だけ決め、2 周めで平均する）ことになるが、' +
    '\nそれは**上の「2 回読む」をもう 1 回増やす**ことなので、288KB の代価としては高すぎる。',
);

// ---------- 5. 時間はどこで使っているか ----------

console.log('\n## 5. 時間はどこで使っているか\n');
console.log('**ここは素材を先に起こして、一括と流す形へ同じ列を渡す。** 3 節の「流す形の時間」には');
console.log('素材をその場で作る手間（`generatedSource` が標本ごとに sin と exp を回す）が入っていて、');
console.log('そこを引かないと測りが流す形に不利な側へ寄る。下の「作るだけ」がその手間。\n');
console.log('**4 通りを交互に回す**（固めて測ると 5% 前後の差は出ない——2026-09-26・2 回目に確定）。\n');
console.log('| 尺 | ch | 作るだけ | 一括（TP あり / 省く） | 流す形（TP あり / 省く） | 流す形 ÷ 一括 | 打ち直しの取り分 |');
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [seconds, channels] of [[13, 1], [60, 1], [60, 2]]) {
  const buffer = materialize(seconds, { sampleRate: sr, channels });
  const pre = blockSourceOf(buffer);
  const gen = generatedSource(seconds, { sampleRate: sr, channels });
  const runs = {
    make: () => {
      for (let o = 0; o < gen.length; o += sr * 5) gen.read(o, Math.min(gen.length, o + sr * 5));
    },
    wholeFull: () => measureLoudness(buffer, {}),
    wholeSkip: () => measureLoudness(buffer, { skipTruePeak: true }),
    streamFull: () => measureLoudnessStream(pre, {}),
    streamSkip: () => measureLoudnessStream(pre, { skipTruePeak: true }),
  };
  const got = { make: [], wholeFull: [], wholeSkip: [], streamFull: [], streamSkip: [] };
  for (let r = 0; r < 5; r += 1) {
    for (const key of Object.keys(runs)) {
      const t0 = performance.now();
      runs[key]();
      got[key].push(performance.now() - t0);
    }
  }
  const med = (xs) => {
    const v = [...xs].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const m = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, med(v)]));
  const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(0)}%`;
  console.log(
    `| ${seconds}s | ${channels} | ${m.make.toFixed(0)}ms | ${m.wholeFull.toFixed(0)} / ${m.wholeSkip.toFixed(0)}ms | ` +
      `${m.streamFull.toFixed(0)} / ${m.streamSkip.toFixed(0)}ms | ${(m.streamFull / m.wholeFull).toFixed(2)} 倍 | ` +
      `${pct(m.wholeFull, m.wholeSkip)} / ${pct(m.streamFull, m.streamSkip)} |`,
  );
}
console.log(
  '\n**同じ列を渡せば、一括と流す形の速さは変わらない**（差は測りの揺れの中）。' +
    '\n3 節で流す形が 1.1〜1.4 倍遅く見えていたのは、素材をその場で作っていたぶん' +
    '\n（60 秒 1ch で約 190ms・2ch で約 290ms）で、**測りの穴だった。**' +
    "\n3' 節で一括が 5 倍速くなったのは列を 3 本から 1 本にした話で、" +
    '\nいまは一括も流す形も同じ漸化式を通るので、ここで差が出る理由はもう無い。' +
    '\n\n**打ち直し（真のピーク）が時間の 8 割を持っている。** それでも省けない——' +
    '\n`planLoudnessNormalization` が天井の余地を見るので、倍率を決めるには真のピークが要る。' +
    '\n`skipTruePeak` を立ててよいのは「大きさだけ見せたい」場面だけ（立てると `truePeakDb` には標本の最大が入る）。',
);
