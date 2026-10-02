/**
 * リミッタを**長尺に当てられるか**を測る（2026-10-02）。
 *
 *   npm run lab:limit:stream
 *   LAB_LONG=1800 npm run lab:limit:stream   # 一括のほうも 30 分で踏む（メモリを食う）
 *   LAB_SKIP_MEM=1 npm run lab:limit:stream  # 子プロセスの測りを飛ばす（速い）
 *
 * 見ているのは 3 つ。
 *
 *   1. **流す形が一括とビット単位で同じか。**（同じでなければ、以後の数字に意味が無い）
 *   2. **メモリが尺で決まらなくなったか。**（これが本題）
 *   3. **2026-09-20 の注にあった「先読みの窓 L ぶん重ねて繋げば分割できる」が本当か。**
 *
 * 3 は**外れている**。重ねるだけで繋ぐと、戻りの制限（`u[i] = max(1-minAhead[i], u[i-1]*alpha)`）が
 * 後ろへ無限に続くぶんが切れるので、**要るのりしろは素材で決まってしまう**（下の表）。
 * 代わりに入れたのは状態を持ち越す形で、そちらは**定数ののりしろで必ず一致する。**
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';

const { limitTruePeak, limitTruePeakInBlocks, limitTruePeakStream, blockSourceOf, DEFAULT_LIMITER } =
  await import('./src/limiter.ts');
const { truePeakOf } = await import('./src/lufs.ts');
const { materialize, generatedSource } = await import('./limit-signal.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixtures = path.join(root, 'lab/fixtures/out');
const sr = 48000;
const look = Math.round((DEFAULT_LIMITER.lookAheadMs / 1000) * sr);

// ---------- メモリの測りは、いちばん最初にやる ----------
//
// 子の `ru_maxrss` は fork した時点の親の常駐量を引き継ぐ（`project-pack/mem-probe.mjs` に経緯）。
// この台本が素材を抱えてから子を起こすと、**何もしない子でも 161MB を返す**（実際そう出た）。
// なので測るのは先、刷るのは後。

const longSeconds = Number(process.env.LAB_LONG ?? 600);
const memory = { skipped: process.env.LAB_SKIP_MEM === '1', floor: null, pairs: [], blocks: [] };
if (!memory.skipped) {
  const child = (seconds, mode, blockSeconds = 5, channels = 1) =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(here, 'limit-mem.mjs'), String(seconds), mode, String(blockSeconds), String(channels)], {
        encoding: 'utf8',
        maxBuffer: 1 << 24,
      }),
    );
  memory.floor = child(13, 'none');
  for (const [seconds, channels] of [[13, 1], [60, 1], [longSeconds, 1], [longSeconds, 2]]) {
    memory.pairs.push([seconds, channels, child(seconds, 'whole', 5, channels), child(seconds, 'stream', 5, channels)]);
  }
  for (const blockSeconds of [0.01, 0.1, 0.5, 1, 5, 30]) {
    memory.blocks.push([blockSeconds, child(60, 'stream', blockSeconds, 1)]);
  }
}

const asBuffer = (data, sampleRate = sr, channels = 1) => ({
  sampleRate,
  numberOfChannels: channels,
  length: data[0].length,
  getChannelData: (c) => data[c],
});

// ---------- 1. 一括と流す形が、ビット単位で同じか ----------

console.log('## 1. 一括と流す形が同じか\n');
console.log('出口の標本を 1 つずつ突き合わせる。**1 ビットでも違えば駄目**としている');
console.log('（「耳で分からないから良い」を許すと、あとで何が原因か分からなくなる）。\n');
console.log('| 素材 | ch | 区間 0.01s | 0.1s | 1s | 5s | 一括と同じ区間 | 報告 |');
console.log('| --- | ---: | --- | --- | --- | --- | --- | --- |');

const cases = [];
cases.push(['合成（打点つき・8 秒）', materialize(8, { sampleRate: sr, channels: 1 })]);
cases.push(['合成（同じものを 2ch）', materialize(8, { sampleRate: sr, channels: 2 })]);
if (fs.existsSync(fixtures)) {
  for (const name of ['speech.wav', 'speech-click.wav', 'music-hats.wav', 'speech-quiet.wav']) {
    const file = path.join(fixtures, name);
    if (!fs.existsSync(file)) continue;
    // `readWav` はそのまま `AudioLike` を返す（標本の速さも素材のまま）。
    cases.push([name, readWav(file)]);
  }
}

let allSame = true;
for (const [name, buffer] of cases) {
  const opt = { maxReductionDb: 12 };
  const ref = limitTruePeak(buffer, opt);
  const cols = [];
  for (const blockSeconds of [0.01, 0.1, 1, 5, Infinity]) {
    const got = limitTruePeakInBlocks(buffer, { ...opt, blockSeconds });
    let same = true;
    for (let c = 0; c < buffer.numberOfChannels && same; c += 1) {
      const A = ref.buffer.getChannelData(c);
      const B = got.buffer.getChannelData(c);
      for (let i = 0; i < buffer.length; i += 1) if (A[i] !== B[i]) { same = false; break; }
    }
    const reportSame = JSON.stringify(ref.report) === JSON.stringify(got.report);
    if (!same || !reportSame) allSame = false;
    cols.push(same && reportSame ? '同じ' : `**ちがう**${same ? '（報告）' : ''}`);
  }
  const r = ref.report;
  console.log(
    `| ${name} | ${buffer.numberOfChannels} | ${cols[0]} | ${cols[1]} | ${cols[2]} | ${cols[3]} | ${cols[4]} | ` +
      `${r.maxReductionDb.toFixed(2)}dB / ${r.truePeakDb.toFixed(2)} dBTP |`,
  );
}
console.log(`\n${allSame ? '**全部ビット単位で同じ。**' : '**ちがうものがある。**'} 報告（下げた深さ・作動した秒・通したあとの真のピーク）も同じ。`);

// ---------- 2. 「重ねるだけ」で足りるか ----------

console.log('\n## 2. 「先読みの窓 L ぶん重ねれば分割できる」は本当か\n');
console.log('前の区間の状態を**持ち越さず**、区間ごとに独立に一括を回して真ん中だけを採る形。');
console.log(`先読み L = ${look} 標本（${DEFAULT_LIMITER.lookAheadMs}ms）／区間 0.25 秒。\n`);

const overlapRun = (src, W, blockSamples, given) => {
  // **既定を混ぜてから読む。** 渡された分だけを見ると先読みが undefined になり、
  // 区間が空になって「全部一致」と嘘をつく（実際一度そう出た）。
  const opt = { ...DEFAULT_LIMITER, ...given };
  const L = Math.max(1, Math.round((opt.lookAheadMs / 1000) * sr));
  const out = new Float32Array(src.length);
  for (let o = 0; o < src.length; o += blockSamples) {
    const oEnd = Math.min(src.length, o + blockSamples);
    const from = Math.max(0, o - W);
    const to = Math.min(src.length, oEnd + L + 12);
    const a = src.subarray(from, to);
    const got = limitTruePeak(asBuffer([a]), opt).buffer.getChannelData(0);
    for (let i = o; i < oEnd; i += 1) out[i] = got[i - from];
  }
  return out;
};

{
  // **既定のつまみのまま測る。** 歯止めを緩めると天井が割れる所が隠れる。
  const src = materialize(8, { sampleRate: sr, channels: 1 }).getChannelData(0);
  const opt = {};
  const ref = limitTruePeak(asBuffer([src]), opt).buffer.getChannelData(0);
  const blockSamples = Math.round(0.25 * sr);
  console.log('| のりしろ W | W ÷ L | いちばん大きいずれ | ずれた標本 | 通したあとの真のピーク |');
  console.log('| ---: | ---: | ---: | ---: | ---: |');
  for (const mul of [0, 0.5, 1, 2, 8, 32]) {
    const W = Math.round(look * mul);
    const out = overlapRun(src, W, blockSamples, opt);
    let max = 0;
    let n = 0;
    for (let i = 0; i < src.length; i += 1) {
      const d = Math.abs(out[i] - ref[i]);
      if (d > 0) n += 1;
      if (d > max) max = d;
    }
    const tp = 20 * Math.log10(truePeakOf(out));
    console.log(
      `| ${W} | ${mul} | ${max === 0 ? '**0（同じ）**' : max.toExponential(2)} | ${n} | ` +
        `${tp.toFixed(4)} dBTP${tp > DEFAULT_LIMITER.ceilingDb + 0.01 ? ' ← **天井を超えた**' : ''} |`,
    );
  }
  console.log(`\n一括の真のピーク: ${(20 * Math.log10(truePeakOf(ref))).toFixed(4)} dBTP（天井 ${DEFAULT_LIMITER.ceilingDb}）`);
}

console.log('\n**要るのりしろは素材で決まる。** 打点の間隔と戻りを振って、ずれが 0 になる W を探すと:\n');
{
  const material = (hitEvery) => {
    const length = Math.round(4 * sr);
    const a = new Float32Array(length);
    const period = Math.round(hitEvery * sr);
    for (let i = 0; i < length; i += 1) {
      const k = i % period;
      const hit = k < Math.round(0.004 * sr) ? 1.6 * Math.exp(-k / (0.0006 * sr)) : 0;
      a[i] = 0.3 * Math.sin((2 * Math.PI * 180 * i) / sr) + hit;
    }
    return a;
  };
  console.log('| 打点の間隔 | 戻り 5ms | 20ms | 50ms | 200ms |');
  console.log('| ---: | ---: | ---: | ---: | ---: |');
  for (const hitEvery of [0.11, 0.37, 0.8]) {
    const src = material(hitEvery);
    const cols = [];
    for (const releaseMs of [5, 20, 50, 200]) {
      const opt = { releaseMs, maxReductionDb: 12 };
      const ref = limitTruePeak(asBuffer([src]), opt).buffer.getChannelData(0);
      let found = null;
      for (let mul = 1; mul <= 1024 && found === null; mul *= 2) {
        const W = look * mul;
        if (W > src.length) break;
        const out = overlapRun(src, W, Math.round(0.25 * sr), opt);
        let same = true;
        for (let i = 0; i < src.length; i += 1) if (out[i] !== ref[i]) { same = false; break; }
        if (same) found = W;
      }
      cols.push(found === null ? '**見つからない**' : `L×${found / look}（${((found / sr) * 1000).toFixed(0)}ms）`);
    }
    console.log(`| ${hitEvery}s | ${cols.join(' | ')} |`);
  }
  console.log('\n（倍々に振って、最初にずれが 0 になった値。`L×1` が「注のとおりで足りた」の意味）');
}

// ---------- 3. メモリと時間 ----------

if (memory.skipped) {
  console.log('\n## 3. メモリと時間\n\nLAB_SKIP_MEM=1 なので飛ばしました。');
} else {
  const mb = (n) => `${(n / (1 << 20)).toFixed(0)}MB`;
  const own = (r) => Math.max(0, r.peak - r.floor);
  console.log('\n## 3. メモリと時間（別プロセスの `ru_maxrss` から、走り出しの床を引いたもの）\n');
  console.log('素材は `limit-signal.mjs` の合成波（0.8 秒ごとに天井を超える打点）。');
  console.log('**流す形は標本の列をどこにも持たない**（位置から値を直に作る）ので、');
  console.log('「丸ごと起こす」ぶんも含めた差が出る。\n');
  console.log('| 尺 | ch | 一括の山 | 流す形の山（区間 5s） | 何分の 1 | 一括の時間 | 流す形の時間 | 波 | 報告 |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const [seconds, channels, w, st] of memory.pairs) {
    const sameWave = w.hashes.length === st.hashes.length && w.hashes.every((h, i) => h === st.hashes[i]);
    const sameReport = JSON.stringify(w.report) === JSON.stringify(st.report);
    const ratio = own(st) > 0 ? (own(w) / own(st)).toFixed(1) : '—';
    console.log(
      `| ${seconds}s | ${channels} | ${mb(own(w))} | ${mb(own(st))} | ${ratio} | ` +
        `${w.ms}ms | ${st.ms}ms | ${sameWave ? '同じ' : '**ちがう**'} | ${sameReport ? '同じ' : '**ちがう**'} |`,
    );
  }
  console.log(`\n（何もしない子の山は ${mb(own(memory.floor))}。床は子自身が報告した値で引いてある）`);

  console.log('\n区間の長さを振る（尺 60 秒・1ch）。**メモリは区間で決まり、速さはほとんど動かない**:\n');
  console.log('| 区間 | 山 | 時間 |');
  console.log('| ---: | ---: | ---: |');
  for (const [blockSeconds, st] of memory.blocks) {
    console.log(`| ${blockSeconds}s | ${mb(own(st))} | ${st.ms}ms |`);
  }
}

// ---------- 4. 読む回数 ----------

console.log('\n## 4. `read` の呼ばれ方\n');
{
  const seconds = 20;
  for (const blockSeconds of [1, 5]) {
    const base = generatedSource(seconds, { sampleRate: sr, channels: 1 });
    const calls = [];
    const source = {
      ...base,
      read(from, to) {
        calls.push([from, to]);
        return base.read(from, to);
      },
    };
    limitTruePeakStream(source, () => {}, { blockSeconds });
    let back = 0;
    for (let i = 1; i < calls.length; i += 1) if (calls[i][0] < calls[i - 1][1]) back += 1;
    const read = calls.reduce((a, [f, t]) => a + (t - f), 0);
    console.log(
      `- 区間 ${blockSeconds}s: ${calls.length} 回・${read} 標本（素材は ${base.length} 標本。重ね読み ${read - base.length} 標本 ＝ ${((read / base.length - 1) * 100).toFixed(3)}%）・戻って読んだ回数 ${back}`,
    );
  }
  console.log('\n**同じ標本を二度読まない**（デコーダをそのまま繋げる）。のりしろは入れ物の中で持ち回している。');
}
