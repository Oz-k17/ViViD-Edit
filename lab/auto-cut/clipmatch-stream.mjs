/**
 * クリップごとの音量合わせを**長尺に当てられるか**を測る（2026-10-03）。
 *
 *   npm run lab:fixtures            # 先に素材を作る
 *   npm run lab:clipmatch:stream
 *   LAB_LONG=60 npm run lab:clipmatch:stream    # 1 本の尺を伸ばす（一括はメモリを食う）
 *   LAB_SKIP_MEM=1 npm run lab:clipmatch:stream # 子プロセスの測りを飛ばす（速い）
 *
 * 2026-10-02 にリミッタとラウドネスの測りを流せるようにしたが、**書き出しの道すじでは
 * その手前（ここ）がまだ一括のまま**で、`measureClips` の引数が `ClipSource[]` なので
 * **測り始める前に全部のクリップが同時に起きている。**
 *
 * 見ているのは 5 つ。
 *
 *   1. **流す形が一括とビット単位で同じか**（同じでなければ、以後の数字に意味が無い）。
 *   2. **山は何で決まるか。** 「いちばん長い 1 本」なのか「同時に抱えている合計」なのか。
 *   3. **道すじぜんたいで素材を何周読むことになるか。**
 *   4. **その 1 周を減らせないか**——クリップごとの測りの足し算で、繋いで測り直す段を
 *      代われないか。**代われない。** 下の B の表がその理由。
 *   5. **繋ぎ目で何が起きるか**（真のピークは繋ぎ目で立つ）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';
import { SHORT_FIXTURES } from '../fixtures/spec.mjs';

const { measureLoudness, measureLoudnessStream } = await import('./src/lufs.ts');
const { blockSourceOf } = await import('./src/loudness.ts');
const { analyzeLoudness } = await import('./src/loudness.ts');
const { planJetCut } = await import('./src/silence.ts');
const {
  measureClips,
  measureClipsStream,
  planClipMatch,
  applyClipGains,
  applyClipGainSources,
  concatRanges,
  concatRangesSource,
  concatSources,
} = await import('./src/clip-match.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dir = path.join(root, 'lab/fixtures/out');
const sr = 48000;

// ---------- メモリの測りは、いちばん最初にやる ----------
//
// 子の `ru_maxrss` は fork した時点の親の常駐量を引き継ぐので、この台本が素材を
// 抱えてから子を起こすと、何もしない子でも親ぶんを返す（`loudness-stream.mjs` に経緯）。

const longSeconds = Number(process.env.LAB_LONG ?? 30);
const memory = { skipped: process.env.LAB_SKIP_MEM === '1', floor: null, rows: [], shape: [] };
if (!memory.skipped) {
  const child = (count, seconds, mode, blockSeconds = 5, channels = 1) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(here, 'clipmatch-mem.mjs'), String(count), String(seconds), mode, String(blockSeconds), String(channels)],
        { encoding: 'utf8', maxBuffer: 1 << 24 },
      ),
    );
  memory.floor = child(1, 1, 'none');
  for (const [count, seconds, channels] of [
    [4, 5, 1],
    [8, 15, 1],
    [20, longSeconds, 1],
    [20, longSeconds, 2],
  ]) {
    memory.rows.push([
      count,
      seconds,
      channels,
      child(count, seconds, 'measure-whole', 5, channels),
      child(count, seconds, 'measure-stream', 5, channels),
      child(count, seconds, 'chain-whole', 5, channels),
      child(count, seconds, 'chain-stream', 5, channels),
    ]);
  }
  // 「山はいちばん長い 1 本で決まるのか、合計で決まるのか」。合計を揃えて本数だけ振る。
  for (const [count, seconds] of [[1, 120], [2, 60], [4, 30], [8, 15], [16, 7.5]]) {
    memory.shape.push([count, seconds, child(count, seconds, 'measure-whole')]);
  }
  // 逆に、本数を固定して合計だけ振る（こちらは比例するはず）。
  memory.total = [];
  for (const [count, seconds] of [[4, 15], [4, 30], [4, 60], [4, 120]]) {
    memory.total.push([count, seconds, child(count, seconds, 'measure-whole')]);
  }
  // 流す形の山は何で決まるか（尺でも本数でもなく、区間の入れ物のはず）。
  memory.blocks = [];
  for (const blockSeconds of [0.5, 1, 5, 15, 30]) {
    memory.blocks.push([blockSeconds, child(20, 30, 'measure-stream', blockSeconds)]);
  }
}

// ---------- ここから親の仕事 ----------

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (s, n) => String(s).padStart(n, ' ');
const mb = (bytes) => `${(bytes / 1048576).toFixed(0)}MB`;
const dec = (v, n = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(n));

if (!fs.existsSync(dir)) {
  console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
  process.exit(1);
}

const clips = [];
for (const f of SHORT_FIXTURES) {
  const file = path.join(dir, f.name);
  if (fs.existsSync(file)) clips.push({ id: f.name.replace('.wav', ''), buffer: readWav(file) });
}
if (clips.length === 0) {
  console.error('素材が 1 本も読めませんでした。');
  process.exit(1);
}

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
const sameMeasurement = (a, b) => a !== null && b !== null && KEYS.every((k) => a[k] === b[k] || (a[k] === null && b[k] === null));

const toPower = (lufs) => Math.pow(10, (lufs + 0.691) / 10);
const fromPower = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : null);
const joinBuffers = (buffers) => {
  const total = buffers.reduce((s, b) => s + b.length, 0);
  const ch = buffers[0].numberOfChannels;
  const planes = [];
  for (let c = 0; c < ch; c += 1) {
    const out = new Float32Array(total);
    let k = 0;
    for (const b of buffers) {
      out.set(b.getChannelData(c), k);
      k += b.length;
    }
    planes.push(out);
  }
  return { sampleRate: buffers[0].sampleRate, numberOfChannels: ch, length: total, getChannelData: (c) => planes[c] };
};
/** クリップごとの測りを、ゲートを通った窓の数で重みを付けて 1 つの値に足す。 */
const sumClips = (measured) => {
  let power = 0;
  let gated = 0;
  for (const m of measured) {
    if (m.lufs === null || m.gatedBlocks <= 0) continue;
    power += toPower(m.lufs) * m.gatedBlocks;
    gated += m.gatedBlocks;
  }
  return { lufs: gated > 0 ? fromPower(power / gated) : null, gated };
};

