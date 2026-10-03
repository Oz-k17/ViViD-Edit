/**
 * 「繋いで測り直す」1 周を、**クリップごとの 0.1 秒ごとの二乗和**で代われるかを測る（2026-10-03・2 回目）。
 *
 *   npm run lab:fixtures          # 先に素材を作る
 *   npm run lab:clipmatch:carry
 *
 * ## これは何の続きか
 *
 * 2026-10-03（1 回目）に、クリップごとの音量合わせを流せるようにした。
 * 道すじ（クリップごとに測る → 揃えて繋ぐ → 全体を測る → 均す）は**素材を 3 周読む**。
 * そのうち 3 周めを「クリップごとの **LUFS** の足し算」で代われるかを測って、**代われなかった**
 * （相対ゲートがぜんたいの平均から線を引くので、部分の結果からは組み立て直せない）。
 *
 * **なら持ち出すのはゲートの手前**——窓にも dB にも掛ける前の 0.1 秒ごとの二乗和なら、
 * 繋いでからゲートを掛け直せる。費用は 0.1 秒あたり 8 バイト ＝ 1 時間で 288KB。
 * 倍率 g を当てた音の二乗和は、この列を **g² 倍**したもの（K 特性は線形）。
 *
 * ## 一致しない理由が 2 つ見当付いていたので、切り分けて測る
 *
 *   ①**K 特性の履歴がクリップの頭で切れる。** 繋いだ列なら前のクリップの終わりが
 *     IIR の履歴として入ってくるが、クリップごとに測ると毎回 0 から始まる。
 *     **倍率が違うと原理的に直せない**（履歴に乗っている倍率と、いま掛ける倍率が違う）。
 *   ②**0.1 秒の格子がクリップの頭で振り出しに戻る。** クリップの尺が 0.1 秒の倍数でないと
 *     升がずれ、さらに**クリップの末尾の端切れが丸ごと落ちる。**
 *     こちらは持ち出す側で手当てできる（`carryLead` ＋ `head` / `tail`）。
 *
 * 切り分けは**クリップの尺を 0.1 秒の倍数にするかどうか**で付く。倍数なら②が消えるので
 * 残った差が①。倍数でないときとの差が②。表では「素直」（②を手当てしない）と
 * 「格子」（手当てする）を並べてある。
 *
 * ③ 真のピークが繋ぎ目で立つ話（1 回目に 1.07dB と測った）も併せて見る。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';

const { measureLoudness, measureLoudnessStream, STEP_SECONDS } = await import('./src/lufs.ts');
const { blockSourceOf } = await import('./src/loudness.ts');
const { analyzeLoudness } = await import('./src/loudness.ts');
const { planJetCut } = await import('./src/silence.ts');
const {
  measureClips,
  measureClipsStream,
  planClipMatch,
  applyClipGains,
  applyClipGainSources,
  concatSources,
  clipCarryLeads,
  combineClipCarries,
  measureTimelineFromClips,
  joinTruePeak,
} = await import('./src/clip-match.ts');
const { limitTruePeakStream } = await import('./src/limiter.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../fixtures/out');

const dec = (v, n = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(n));
const num = (v, w) => String(v).padStart(w);
const pad = (v, w) => String(v).padEnd(w);

// ---------- 道具 ----------

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

/**
 * 1 通りぶんの突き合わせ。
 *
 * 倍率は `planClipMatch` が決めたものをそのまま使う（**実際に使われる倍率で測らないと意味が無い**ので、
 * ここで都合よく 1 倍にはしない）。測りを 2 回するのは、`carryLead` が並びで決まるため
 * ——「素直」は全部 0、「格子」は `clipCarryLeads`。
 */
