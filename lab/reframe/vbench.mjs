/**
 * **縦の軸**の自動リフレームが「実際どれくらい効くか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:reframe:v
 *   LAB_RF_AXIS=off npm run lab:reframe:v   # 軸の上の帯を締め出さない（字幕に負ける側を見る）
 *   LAB_RF_CUE=spatial npm run lab:reframe:v # 横の手（階調を外さない）をそのまま縦へ当てる
 *   LAB_FPS=15 npm run lab:reframe:v
 *
 * 最初から縦（9:16）で撮った素材から **1:1** を切ると、余るのは縦になる。
 * 決めるのは「各コマで、高さ 56.25% の窓を縦のどこに置くか」の 1 本の列だけ。
 *
 * **横の表（`bench.mjs`）と入れた率を並べて読まないこと。**
 * 縦の窓（0.5625）は横の窓（0.316）の 1.8 倍広いので、同じ手でも入れた率は高く出る。
 * 並べてよいのは**ずれ**（画面に対する割合）と**泳ぎ**のほう。
 */

import { REFRAME_V_FIXTURES, SCENE_FIXTURES, SCENE_FPS, leadSubjectAt } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';
import { median, scoreFollow, scoreSwim, totalSwim } from './score.mjs';

const { FULL_BAND } = await import('./src/columns.ts');
const { VERTICAL_REFRAME, planFromRaw, planReframeVertical, rawTargets, summarizeForReframeVertical } = await import(
  './src/reframe.ts'
);

const fps = Number(process.env.LAB_FPS ?? SCENE_FPS);
const ASPECT = 'native';
const options = {
  ...(process.env.LAB_RF_DEAD ? { deadband: Number(process.env.LAB_RF_DEAD) } : {}),
  ...(process.env.LAB_RF_SPEED ? { maxSpeed: Number(process.env.LAB_RF_SPEED) } : {}),
  ...(process.env.LAB_RF_SMOOTH ? { smooth: Number(process.env.LAB_RF_SMOOTH) } : {}),
  ...(process.env.LAB_RF_LEADIN ? { leadIn: process.env.LAB_RF_LEADIN !== 'off' } : {}),
  ...(process.env.LAB_RF_GATE ? { gate: process.env.LAB_RF_GATE } : {}),
  // 軸の上で探してよい範囲（既定は上下 15% を締め出す）。`off` で締め出さない。
  ...(process.env.LAB_RF_AXIS === 'off' ? { axisBand: FULL_BAND } : {}),
};
const opt = { ...VERTICAL_REFRAME, ...options };

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

function measure(fixture, centersOf) {
  const clip = renderFixture(fixture.name, { fps, aspect: ASPECT });
  const rows = summarizeForReframeVertical(clip.frames, clip.times, options);
  const centers = centersOf(rows);
  const follow = scoreFollow(fixture, clip.times, centers, opt.cropWidth, ASPECT, 'v');
  return { ...follow, swim: totalSwim(clip.times, centers) };
}

// **横の手をそのまま縦へ当てたらどうなるか**を、同じ表の中で出せるようにしてある。
// 別のスクリプトに分けると、比べたい 2 つが別の素材・別のつまみで測られていく。
const planned =
  process.env.LAB_RF_CUE === 'spatial'
    ? (rows) =>
        planFromRaw(
          rawTargets(rows),
          rows.map((r) => r.time),
          { ...VERTICAL_REFRAME, ...options },
        ).frames.map((f) => f.center)
    : (rows) => planReframeVertical(rows, options).frames.map((f) => f.center);
const fixed = (rows) => rows.map(() => 0.5);

const withSubject = REFRAME_V_FIXTURES.filter((f) => leadSubjectAt(f, 6.5, ASPECT));
const without = SCENE_FIXTURES.filter((f) => !leadSubjectAt(f, 6.5, ASPECT));

console.log(`縦の自動リフレームの効き（正解と突き合わせ・最初から縦 9:16 から 1:1 を切る ・ ${fps}fps）\n`);
console.log(`  設定: ${JSON.stringify(opt)}\n`);

console.log('被写体の居る素材（追えているか）\n');
console.log(
  `${pad('素材', 22)}${right('コマ', 6)}${right('入れた率', 10)}${right('ずれ', 8)}${right('泳ぎ/s', 9)}` +
    `   ${right('真ん中の入れた率', 18)}${right('ずれ', 8)}`,
);
console.log('-'.repeat(86));

let sumIn = 0;
let sumFixedIn = 0;
const allErrors = [];
const swims = [];
for (const f of withSubject) {
  const a = measure(f, planned);
  const b = measure(f, fixed);
  sumIn += a.inside;
  sumFixedIn += b.inside;
  allErrors.push(a.error);
  swims.push(a.swim);
  console.log(
    `${pad((f.hard ? '※ ' : '  ') + f.name, 22)}${right(a.counted, 6)}${right(`${a.inside.toFixed(1)}%`, 10)}` +
      `${right(a.error.toFixed(3), 8)}${right(a.swim.toFixed(3), 9)}   ` +
      `${right(`${b.inside.toFixed(1)}%`, 18)}${right(b.error.toFixed(3), 8)}`,
  );
}
console.log('-'.repeat(86));
console.log(
  `${pad('  ぜんぶ', 22)}${right('', 6)}${right(`${(sumIn / withSubject.length).toFixed(1)}%`, 10)}` +
    `${right(median(allErrors).toFixed(3), 8)}${right(median(swims).toFixed(3), 9)}   ` +
    `${right(`${(sumFixedIn / withSubject.length).toFixed(1)}%`, 18)}`,
);

console.log('\n\n被写体の居ない素材（泳いでいないか。0.000 が正解）\n');
console.log(
  `${pad('素材', 24)}${right('泳ぎ/s', 9)}${right('回数', 7)}${right('組み直し/s', 11)}${right('合計/s', 9)}${right('振れ幅', 9)}`,
);
console.log('-'.repeat(69));
const idleSwims = [];
const totals = [];
let worst = null;
for (const f of without) {
  const clip = renderFixture(f.name, { fps, aspect: ASPECT });
  const rows = summarizeForReframeVertical(clip.frames, clip.times, options);
  const centers = planned(rows);
  const { swim, wanders, recompose, range } = scoreSwim(clip.times, centers, clip.cuts, fps);
  idleSwims.push(swim);
  if (!worst || swim > worst.swim) worst = { name: f.name, swim, range };
  totals.push(swim + recompose);
  console.log(
    `${pad('  ' + f.name, 24)}${right(swim.toFixed(3), 9)}${right(wanders, 7)}` +
      `${right(recompose.toFixed(3), 11)}${right((swim + recompose).toFixed(3), 9)}${right(range.toFixed(3), 9)}`,
  );
}
console.log('-'.repeat(69));
console.log(
  `${pad('  中央値', 24)}${right(median(idleSwims).toFixed(3), 9)}${right('', 18)}${right(median(totals).toFixed(3), 9)}\n` +
    `${pad('  いちばん泳いだ素材', 24)}${right(worst.swim.toFixed(3), 9)}${right('', 18)}${right('', 9)}${right(worst.range.toFixed(3), 9)}  ${worst.name}`,
);