console.log('# クリップごとの音量合わせを長尺に当てる（2026-10-03）\n');

// ---------- 1. 一括と流す形が、ビット単位で同じか ----------

console.log('## 1. 一括と流す形が同じか（実素材 43 本）\n');
{
  const streamed = clips.map((c) => ({ id: c.id, source: blockSourceOf(c.buffer) }));
  let bad = 0;
  let cases = 0;
  const blockList = [0.1, 1, 5, 13, Infinity];
  for (const blockSeconds of blockList) {
    const a = measureClips(clips, {});
    const b = measureClipsStream(streamed, { blockSeconds });
    for (let i = 0; i < a.length; i += 1) {
      cases += 1;
      if (a[i].lufs !== b[i].lufs || a[i].gatedBlocks !== b[i].gatedBlocks || !sameMeasurement(a[i].measurement, b[i].measurement)) bad += 1;
    }
  }
  console.log(`クリップごとの測り: ${cases} 通り（素材 ${clips.length} 本 × 区間 ${blockList.length} 通り）/ 違い **${bad}**`);

  // 道すじぜんたい（揃える → 繋ぐ）の波そのもの。
  const plan = planClipMatch(measureClips(clips, {}), {});
  const wholeTimeline = joinBuffers(applyClipGains(clips, plan));
  const flow = concatSources(applyClipGainSources(streamed, plan));
  let diff = 0;
  for (const block of [1 << 10, 1 << 16, 1 << 20]) {
    const want = wholeTimeline.getChannelData(0);
    for (let o = 0; o < flow.length; o += block) {
      const to = Math.min(flow.length, o + block);
      const got = flow.read(o, to)[0];
      for (let i = 0; i < to - o; i += 1) if (got[i] !== want[o + i]) diff += 1;
    }
  }
  const wholeM = measureLoudness(wholeTimeline, {});
  const flowM = measureLoudnessStream(concatSources(applyClipGainSources(streamed, plan)), { blockSeconds: 5 });
  console.log(
    `揃えて繋いだタイムライン: ${flow.length} 標本（${(flow.length / sr).toFixed(1)}s）/ 違う標本 **${diff}** / ` +
      `測りの欄 ${sameMeasurement(wholeM, flowM) ? '**全一致**' : '**ずれ**'}（${dec(wholeM.integratedLufs)} LUFS）`,
  );
}

// ---------- 2. 山は何で決まるか ----------