const compare = (buffers, options = {}) => {
  const sr = buffers[0].sampleRate;
  const step = Math.max(1, Math.round(STEP_SECONDS * sr));
  const clips = buffers.map((buffer, i) => ({ id: `c${i}`, buffer }));

  const measured = measureClips(clips, options);
  const plan = planClipMatch(measured, {});
  const gains = plan.gains.map((g) => g.gain);

  const exact = measureLoudness(joinBuffers(applyClipGains(clips, plan)), options);

  // 「素直」= クリップごとの格子のまま並べる（lead は全部 0。末尾の端切れは落ちる）。
  const plain = measureClips(clips, { ...options, carryLead: 0 });
  const naive = combineClipCarries(
    plain.map((m, i) => ({
      carry: { ...m.measurement.carry, tail: 0, length: Math.floor(m.measurement.carry.length / step) * step },
      gain: gains[i],
      measurement: m.measurement,
    })),
  );

  // 「格子」= 繋いだ格子に載せて測り直す。
  const leads = clipCarryLeads(buffers.map((b) => b.length), step);
  const aligned = buffers.map((b, i) => measureLoudness(b, { ...options, carryLead: leads[i] }));
  const sources = buffers.map((b) => blockSourceOf(b));
  const carried = combineClipCarries(
    aligned.map((m, i) => ({ carry: m.carry, gain: gains[i], measurement: m })),
    { joinTruePeak: joinTruePeak(sources, gains) },
  );

  return { exact, naive, carried, gains, measured, aligned, sources };
};

const d = (a, b) => (a === null || b === null ? NaN : b - a);

const row = (label, buffers, options = {}) => {
  const { exact, naive, carried } = compare(buffers, options);
  console.log(
    `| ${pad(label, 24)} | ${num(dec(exact.integratedLufs), 8)} | ${num(dec(d(exact.integratedLufs, naive.integratedLufs)), 7)} | ` +
      `${num(dec(d(exact.integratedLufs, carried.integratedLufs)), 7)} | ` +
      `${num(dec(d(exact.momentaryMaxLufs, carried.momentaryMaxLufs)), 7)} | ` +
      `${num(dec(d(exact.shortTermMaxLufs, carried.shortTermMaxLufs)), 7)} | ` +
      `${num(exact.gatedBlocks, 4)} / ${num(carried.gatedBlocks, 4)} |`,
  );
  return { naive: d(exact.integratedLufs, naive.integratedLufs), carried: d(exact.integratedLufs, carried.integratedLufs) };
};

const head = (first = '並べ方') => {
  console.log(
    `| ${pad(first, 24)} | ${num('繋いで', 8)} | ${num('素直', 7)} | ${num('格子', 7)} | ${num('瞬間', 7)} | ${num('短期', 7)} | 窓 繋 / 格子 |`,
  );
  console.log(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
};

// ---------- 素材 ----------

const sr = 48000;
const step = Math.round(STEP_SECONDS * sr); // 4800
const bufOf = (d, rate = sr) => ({ sampleRate: rate, numberOfChannels: 1, length: d.length, getChannelData: () => d });

/**
 * 声らしく揺れる音。**正弦波だけで測るとゲートが 1 つも落ちない**ので、
 * ①②の効きが「ゲートの境目をまたぐかどうか」の形で出てこない。
 * 揺れと休みを入れて、窓ごとの値がばらつくようにしてある。
 */
const wobble = (seconds, amp, seed = 1) => {
  const L = Math.round(seconds * sr);
  const d = new Float32Array(L);
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
  for (let i = 0; i < L; i += 1) {
    const t = i / sr;
    const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.3 * t);
    const rest = t % 1.3 < 0.35 ? 0.02 : 1;
    const tone = Math.sin(2 * Math.PI * 180 * t) + 0.4 * Math.sin(2 * Math.PI * 540 * t);
    d[i] = amp * rest * syll * (0.75 * tone + 0.25 * rnd() * 2);
  }
  return bufOf(d);
};

/**
 * ①を**いちばん効かせる**ための素材。K 特性の 2 段目（38Hz の高域通過）は直流のすぐ近くに
 * 極があるので、**低い音と段差がいちばん長く尾を引く。** 25Hz を満振幅で入れ、
 * クリップの頭を必ず山の天辺から始める（＝履歴が一番効く向きの段差を作る）。
 */
