/**
 * 素材の**要る範囲だけを起こす**形を測る。
 *
 *   npm run lab:export:range
 *   LAB_RG_ASSET=60 npm run lab:export:range     # ブラウザで焼く素材の尺（秒）
 *   LAB_RG_REPEAT=3 npm run lab:export:range     # 繰り返す回数（中央値を取る）
 *
 * ## 2 段ある（`audio.mjs` と同じ形）
 *
 * 1. **数え上げ**（ブラウザ不要）。何秒・何バイト起こすか、区間が何本になるか。
 *    素材と端末に依らないので、そのまま記録として持ち越せる。
 * 2. **実測**（ブラウザ）。本物の WebM / Opus を `AudioBufferSink.buffers(from, to)` で
 *    範囲読みして、時間・バイト・**波が丸ごとと同じか**を見る。
 *
 * ## なぜこれを測るのか
 *
 * 9/26（3 回目）に音の先払いを測って、**本命の壁がミックスではなく
 * 素材まるごとのデコードだった**と分かった（1 時間の素材から 10 秒切り出すだけで 1318MB）。
 * ミックスを窓に割ってもここは 1 バイトも減らない。減らせるのは範囲読みだけ。
 *
 * ## 48kHz でない素材と、速さを変えたクリップは別の probe
 *
 * ここは **48kHz / Opus / 速さ 1** だけを測る（9/30・1 回目に入れたときの形をそのまま保つため）。
 * 標本の速さとクリップの速さを振るのは `npm run lab:export:rate`（`rate-probe.mjs`）で、
 * そこで**「返ってきた時刻も容器の粒で丸めてある」**ことと
 * **「96kHz × 速さ 1 未満では読む源の秒が 2 倍要る」**ことが出ている（9/30・2 回目）。
 *
 * ## 自分の手を潰す素材
 *
 * 範囲読みがいちばん得をするのは「長い素材から少しだけ」。本体が実際に作るのはその逆で、
 * **無音カットは 1 本の長い素材から短い山を大量に拾う**（`jetCutSequence` がその形）。
 * 区間が散るほど、のりしろの取り分と頭出しの回数が増える。両方並べる。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const { splitAudioSequence } = await import('./src/audio-mix.ts');
const { jetCutSequence, planAssetDecodes, summarizeRangeCost } = await import('./src/audio-ranges.ts');

const assetSeconds = Number(process.env.LAB_RG_ASSET ?? 60);
const repeat = Number(process.env.LAB_RG_REPEAT ?? 3);
if (!(assetSeconds > 0)) throw new Error(`LAB_RG_ASSET は正の数です（${assetSeconds}）`);

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const mid = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// ---------- 1. 数え上げ（ブラウザ不要） ----------

console.log('素材の要る範囲だけを起こす ・ 48kHz 2ch として数える\n');
console.log('## 丸ごと 対 範囲（助走 0.5 秒 ・ 後ろ 0.05 秒 ・ 隙間 1 秒まで畳む）\n');
console.log(
  `${pad('形', 30)}${right('使う秒', 9)}${right('丸ごと', 10)}${right('範囲', 9)}${right('区間', 7)}${right('丸ごと ÷ 範囲', 15)}`,
);
const shapes = [
  ['13 秒の素材を丸ごと', splitAudioSequence({ seconds: 13, assetSeconds: 13 })],
  ['10 分の素材から 10 秒', splitAudioSequence({ seconds: 10, assetSeconds: 600 })],
  ['1 時間の素材から 10 秒', splitAudioSequence({ seconds: 10, assetSeconds: 3600 })],
  ['1 時間の素材から 5 分', splitAudioSequence({ seconds: 300, assetSeconds: 3600, pieces: 30 })],
  ['ジェットカット・残す 1/4（10 分）', jetCutSequence({ assetSeconds: 600, takeSeconds: 2, keepRatio: 0.25 })],
  ['ジェットカット・残す 1/2（10 分）', jetCutSequence({ assetSeconds: 600, takeSeconds: 2, keepRatio: 0.5 })],
  ['ジェットカット・残す 1/4（1 時間）', jetCutSequence({ assetSeconds: 3600, takeSeconds: 2, keepRatio: 0.25 })],
];
for (const [label, sequence] of shapes) {
  const stats = summarizeRangeCost(sequence);
  console.log(
    `${pad(label, 30)}${right(`${stats.readSeconds.toFixed(0)}s`, 9)}${right(mib(stats.wholeBytes), 10)}${right(mib(stats.rangeBytes), 9)}${right(`${stats.parts} 本`, 7)}${right(`${stats.ratio.toFixed(1)} 倍`, 15)}`,
  );
}
console.log(
  '\n**得の大きさは「素材の尺 ÷ 使う秒」で決まる。**\n' +
    'ジェットカットした形は「使う秒」自体が素材の 4 分の 1〜2 分の 1 なので、**得は 2〜4 倍で頭打ち**。\n',
);

console.log('## 助走と畳む幅（ジェットカット・残す 1/4・10 分の素材・1 山 2 秒）\n');
console.log(`${pad('助走', 8)}${pad('後ろ', 8)}${pad('畳む幅', 10)}${right('区間', 7)}${right('起こす秒', 10)}${right('読む秒の何倍', 14)}`);
const jet = jetCutSequence({ assetSeconds: 600, takeSeconds: 2, keepRatio: 0.25 });
for (const [prerollSeconds, tailSeconds] of [
  [0, 0],
  [0.25, 0.25],
  [0.5, 0.05],
  [0.5, 0.5],
]) {
  for (const mergeGapSeconds of [0, 1, 6, 30]) {
    const stats = summarizeRangeCost(jet, { prerollSeconds, tailSeconds, mergeGapSeconds });
    console.log(
      `${pad(`${prerollSeconds}s`, 8)}${pad(`${tailSeconds}s`, 8)}${pad(`${mergeGapSeconds}s`, 10)}${right(`${stats.parts} 本`, 7)}${right(`${stats.rangeSeconds.toFixed(0)}s`, 10)}${right(`${(stats.rangeSeconds / stats.readSeconds).toFixed(2)} 倍`, 14)}`,
    );
  }
}
const plan = planAssetDecodes(jet, { prerollSeconds: 0, tailSeconds: 0, mergeGapSeconds: 0 })[0];
console.log(
  `\n1 山 2 秒・隙間 6 秒の形なので、**畳む幅が隙間に届くと全部 1 本になる**（区間 ${plan.ranges.length} 本 → 1 本）。\n` +
    '余分に起こす取り分は `(助走 ＋ 後ろ) ÷ 山の長さ`。**山が短いほど不利**で、\n' +
    '既定（0.5 ＋ 0.05）・2 秒の山で 1.28 倍。前後を対称に 0.5 ずつ足すと 1.50 倍になる。\n' +
    '**前後で理由が違うので対称にしない**（前は助走・後ろは覆いの余裕。下の実測がその根拠）。\n',
);

// ---------- 2. 実測（ブラウザ） ----------

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので実測は飛ばします（数え上げは上に出ています）。');
  process.exit(0);
}

const server = await serve(here);
const browser = await launch(playwright);
let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

try {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.addScriptTag({ type: 'module', url: './testkit/audio-range.ts' });
  await page.waitForFunction(() => typeof window.__labRangeMeasure === 'function', null, { timeout: 60000 });

  const run = (options) => page.evaluate((o) => window.__labRangeMeasure(o), { assetSeconds, ...options });

  /** 設定を**交互に**回して、それぞれの中央値を返す（`audio.mjs` の `runInterleaved` と同じ）。 */
  const runInterleaved = async (cases, rounds = repeat) => {
    for (const c of cases) await run(c);
    const got = cases.map(() => []);
    for (let round = 0; round < rounds; round += 1) {
      const order = cases.map((_, i) => (round % 2 === 0 ? i : cases.length - 1 - i));
      for (const i of order) got[i].push(await run(cases[i]));
    }
    return got.map((runs) => {
      const byStage = {};
      for (const key of ['decodeMs', 'mixMs']) byStage[key] = mid(runs.map((r) => r[key]));
      // **振れ幅も一緒に出す。** 同じ計画の設定どうしで 30% 動くなら、
      // その測りでは 1.3 倍未満の差は読めない（9/26・2 回目に固めて測って踏んだ形の裏返し）。
      const decodes = runs.map((r) => r.decodeMs);
      return { ...runs[0], ...byStage, spread: (Math.max(...decodes) - Math.min(...decodes)) / mid(decodes) };
    });
  };

  /**
   * 指紋を区画ごとに突き合わせる。返すのは**開きがいちばん大きかった区画**の値と、違う区画の数。
   * 平均へ畳まない（9/26・2 回目に映像の側で、平均に畳むと 1 コマずれた相手が素通りした）。
   */
  const compare = (a, b) => {
    if (a.length !== b.length || a.length === 0) return { blocks: 0, worst: Infinity, differing: Infinity };
    let worst = 0;
    let differing = 0;
    for (let i = 0; i < a.length; i += 2) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]));
      if (d > worst) worst = d;
      // 16bit の 1 段（1/32768 ≒ 3e-5）より大きい開きを「違う」と数える。
      if (d > 3e-5) differing += 1;
    }
    return { blocks: a.length / 2, worst, differing };
  };

  // 素材を焼くのは 1 回目で済ませる（焼く時間が起こす時間に混ざらないように）。
  await run({ mode: 'whole' });

  console.log(`## 実測（${assetSeconds} 秒の WebM / Opus ・ 交互に回した中央値）\n`);
  console.log(
    `${pad('形', 26)}${pad('やり方', 10)}${right('起こす ms', 11)}${right('混ぜる ms', 11)}${right('起こす秒', 10)}${right('抱える', 9)}${right('区間', 7)}${right('載らない', 10)}`,
  );
  const cases = [
    ['素材の中を順に 13 秒', { shape: 'split', seconds: 13, pieces: 1, mode: 'whole' }],
    ['素材の中を順に 13 秒', { shape: 'split', seconds: 13, pieces: 1, mode: 'ranges' }],
    ['ジェットカット・残す 1/4', { shape: 'jet', takeSeconds: 2, keepRatio: 0.25, mode: 'whole' }],
    ['ジェットカット・残す 1/4', { shape: 'jet', takeSeconds: 2, keepRatio: 0.25, mode: 'ranges' }],
  ];
  const measured = await runInterleaved(cases.map(([, o]) => o));
  for (let i = 0; i < cases.length; i += 1) {
    const r = measured[i];
    console.log(
      `${pad(cases[i][0], 26)}${pad(r.mode, 10)}${right(r.decodeMs.toFixed(0), 11)}${right(r.mixMs.toFixed(0), 11)}${right(`${r.decodedSeconds.toFixed(1)}s`, 10)}${right(mib(r.decodedBytes), 9)}${right(`${r.parts} 本`, 7)}${right(`${r.missed} / ${r.placements}`, 10)}`,
    );
  }
  const [splitWhole, splitRange, jetWhole, jetRange] = measured;
  console.log(
    `\n最初の buffer の時刻 ${splitWhole.firstTimestamp.toFixed(4)}s（**本体はここを捨てて繋いでいる**）・ ` +
      `要求した境目からの広がり 最大 ${Math.max(splitRange.worstWidening, jetRange.worstWidening).toFixed(4)}s\n` +
      `数え上げが言った起こす秒 ${splitRange.plannedSeconds.toFixed(2)}s に対し、実測 ${splitRange.decodedSeconds.toFixed(2)}s（packet の丸め）\n`,
  );

  // --- 波の照合（わざと外した相手つき） ---
  console.log('## 混ぜた波の照合\n');
  for (const [label, shape] of [
    ['素材の中を順に', { shape: 'split', seconds: 13, pieces: 1 }],
    ['5 つに割った素材', { shape: 'split', seconds: 13, pieces: 5 }],
    ['ジェットカット・残す 1/4', { shape: 'jet', takeSeconds: 2, keepRatio: 0.25 }],
    ['ジェットカット・残す 1/2', { shape: 'jet', takeSeconds: 2, keepRatio: 0.5 }],
  ]) {
    const truth = await run({ ...shape, mode: 'whole', verify: true });
    const ranged = await run({ ...shape, mode: 'ranges', verify: true });
    const c = compare(truth.signature, ranged.signature);
    ok(
      `${label}: 範囲だけ起こしても、混ざる波は丸ごとと同じ`,
      c.differing === 0 && c.worst < 3e-5 && ranged.missed === 0,
      `違う区画 ${c.differing} / ${c.blocks} ・ 最大の開き ${c.worst.toExponential(2)} ・ 載らない ${ranged.missed}`,
    );
  }

  console.log('');
  // **助走を振る。** 見立ては「手前はデコーダが勝手に付けるので要らない」だったが、
  // 0 で落ちる。落ちた量から**助走が何秒要るか**を出せる:
  // 違う区画の秒 ÷ 区間の数 が「まだ温まっていなかった長さ」で、それに足した助走を加える。
  console.log('## 助走を何秒取るか（ジェットカット・残す 1/4）\n');
  console.log(`${pad('助走', 8)}${right('違う区画', 12)}${right('最大の開き', 12)}${right('区間', 7)}${right('1 区間あたり', 14)}${right('要る助走', 10)}`);
  const jetShape = { shape: 'jet', takeSeconds: 2, keepRatio: 0.25 };
  const jetTruth = await run({ ...jetShape, mode: 'whole', verify: true });
  let neededPreroll = 0;
  let maxWidening = 0;
  for (const prerollSeconds of [0, 0.05, 0.1, 0.2, 0.3, 0.5]) {
    const ranged = await run({ ...jetShape, mode: 'ranges', prerollSeconds, tailSeconds: 0.05, mergeGapSeconds: 0, verify: true });
    const c = compare(jetTruth.signature, ranged.signature);
    // 区画の標本数は測る側で書き直さず、結果から受け取る（48kHz で 10.667ms）。
    const cold = (c.differing * ranged.signatureBlock) / 48000 / Math.max(1, ranged.parts);
    if (c.differing > 0) neededPreroll = Math.max(neededPreroll, prerollSeconds + cold);
    maxWidening = Math.max(maxWidening, ranged.worstWidening);
    console.log(
      `${pad(`${prerollSeconds}s`, 8)}${right(`${c.differing} / ${c.blocks}`, 12)}${right(c.worst.toExponential(1), 12)}${right(`${ranged.parts} 本`, 7)}${right(`${(cold * 1000).toFixed(0)}ms`, 14)}${right(`${((prerollSeconds + cold) * 1000).toFixed(0)}ms`, 10)}`,
    );
  }
  console.log(
    `\n**助走が足りないと、区間の頭から ${(neededPreroll * 1000).toFixed(0)}ms あたりまで値が違う。** 覆いが足りないのではない\n` +
      `（要求した境目からの広がりは ${(maxWidening * 1000).toFixed(1)}ms しかないので、欲しい標本は全部入っている）。\n` +
      'Opus は前の packet に重ねて復号するので、**途中から始めると先頭のしばらくが本来の値にならない**。\n' +
      `助走を伸ばすと違う区画がそのぶん減り、**${(neededPreroll * 1000).toFixed(0)}ms を越えたところで 0 になる**。\n` +
      `既定の助走 0.5 秒はその ${(0.5 / Math.max(neededPreroll, 1e-6)).toFixed(1)} 倍。\n`,
  );

  // 後ろは覆いの話だけなので、0.05 秒で足りるか（0 で落ちるか）を別に見る。
  for (const tailSeconds of [0, 0.05]) {
    const ranged = await run({ ...jetShape, mode: 'ranges', prerollSeconds: 0.5, tailSeconds, mergeGapSeconds: 0, verify: true });
    const c = compare(jetTruth.signature, ranged.signature);
    ok(
      `後ろの余裕 ${tailSeconds}s でも波が同じ`,
      c.differing === 0 && c.worst < 3e-5 && ranged.missed === 0,
      `違う区画 ${c.differing} / ${c.blocks} ・ 最大の開き ${c.worst.toExponential(2)} ・ 広がり ${ranged.worstWidening.toFixed(4)}s`,
    );
  }

  console.log('');
  // **わざと外して落ちることまで確かめる。**
  const shape = { shape: 'jet', takeSeconds: 2, keepRatio: 0.25 };
  const truth = await run({ ...shape, mode: 'whole', verify: true });
  const unshifted = await run({ ...shape, mode: 'ranges-unshifted', verify: true });
  const gap = compare(truth.signature, unshifted.signature);
  ok(
    '照合は、区間の頭ぶんを引かない形でちゃんと落ちる',
    gap.differing > gap.blocks * 0.5,
    `違う区画 ${gap.differing} / ${gap.blocks} ・ 最大の開き ${gap.worst.toExponential(2)}`,
  );

  const shrunk = await run({ ...shape, mode: 'ranges-shrunk', shrinkSeconds: 0.5, verify: true });
  ok(
    '区間を削ると「載らない置き方」として数に出る（黙って無音にしない）',
    shrunk.missed > 0,
    `載らない ${shrunk.missed} / ${shrunk.placements}`,
  );

  console.log('');
  ok(
    '長い素材から少しだけ使う形では、抱えるバイトが丸ごとより小さい',
    splitRange.decodedBytes < splitWhole.decodedBytes,
    `${mib(splitWhole.decodedBytes)} → ${mib(splitRange.decodedBytes)}（${(splitWhole.decodedBytes / splitRange.decodedBytes).toFixed(1)} 分の 1）`,
  );
  ok(
    'ジェットカットした形でも、抱えるバイトは丸ごとより小さい',
    jetRange.decodedBytes < jetWhole.decodedBytes,
    `${mib(jetWhole.decodedBytes)} → ${mib(jetRange.decodedBytes)}（${(jetWhole.decodedBytes / jetRange.decodedBytes).toFixed(1)} 分の 1）`,
  );

  console.log('');
  // 畳む幅を振る。**区間を減らす得（頭出しの回数）と、余分に起こす損の釣り合い。**
  // 残す割合を一緒に振るのは、**畳む幅だけ振っても隙間が一定なので区間の数が動かない**ため
  // （1 山 2 秒・残す 1/4 なら隙間は必ず 6 秒。畳む幅 0 と 5 で同じ計画になる）。
  console.log('## 区間の数と起こす時間（残す割合 × 畳む幅）\n');
  console.log(
    `${pad('残す', 8)}${pad('畳む幅', 10)}${right('区間', 7)}${right('起こす ms', 11)}${right('起こす秒', 10)}${right('抱える', 9)}${right('振れ幅', 9)}`,
  );
  const gapCases = [];
  for (const keepRatio of [0.25, 0.5, 0.8]) {
    for (const mergeGapSeconds of [0, 1]) {
      gapCases.push({ shape: 'jet', takeSeconds: 2, keepRatio, mode: 'ranges', prerollSeconds: 0.5, tailSeconds: 0.05, mergeGapSeconds });
    }
  }
  gapCases.push({ shape: 'jet', takeSeconds: 2, keepRatio: 0.25, mode: 'whole' });
  const gapMeasured = await runInterleaved(gapCases);
  for (let i = 0; i < gapCases.length; i += 1) {
    const r = gapMeasured[i];
    const label = gapCases[i].mode === 'whole' ? '丸ごと' : `${gapCases[i].mergeGapSeconds}s`;
    console.log(
      `${pad(gapCases[i].keepRatio, 8)}${pad(label, 10)}${right(`${r.parts} 本`, 7)}${right(r.decodeMs.toFixed(0), 11)}${right(`${r.decodedSeconds.toFixed(1)}s`, 10)}${right(mib(r.decodedBytes), 9)}${right(`${(r.spread * 100).toFixed(0)}%`, 9)}`,
    );
  }
  console.log(
    '\n**畳む幅を振っても、同じ隙間の形では計画が動かない**（1 山 2 秒・残す 1/4 の隙間は必ず 6 秒）。\n' +
      '同じ計画どうしの差は振れで、上の表でも 0s と 1s が 20% 前後入れ替わる。\n' +
      '**この測りでは 1.35 倍未満の差は読めない**ので、区間の数の効きは下で 6 点まとめて当てる。\n',
  );

  console.log('');
  // **畳む幅の既定を数字から決める。** 起こす時間を「1 秒あたり」と「1 区間あたり」に分ける。
  // 区間の数と起こす秒を**別々に動かした**組み合わせで測り、最小二乗で 2 つの係数を出す
  // （同じ形で残す割合だけ振ると、区間の数と起こす秒が一緒に動くので分けられない）。
  console.log('## 1 区間の手間と 1 秒の手間（畳む幅の釣り合い）\n');
  console.log(`${pad('形', 30)}${right('区間', 7)}${right('起こす秒', 10)}${right('起こす ms', 11)}${right('振れ幅', 9)}`);
  const fitCases = [
    ['1 山 2 秒 ・ 残す 1/4', { takeSeconds: 2, keepRatio: 0.25 }],
    ['1 山 2 秒 ・ 残す 1/2', { takeSeconds: 2, keepRatio: 0.5 }],
    ['1 山 1 秒 ・ 残す 1/8', { takeSeconds: 1, keepRatio: 0.125 }],
    ['1 山 0.5 秒 ・ 残す 1/8', { takeSeconds: 0.5, keepRatio: 0.125 }],
    ['1 山 0.5 秒 ・ 残す 1/4', { takeSeconds: 0.5, keepRatio: 0.25 }],
    ['1 山 2 秒 ・ 残す 4/5（畳まれて 1 本）', { takeSeconds: 2, keepRatio: 0.8 }],
  ];
  const fitted = await runInterleaved(
    fitCases.map(([, o]) => ({ shape: 'jet', ...o, mode: 'ranges', prerollSeconds: 0.5, tailSeconds: 0.05, mergeGapSeconds: 0 })),
  );
  for (let i = 0; i < fitCases.length; i += 1) {
    const r = fitted[i];
    console.log(
      `${pad(fitCases[i][0], 30)}${right(`${r.parts} 本`, 7)}${right(`${r.decodedSeconds.toFixed(1)}s`, 10)}${right(r.decodeMs.toFixed(0), 11)}${right(`${(r.spread * 100).toFixed(0)}%`, 9)}`,
    );
  }
  // ms ≒ a × 起こす秒 ＋ b × 区間の数。切片を置かないのは、
  // 「何も起こさなければ 0ms」が測らなくても分かっているため（置くと 3 つ目の自由度に振れが逃げる）。
  let ss = 0;
  let sp = 0;
  let pp = 0;
  let sm = 0;
  let pm = 0;
  for (const r of fitted) {
    ss += r.decodedSeconds ** 2;
    sp += r.decodedSeconds * r.parts;
    pp += r.parts ** 2;
    sm += r.decodedSeconds * r.decodeMs;
    pm += r.parts * r.decodeMs;
  }
  const det = ss * pp - sp * sp;
  const perSecondMs = det !== 0 ? (sm * pp - pm * sp) / det : 0;
  const perPartMs = det !== 0 ? (pm * ss - sm * sp) / det : 0;
  const breakEven = perSecondMs > 0 ? perPartMs / perSecondMs : 0;
  console.log(
    `\n**1 秒あたり ${perSecondMs.toFixed(1)}ms ・ 1 区間あたり ${perPartMs.toFixed(1)}ms。**\n` +
      `隙間 G 秒の 2 本を畳むと、余分に起こす ${perSecondMs.toFixed(1)}×G ms を払って、頭出し 1 回ぶん ` +
      `${perPartMs.toFixed(1)}ms を省く。\n` +
      `つまり**釣り合うのは G ＝ ${breakEven.toFixed(2)} 秒**で、これより狭い隙間は畳むほうが速い。\n` +
      `既定の畳む幅 1 秒はそのすぐ上に置いてある（走らせるたびに 0.7〜0.9 秒のあたりで動く）。\n`,
  );
  ok(
    '畳む幅の既定（1 秒）が、測った釣り合い（1 区間 ÷ 1 秒）の 2 倍以内にある',
    breakEven > 0.5 && breakEven < 2,
    `釣り合い ${breakEven.toFixed(2)}s ・ 1 秒 ${perSecondMs.toFixed(1)}ms ・ 1 区間 ${perPartMs.toFixed(1)}ms`,
  );

  console.log('');
  ok('画面側でエラーが出ていない', errors.length === 0, errors.slice(0, 3).join(' / '));
} finally {
  await browser.close();
  server.stop();
}

console.log(failed > 0 ? `\n${failed} 件が失敗しています。` : '\n照合はすべて通りました。');
if (failed > 0) process.exit(1);