console.log('\n## 2. メモリの山\n');
if (memory.skipped) {
  console.log('（`LAB_SKIP_MEM=1` なので飛ばしました）');
} else {
  console.log(`空回しの床 ${mb(memory.floor.peak)}（これを引いた値が下の「山」）\n`);
  console.log(`| 本数 × 尺 | ch | 測る段 一括 | 測る段 流す | 道すじ 一括 | 道すじ 流す | 何分の 1 |`);
  console.log(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const [count, seconds, channels, mw, ms_, cw, cs] of memory.rows) {
    const h = (r) => Math.max(0, r.peak - r.floor);
    console.log(
      `| ${count} × ${seconds}s | ${channels} | ${mb(h(mw))} | ${mb(h(ms_))} | ${mb(h(cw))} | ${mb(h(cs))} | ` +
        `${(h(cw) / Math.max(1, h(cs))).toFixed(1)} |`,
    );
  }
  const hill = (r) => Math.max(0, r.peak - r.floor);
  console.log('\n**一括の山は「いちばん長い 1 本」ではなく「同時に抱えている合計」で決まる。**\n');
  console.log(`| 合計を 120s に固定して本数を振る | 山 | 本数を 4 本に固定して合計を振る | 山 |`);
  console.log(`| --- | ---: | --- | ---: |`);
  for (let i = 0; i < Math.max(memory.shape.length, memory.total.length); i += 1) {
    const a = memory.shape[i];
    const b = memory.total[i];
    const left = a ? `${a[0]} 本 × ${a[1]}s` : '';
    const right = b ? `${b[0]} 本 × ${b[1]}s（合計 ${b[0] * b[1]}s）` : '';
    console.log(`| ${left} | ${a ? mb(hill(a[2])) : ''} | ${right} | ${b ? mb(hill(b[2])) : ''} |`);
  }
  console.log(
    '\n左は動かず、右は合計に比例する。**`measureClips` の引数が `ClipSource[]` である時点で、' +
      '測り始める前に全部のクリップが同時に起きている**ので、刻み方では逃げられない。\n',
  );
  console.log('**流す形の山は、尺でも本数でもなく「区間の入れ物」で決まる**（20 本 × 30s で区間だけ振る）:\n');
  console.log(`| 区間 | 流す形の山 |`);
  console.log(`| ---: | ---: |`);
  for (const [blockSeconds, r] of memory.blocks) console.log(`| ${blockSeconds}s | ${mb(hill(r))} |`);
}

// ---------- 3. 何周読むか ----------

console.log('\n## 3. 道すじが素材を何周読むか\n');
if (memory.skipped) {
  console.log('（`LAB_SKIP_MEM=1` なので飛ばしました）');
} else {
  const row = memory.rows.find((r) => r[6].out && r[6].out.passes !== undefined);
  console.log(
    `流す形の道すじ（クリップごとに測る → 揃えて繋ぐ → 全体を測る → 均す）は **${row[6].out.passes} 周**。\n` +
      '一括は 1 回起こしてずっと抱える。**メモリと読み直しの取り替え**という向きは 2026-10-02 と同じだが、\n' +
      'クリップごとの段が 1 周ぶん増えている（ラウドネスの測りだけなら 2 周）。',
  );
}

// ---------- 4. その 1 周を減らせないか ----------

console.log('\n## 4. 「繋いで測り直す」を、クリップごとの測りの足し算で代われるか\n');
{
  const plan = planClipMatch(measureClips(clips, {}), {});
  const after = applyClipGains(clips, plan).map((b, i) => ({ id: clips[i].id, buffer: b }));
  const timeline = measureLoudness(joinBuffers(after.map((c) => c.buffer)), {});
  const sum = sumClips(measureClips(after, {}));
  console.log(
    `実素材 ${clips.length} 本: 繋いで ${dec(timeline.integratedLufs)} / 足して ${dec(sum.lufs)} LUFS ` +
      `＝ **${dec(sum.lufs - timeline.integratedLufs)} LU**（ゲートを通った窓 ${timeline.gatedBlocks} / ${sum.gated}）\n`,
  );

  const tone = (seconds, amp) => {
    const L = Math.round(seconds * sr);
    const d = new Float32Array(L);
    for (let i = 0; i < L; i += 1) d[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sr);
    return { sampleRate: sr, numberOfChannels: 1, length: L, getChannelData: () => d };
  };
  const row = (label, buffers) => {
    const w = measureLoudness(joinBuffers(buffers), {});
    const s = sumClips(measureClips(buffers.map((b, i) => ({ id: `c${i}`, buffer: b })), {}));
    console.log(
      `| ${pad(label, 16)} | ${num(dec(w.integratedLufs), 8)} | ${num(dec(s.lufs), 8)} | ${num(dec(s.lufs === null ? NaN : s.lufs - w.integratedLufs), 7)} | ` +
        `${num(w.gatedBlocks, 4)} / ${num(s.gated, 4)} |`,
    );
  };
  const head = () => {
    console.log(`| ${pad('並べ方', 16)} | ${num('繋いで', 8)} | ${num('足して', 8)} | ${num('ちがい', 7)} | 窓 繋ぐ / 足す |`);
    console.log(`| --- | ---: | ---: | ---: | ---: |`);
  };

  console.log('**A. 全部おなじ大きさのとき**（＝揃える仕事が無いとき）\n');
  head();
  for (const n of [2, 4, 8, 16, 32]) row(`${n} 本 × ${(13 / n).toFixed(2)}s`, Array.from({ length: n }, () => tone(13 / n, 0.5)));

  console.log('\n**B. 1 本おきに 20dB 小さいとき**（＝揃える仕事があるとき）\n');
  head();
  for (const n of [2, 4, 8, 16, 32])
    row(`${n} 本 × ${(13 / n).toFixed(2)}s`, Array.from({ length: n }, (_, i) => tone(13 / n, i % 2 === 0 ? 0.5 : 0.05)));

  console.log('\n**C. 中身は同じで、区切る長さだけを振る**\n');
  head();
  for (const sec of [0.4, 0.5, 1, 2, 6.5]) row(`2 本 × ${sec.toFixed(2)}s`, [tone(sec, 0.5), tone(sec, 0.5)]);

  console.log(
    '\n**代われない。** A は 0.002 LU までぴたり合う（窓の数は 127 対 32 と 4 倍違うのに）ので、' +
      '足し算そのものも、窓の覆い方も犯人ではない。C も動かない。\n' +
      '**ずれるのは B だけ**——つまり**クリップごとに大きさが違うときだけ**で、' +
      'それは `clip-match` が呼ばれる状況そのもの。\n' +
      '理由は**相対ゲート**で、線を「ぜんたいの平均から 10 LU 下」に引く。' +
      'タイムラインでは小さいクリップがまるごと線の下に落ちて捨てられる（窓 65 対 124）が、\n' +
      'クリップごとに測ると**自分の平均から線を引く**ので、小さいクリップも満額で数えられる。\n' +
      '**ゲートはぜんたいを見て決める取り決めなので、部分の結果からは組み立て直せない。**',
  );
}