const lowStep = (seconds, amp, hz = 25, phase = Math.PI / 2) => {
  const L = Math.round(seconds * sr);
  const d = new Float32Array(L);
  for (let i = 0; i < L; i += 1) d[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr + phase);
  return bufOf(d);
};

/** ちょうど 0.1 秒の倍数になる尺（②が消える）。 */
const exactLen = (blocks) => (blocks * step) / sr;

console.log('# 「繋いで測り直す」を 0.1 秒ごとの二乗和で代われるか（2026-10-03・2 回目）\n');
console.log(
  '「素直」＝ クリップごとの格子のまま並べる（末尾の端切れは落ちる）。' +
    '「格子」＝ 繋いだ格子に載せて持ち出す（`carryLead` ＋ `head`/`tail`）。数字はどちらも**繋いで測った値との差（LU）**。\n',
);

// ---------- 1. 尺を升にそろえたとき（②が消える。残るのは①だけ） ----------

console.log('## 1. 尺を 0.1 秒の倍数にそろえたとき（格子は合う。残るのは K 特性の履歴だけ）\n');
head('並べ方（尺は 0.1s の倍数）');
const aligned = [];
for (const n of [2, 4, 8, 16, 32]) {
  const blocks = Math.round(130 / n);
  aligned.push(row(`${n} 本 × ${exactLen(blocks).toFixed(1)}s 同じ`, Array.from({ length: n }, (_, i) => wobble(exactLen(blocks), 0.5, i + 1))));
}
console.log('');
for (const n of [2, 4, 8, 16, 32]) {
  const blocks = Math.round(130 / n);
  aligned.push(
    row(
      `${n} 本 × ${exactLen(blocks).toFixed(1)}s 20dB 差`,
      Array.from({ length: n }, (_, i) => wobble(exactLen(blocks), i % 2 === 0 ? 0.5 : 0.05, i + 1)),
    ),
  );
}

// ---------- 2. 尺が半端なとき（②が入る） ----------

console.log('\n## 2. 尺が 0.1 秒の倍数でないとき（格子がクリップの頭で振り出しに戻る）\n');
head('並べ方（尺は半端）');
const ragged = [];
for (const n of [2, 4, 8, 16, 32]) {
  const sec = exactLen(Math.round(130 / n)) + 0.047;
  ragged.push(row(`${n} 本 × ${sec.toFixed(3)}s 同じ`, Array.from({ length: n }, (_, i) => wobble(sec, 0.5, i + 1))));
}
console.log('');
for (const n of [2, 4, 8, 16, 32]) {
  const sec = exactLen(Math.round(130 / n)) + 0.047;
  ragged.push(
    row(
      `${n} 本 × ${sec.toFixed(3)}s 20dB 差`,
      Array.from({ length: n }, (_, i) => wobble(sec, i % 2 === 0 ? 0.5 : 0.05, i + 1)),
    ),
  );
}

console.log('\n**末尾の端切れだけを振る**（8 本に固定。「素直」が何で動いているかはここで見える）\n');
head('末尾の端切れ');
for (const extra of [0, 0.01, 0.025, 0.05, 0.075, 0.099]) {
  const sec = exactLen(16) + extra;
  row(`+${(extra * 1000).toFixed(0)}ms（${sec.toFixed(3)}s）`, Array.from({ length: 8 }, (_, i) => wobble(sec, 0.5, i + 1)));
}

// **落ちる端切れが、いちばん大きいところに当たる形。** 平らな素材だと端切れが落ちても
// 平均が動かないので、「素直」の被害が小さく見える。向きを変えた素材を 1 つ置いておく。
const backLoud = (seconds, amp) => {
  const L = Math.round(seconds * sr);
  const dd = new Float32Array(L);
  for (let i = 0; i < L; i += 1) dd[i] = amp * (i >= L - step ? 1 : 0.02) * Math.sin((2 * Math.PI * 400 * i) / sr);
  return bufOf(dd);
};
console.log('\n**後ろ 1 升だけ大きい素材**（落ちる端切れがそこに当たる。8 本固定）\n');
head('末尾の端切れ');
const cruel = [];
for (const extra of [0.2, 0.4, 0.6, 0.75, 0.9]) {
  const sec = (8 * step + Math.round(extra * step)) / sr;
  cruel.push(row(`+${(extra * 100).toFixed(0)}% 升（${sec.toFixed(3)}s）`, Array.from({ length: 8 }, () => backLoud(sec, 0.5))));
}
console.log(
  '\n**「素直」の被害の大きさは素材しだい。** 平らな素材なら 0.1 LU 級でも、' +
    '大きいところが端切れに当たると**桁が変わる**。\n' +
    '確かなのは数字の大きさではなく**升が減るという構造のほう**なので、そちらを検算に置いた。',
);