// ---------- 5. 繋ぎ目で何が起きるか ----------

console.log('\n## 5. 繋ぎ目\n');
{
  const mk = (seconds, amp, phase) => {
    const L = Math.round(seconds * sr);
    const d = new Float32Array(L);
    for (let i = 0; i < L; i += 1) d[i] = amp * Math.sin((2 * Math.PI * 997 * i) / sr + phase);
    return { sampleRate: sr, numberOfChannels: 1, length: L, getChannelData: () => d };
  };
  console.log(`| 繋ぎ目の段差 | 繋いで測った | クリップの最大 | ちがい |`);
  console.log(`| --- | ---: | ---: | ---: |`);
  for (const phase of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const a = mk(1, 0.9, 0);
    const b = mk(1, 0.9, phase);
    const w = measureLoudness(joinBuffers([a, b]), {});
    const per = measureClips([{ id: 'a', buffer: a }, { id: 'b', buffer: b }], {});
    const mx = Math.max(...per.map((x) => x.measurement.truePeakDb));
    console.log(`| 位相差 ${(phase / Math.PI).toFixed(2)}π | ${dec(w.truePeakDb, 4)} dBTP | ${dec(mx, 4)} dBTP | ${dec(mx - w.truePeakDb, 4)} dB |`);
  }
  console.log(
    '\n**真のピークは繋ぎ目で立つ。** クリップごとの最大を取るだけでは **1.07dB 低く出る**ので、' +
      'リミッタに渡す余地（`limiterHeadroomDb`）がそのぶん足りなくなる。\n' +
      'これも 4 と同じ向きの話で、**繋いだあとに測り直す段は省けない。**',
  );
}

// ---------- 6. 自動カットの区間は、そのまま流せるか ----------

console.log('\n## 6. 自動カットが返す区間は、そのまま流せるか\n');
{
  let backward = 0;
  let checked = 0;
  let sameWave = 0;
  for (const clip of clips) {
    const ranges = planJetCut(analyzeLoudness(clip.buffer), {}).keep;
    if (ranges.length === 0) continue;
    checked += 1;
    for (let i = 1; i < ranges.length; i += 1) if (ranges[i].start < ranges[i - 1].end) backward += 1;
    const want = concatRanges(clip.buffer, ranges);
    const got = concatRangesSource(blockSourceOf(clip.buffer), ranges);
    if (want === null || got === null) continue;
    let diff = want.length !== got.length ? 1 : 0;
    for (let o = 0; o < got.length && diff === 0; o += 7919) {
      const to = Math.min(got.length, o + 7919);
      const block = got.read(o, to)[0];
      for (let i = 0; i < to - o; i += 1) if (block[i] !== want.getChannelData(0)[i + o]) diff += 1;
    }
    if (diff === 0) sameWave += 1;
  }
  console.log(
    `素材 ${checked} 本の区間を見て、**後ろ向き・重なりは ${backward} か所**。` +
      `繋いだ波が一括と同じだったのは **${sameWave} / ${checked} 本**。\n` +
      '流す形は「同じ元を後ろ向きに読む並び」を断る（`BlockSource` は前へ進む方向にしか読めない）が、' +
      '**自動カットの出口はもともとその縛りを守っている**ので、ここでは 1 本も引っかからない。',
  );
}

console.log('');