// ---------- 3. ①を潰しにいく素材 ----------

console.log('\n## 3. K 特性の履歴を、いちばん効く向きにいじめる（25Hz・頭から満振幅・尺は升ちょうど）\n');
head('クリップの尺（合計 13.0s）');
const worstK = [];
// 合計を 13 秒に固定して、1 本の尺だけを振る。**履歴の切れは繋ぎ目の数に比例するので、
// 短く刻むほど濃く出る。** どこから効き始めるかを見るのがこの段。
for (const blocks of [65, 26, 13, 8, 4, 2, 1]) {
  const n = Math.round(130 / blocks);
  worstK.push(
    row(`${exactLen(blocks).toFixed(2)}s × ${n} 本 25Hz`, Array.from({ length: n }, () => lowStep(exactLen(blocks), 0.9))),
  );
}
console.log('');
for (const blocks of [65, 26, 13, 8, 4, 2, 1]) {
  const n = Math.round(130 / blocks);
  worstK.push(
    row(
      `${exactLen(blocks).toFixed(2)}s × ${n} 本 25Hz 20dB 差`,
      Array.from({ length: n }, (_, i) => lowStep(exactLen(blocks), i % 2 === 0 ? 0.9 : 0.09)),
    ),
  );
}
console.log('\n同じ振り方を、**声らしく揺れる素材**で（こちらが現実に近い側）\n');
head('クリップの尺（合計 13.0s）');
const wobbleSweep = [];
for (const blocks of [65, 26, 13, 8, 4, 2, 1]) {
  const n = Math.round(130 / blocks);
  wobbleSweep.push(
    row(
      `${exactLen(blocks).toFixed(2)}s × ${n} 本 声`,
      Array.from({ length: n }, (_, i) => wobble(exactLen(blocks), i % 2 === 0 ? 0.5 : 0.05, i + 1)),
    ),
  );
}
console.log('\n**尺ではなく「音の高さ」で振る**（0.40s × 33 本に固定。頭から満振幅）\n');
head('音の高さ');
const byHz = [];
for (const hz of [25, 40, 60, 100, 200, 500, 1000]) {
  byHz.push(row(`${hz}Hz`, Array.from({ length: 33 }, () => lowStep(exactLen(4), 0.9, hz))));
}
console.log(
  '\n**効いているのは繋ぎ目の数ではなく、低い帯域にエネルギーがあるかどうか。**\n' +
    'K 特性の 2 段目は 38Hz の高域通過で、**極が直流のすぐ近くにある**ので尾がいちばん長い。\n' +
    '声らしく揺れる素材が 130 本に刻んでも 0.014 LU で済むのは、そこに置くものが無いから。\n' +
    '`clip-match` は 0.4 秒より短いクリップを触らない（`minDuration`）ので、' +
    '**尺の表のいちばん下の 2 行は道具の外**。',
);

// ---------- 4. 実素材 ----------

console.log('\n## 4. 実素材（`lab/fixtures/out`）\n');
const real = [];
{
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  const buffers = files.map((f) => readWav(path.join(dir, f)));
  const rate = buffers[0].sampleRate;
  const rstep = Math.round(STEP_SECONDS * rate);
  head('まとまり');
  // 素材はどれも 13.00 秒ちょうど＝升の倍数なので、そのままでは②が出ない。
  real.push(row(`43 本そのまま（${(buffers.reduce((s, b) => s + b.length, 0) / rate).toFixed(1)}s）`, buffers));

  // 現実のクリップは升の倍数にならない。自動カットが返す区間の長さで切り出す。
  const cut = [];
  for (const b of buffers) {
    const keep = planJetCut(analyzeLoudness(b), {}).keep;
    for (const r of keep) {
      const from = Math.max(0, Math.round(r.start * rate));
      const to = Math.min(b.length, Math.round(r.end * rate));
      if (to - from >= Math.round(0.4 * rate)) cut.push(bufOf(b.getChannelData(0).subarray(from, to), rate));
    }
  }
  const multiples = cut.filter((b) => b.length % rstep === 0).length;
  real.push(row(`自動カットの区間 ${cut.length} 本`, cut));
  console.log(
    `\n自動カットが返した ${cut.length} 本のうち、**尺が 0.1 秒の倍数なのは ${multiples} 本**` +
      `（${((multiples / cut.length) * 100).toFixed(0)}%）。**現実のクリップは升にそろわない。**`,
  );

  const { exact, carried, aligned: perClip, gains, sources } = compare(cut);
  let clipMax = 0;
  for (let i = 0; i < perClip.length; i += 1) {
    clipMax = Math.max(clipMax, Math.pow(10, (perClip[i].truePeakDb + 20 * Math.log10(gains[i])) / 20));
  }
  const jp = joinTruePeak(sources, gains);
  const db = (v) => 20 * Math.log10(v);
  console.log(
    `\n真のピーク: 繋いで **${dec(exact.truePeakDb, 4)}** dBTP / ` +
      `クリップごとの最大だけ **${dec(db(clipMax), 4)}**（${dec(db(clipMax) - exact.truePeakDb, 4)} dB）/ ` +
      `繋ぎ目を足して **${dec(carried.truePeakDb, 4)}**（${dec(carried.truePeakDb - exact.truePeakDb, 4)} dB）。` +
      `繋ぎ目をまたぐ窓だけで ${dec(db(jp), 4)} dBTP。`,
  );
}

// ---------- 5. 繋ぎ目の真のピークを拾えているか ----------

console.log('\n## 5. 繋ぎ目をまたぐ窓を、前後 11 標本だけで拾えているか\n');
{
  const mk = (seconds, amp, phase) => {
    const L = Math.round(seconds * sr);
    const dd = new Float32Array(L);
    for (let i = 0; i < L; i += 1) dd[i] = amp * Math.sin((2 * Math.PI * 997 * i) / sr + phase);
    return bufOf(dd);
  };
  console.log(`| 繋ぎ目の段差 | 繋いで測った | クリップごとの最大 | 繋ぎ目を足して | 残る差 |`);
  console.log(`| --- | ---: | ---: | ---: | ---: |`);
  for (const phase of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const buffers = [mk(1, 0.9, 0), mk(1, 0.9, phase)];
    const { exact, carried, aligned: perClip, gains } = compare(buffers);
    let clipMax = -Infinity;
    for (let i = 0; i < perClip.length; i += 1) clipMax = Math.max(clipMax, perClip[i].truePeakDb + 20 * Math.log10(gains[i]));
    console.log(
      `| 位相差 ${(phase / Math.PI).toFixed(2)}π | ${dec(exact.truePeakDb, 4)} dBTP | ${dec(clipMax, 4)} dBTP ` +
        `(${dec(clipMax - exact.truePeakDb, 4)}) | ${dec(carried.truePeakDb, 4)} dBTP | ${dec(carried.truePeakDb - exact.truePeakDb, 4)} dB |`,
    );
  }
  console.log(
    '\n**1 回目に測った 1.07dB の穴は、前後 11 標本を打ち直すだけで塞がる**' +
      '（窓は 12 標本しか見ないので、またぐ窓を数えるのに要るのはそれだけ）。',
  );
}

// ---------- 6. 本当に 1 周減ったか ----------

console.log('\n## 6. 読んだ標本を数える（3 周 → 2 周になったか）\n');
{
  const counted = (source) => {
    let reads = 0;
    return {
      get reads() {
        return reads;
      },
      source: {
        sampleRate: source.sampleRate,
        numberOfChannels: source.numberOfChannels,
        length: source.length,
        read(from, to) {
          reads += (to - from) * source.numberOfChannels;
          return source.read(from, to);
        },
      },
    };
  };
  const buffers = Array.from({ length: 12 }, (_, i) => wobble(2.3 + i * 0.13, 0.5 - (i % 3) * 0.15, i + 1));
  const totalSamples = buffers.reduce((a, b) => a + b.length, 0);

  const run = (withCarry) => {
    const wrapped = buffers.map((b) => counted(blockSourceOf(b)));
    const clips = wrapped.map((w, i) => ({ id: `c${i}`, source: w.source }));
    const measured = measureClipsStream(clips, withCarry ? { carryForTimeline: true } : {});
    const plan = planClipMatch(measured, {});
    const timeline = withCarry
      ? measureTimelineFromClips(measured, plan, {
          joinTruePeak: joinTruePeak(clips.map((c) => c.source), plan.gains.map((g) => g.gain)),
        })
      : measureLoudnessStream(concatSources(applyClipGainSources(clips, plan)), {});
    // 均す段（どちらの道でも 1 周）。
    limitTruePeakStream(concatSources(applyClipGainSources(clips, plan)), () => {}, {});
    return { reads: wrapped.reduce((a, w) => a + w.reads, 0), timeline };
  };

  const three = run(false);
  const two = run(true);
  console.log(`| 道すじ | 読んだ標本 | 何周 | 全体 |`);
  console.log(`| --- | ---: | ---: | ---: |`);
  console.log(`| 繋いで測り直す | ${three.reads} | ${(three.reads / totalSamples).toFixed(2)} | ${dec(three.timeline.integratedLufs)} LUFS |`);
  console.log(`| 二乗和を持ち出す | ${two.reads} | ${(two.reads / totalSamples).toFixed(2)} | ${dec(two.timeline.integratedLufs)} LUFS |`);
  console.log(
    `\n差は **${dec(two.timeline.integratedLufs - three.timeline.integratedLufs)} LU**。` +
      `はみ出した ${two.reads - totalSamples * 2} 標本は**繋ぎ目の打ち直し**` +
      `（繋ぎ目 ${buffers.length - 1} か所 × 前後 11 標本 × 2）。**1 周の 0.007% で、1 周ぶんの読み直しが消える。**`,
  );
}

// ---------- まとめ ----------

const worst = (xs, k) => Math.max(...xs.map((x) => Math.abs(x[k])));
console.log(
  `\n## まとめ\n\n` +
    `| 何を測ったか | 素直に繋ぐ | 格子を合わせる |\n` +
    `| --- | ---: | ---: |\n` +
    `| 尺が升の倍数（＝ K 特性の履歴だけ） | ${dec(worst(aligned, 'naive'))} LU | **${dec(worst(aligned, 'carried'))} LU** |\n` +
    `| 尺が半端（＝ ＋格子のずれ） | ${dec(worst(ragged, 'naive'))} LU | **${dec(worst(ragged, 'carried'))} LU** |\n` +
    `| 端切れが大きいところに当たる | ${dec(worst(cruel, 'naive'))} LU | **${dec(worst(cruel, 'carried'))} LU** |\n` +
    `| 低い音で履歴をいじめる（25Hz 満振幅） | ${dec(worst(worstK, 'naive'))} LU | **${dec(worst(worstK, 'carried'))} LU** |\n` +
    `| 同じ振り方・声らしい素材 | ${dec(worst(wobbleSweep, 'naive'))} LU | **${dec(worst(wobbleSweep, 'carried'))} LU** |\n` +
    `| 音の高さで振る（0.4s × 33 本） | ${dec(worst(byHz, 'naive'))} LU | **${dec(worst(byHz, 'carried'))} LU** |\n` +
    `| 実素材 | ${dec(worst(real, 'naive'))} LU | **${dec(worst(real, 'carried'))} LU** |\n`,
);
