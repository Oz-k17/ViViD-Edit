/**
 * キーフレームの画面を通して確かめる。
 *
 *   npm run lab:keyframe:uitest
 *
 * selftest（ブラウザ不要）が「計算が合っているか」を見るのに対して、
 * こちらは **「打点を置く → つまむ → 繋ぎ方を選ぶ → 絵が出る」が繋がっているか**を見る。
 * 計算が正しくても配線が切れていれば使えないので、両方要る。
 *
 * ## 素材を焼かない（ほかの画面と違う所）
 *
 * シーン検出・リフレームの確かめは、素材をその場で WebM に焼いて画面へ食わせている。
 * ここは焼かない——**この試作は絵を読まない**（打点は秒と値しか見ない）ので、
 * 焼いても確かめられるものが増えず、時間だけ増える。
 * 絵の側は「合成の絵を、計算した矩形と透明度で置けているか」まで見れば足りる。
 *
 * ## 突き合わせるのは「ずれ」
 *
 * 画面の 3 通りのずれ（`state().score`）と `probeTable()` を、
 * **Node 側で同じ関数を呼んだ数字**と突き合わせる。物差しは `scenarios.ts` に 1 本だけ置いてあるので、
 * ここが食い違えば配線の側が原因だと言える。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので画面の確認は飛ばします（計算は npm run lab:test で確認できます）。');
  process.exit(0);
}

const { SCENARIOS, baseClip, clipInBase, scoreClip, worstError, EXACT } = await import('./src/scenarios.ts');
const { applyOp, editOps, clipEnd } = await import('./src/timebase.ts');
const { defaultTrackBase, keyTimeIn, keyTimeInUnclamped, timeAtKeyTime } = await import('./src/track.ts');
const { composeAt } = await import('./src/compose.ts');

const BASES = ['source', 'local', 'fraction'];
const FPS = 30;

let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

const opsFor = (s) =>
  editOps({
    moveBy: s.edits.moveBy,
    trimHead: s.edits.trimHead,
    trimTail: s.edits.trimTail,
    splitAt: (c) => Math.min(clipEnd(c) - 0.1, Math.max(c.start + 0.1, s.edits.splitAt)),
    speedTo: s.edits.speedTo,
    rippleBy: s.edits.rippleBy,
  });

/** 画面と同じ順で編集を当てたときの、Node 側のずれ。 */
function scoreAfter(s, base, steps) {
  let clip = clipInBase(s, base);
  for (const step of steps) {
    const op = opsFor(s).find((o) => o.name === step.op);
    const out = applyOp(op, base, clip, 'raw');
    clip = out[Math.min(step.pick, out.length - 1)];
  }
  return scoreClip(s, base, clip, FPS).max;
}

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1000, height: 1600 }, deviceScaleFactor: 1 })
  ).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.__labKeyframe === 'object', null, { timeout: 30000 });

  const api = (fn, arg = null) => page.evaluate(fn, arg);

  // --- 画面から回すセルフテスト（コマンドライン版と同じものを見ている） ---
  await page.getByRole('button', { name: 'テストを実行' }).click();
  await page.waitForSelector('#test-results li');
  const tests = await page.evaluate(() =>
    [...document.querySelectorAll('#test-results li')].map((li) => ({
      ok: li.classList.contains('pass'),
      name: li.children[1].textContent,
    })),
  );
  ok(
    `画面からもセルフテストが通る（${tests.length} 件）`,
    tests.length > 0 && tests.every((t) => t.ok),
    tests.filter((t) => !t.ok).map((t) => t.name).join(' / ') || `${tests.length}/${tests.length}`,
  );

  // --- 既定は画面に直書きせず、判定の側から写しているか ---
  const defaults = await api(() => window.__labKeyframe.defaults);
  ok(
    '画面の既定が判定の側から来ている',
    defaults.bases.join(',') === BASES.join(',') &&
      defaults.defaultBase.video === defaultTrackBase('video') &&
      defaults.defaultBase.audio === defaultTrackBase('audio') &&
      defaults.defaultBase.image === defaultTrackBase('image') &&
      defaults.defaultBase.text === defaultTrackBase('text') &&
      defaults.scoreFps === FPS &&
      defaults.scenarios.join(',') === SCENARIOS.map((s) => s.name).join(','),
    `${defaults.bases.join('/')} ・ 既定 ${JSON.stringify(defaults.defaultBase)} ・ ${defaults.scoreFps}fps ・ 素材 ${defaults.scenarios.length} 本`,
  );
  ok(
    '時間軸の選択肢に absolute が無い（測って捨てたもの）',
    !(await page.locator('#kf-base').innerHTML()).includes('absolute'),
  );

  // --- 素材を選ぶと、書いてある打点がそのまま入っているか ---
  for (const s of SCENARIOS) {
    await api((name) => window.__labKeyframe.setScenario(name), s.name);
    const state = await api(() => window.__labKeyframe.state());
    const want = clipInBase(s, defaultTrackBase(s.kind));
    const wantKeys = want.value.keys;
    const sameKeys =
      state.keys.length === wantKeys.length &&
      state.keys.every((k, i) => Math.abs(k.t - wantKeys[i].t) < 1e-9 && Math.abs(k.v - wantKeys[i].v) < 1e-9);
    ok(
      `${s.name}: 素材の打点が、種類の既定の時間軸で入っている`,
      state.base === defaultTrackBase(s.kind) && sameKeys,
      `${state.base} ・ 打点 ${state.keys.length} 個`,
    );
    ok(
      `${s.name}: 編集前は 3 通りとも 0（画面の写し替えが見た目を保っている）`,
      BASES.every((b) => state.score[b] <= EXACT),
      BASES.map((b) => `${b} ${state.score[b].toFixed(4)}`).join(' / '),
    );
  }

  // --- 画面の probe 表が、コマンドラインの数字と 1 セットで合うか ---
  const table = await api(() => window.__labKeyframe.probeTable());
  let worstCell = 0;
  let cells = 0;
  let worstAt = '';
  for (const row of table) {
    const s = SCENARIOS.find((x) => x.name === row.name);
    const ops = opsFor(s);
    row.errors.forEach((got, i) => {
      const want = worstError(s, row.base, ops[i], 'raw', FPS);
      const diff = Math.abs(got - want);
      cells += 1;
      if (diff > worstCell) {
        worstCell = diff;
        worstAt = `${row.name}/${row.base}/${ops[i].name}`;
      }
    });
  }
  ok(
    `画面の表がコマンドラインと一致（${cells} セル）`,
    cells === SCENARIOS.length * BASES.length * 6 && worstCell <= 1e-12,
    worstCell <= 1e-12 ? '最悪の差 0' : `最悪 ${worstCell.toExponential(1)} @ ${worstAt}`,
  );

  // --- 編集を当てても打点が付いてくる（期待の時間軸だけが 0） ---
  const OP_STEPS = [
    { op: 'move', pick: 0 },
    { op: 'trimLeft', pick: 0 },
    { op: 'trimRight', pick: 0 },
    { op: 'split', pick: 1 },
    { op: 'setSpeed', pick: 0 },
    { op: 'rippleShift', pick: 0 },
  ];
  for (const s of SCENARIOS) {
    for (const step of OP_STEPS) {
      await api((name) => window.__labKeyframe.setScenario(name), s.name);
      // 期待の形に合う時間軸へ替えてから当てる（既定と違う素材もあるので明示する）
      const wantBase = s.intent === 'content' ? 'source' : s.intent === 'head' ? 'local' : 'fraction';
      await api((b) => window.__labKeyframe.setBase(b), wantBase);
      await api((a) => window.__labKeyframe.applyEdit(a.op, a.pick), step);
      const state = await api(() => window.__labKeyframe.state());
      const wantScore = scoreAfter(s, wantBase, [step]);
      ok(
        `${s.name} / ${step.op}: 画面のずれがコマンドラインと同じ`,
        Math.abs(state.score[wantBase] - wantScore) <= 1e-12,
        `画面 ${state.score[wantBase].toFixed(4)} / 端末 ${wantScore.toFixed(4)}`,
      );
    }
  }

  // --- つまむ（本物のマウスで掴んで離す） ---
  //
  // **画素で触る前に、毎回キャンバスを見える所へ出して座標を取り直す。**
  // ボタンを押すと playwright が勝手にそこへスクロールするので（上のセルフテストは画面の下）、
  // 1 度取った座標を使い回すと、掴む点が画面の外（`box.y` が負）に落ちて**何も起きない**。
  // そのときも「ずれ」は出るので、**画面の穴と見分けが付かない形で通り過ぎる。**
  const curveBox = async () => {
    await page.locator('#kf-curve').scrollIntoViewIfNeeded();
    return page.locator('#kf-curve').boundingBox();
  };

  /** 打点を dx, dy 画素つまんで動かし、「画素が指す所」と「着地した所」を返す。 */
  async function drag(scenario, index, dx, dy, base) {
    await api((n) => window.__labKeyframe.setScenario(n), scenario);
    if (base) await api((b) => window.__labKeyframe.setBase(b), base);
    const box = await curveBox();
    const state = await api(() => window.__labKeyframe.state());
    const key = state.keys[index];
    const at = timeAtKeyTime(state.base, state.clip, key.t);
    const from = await api((a) => window.__labKeyframe.toPixel(a.t, a.v), { t: at, v: key.v });
    const to = { x: from.x + dx, y: from.y + dy };
    const want = await api((q) => window.__labKeyframe.keyAtPixel(q.x, q.y), to);
    await page.mouse.move(box.x + from.x, box.y + from.y);
    await page.mouse.down();
    await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 10 });
    await page.mouse.up();
    const after = await api(() => window.__labKeyframe.state());
    return { want, got: after.keys[index], count: after.keys.length, before: state, at };
  }

  {
    const r = await drag('video-punch', 1, 40, -30);
    const dt = Math.abs(r.got.t - r.want.t);
    const dv = Math.abs(r.got.v - r.want.v);
    ok(
      '掴んで離した所に打点が来る（画素が指す秒と値に一致）',
      dt < 1e-5 && dv < 1e-5,
      `秒のずれ ${dt.toExponential(1)}s / 値のずれ ${dv.toExponential(1)}（${r.got.t.toFixed(3)}s ・ ${r.got.v.toFixed(4)}）`,
    );
    ok('つまんでも打点の数は変わらない', r.count === r.before.keys.length, `${r.count} 個`);
  }

  // **軸が伸びる方向へ引っ張っても狙い通りに落ちるか。**
  // つまんでいる間に軸を合わせ直すと、値は +0.0707 のつもりが +0.640 動き（0.569 余計）、
  // 横はクリップの外へ出した時点で 1.13 秒余計に動いた（どちらも 2026-09-27 の 2 回目に実測）。
  {
    const up = await drag('video-punch', 1, 0, -30);
    const outward = await drag('video-punch', 3, 200, 0);
    const dvUp = Math.abs(up.got.v - up.want.v);
    const dtOut = Math.abs(outward.got.t - outward.want.t);
    ok(
      'つまんでいる間に軸が動かない（値の上へ / クリップの外へ引っ張っても狙い通り）',
      dvUp < 1e-5 && dtOut < 1e-5,
      `値の上へ 30px: ずれ ${dvUp.toExponential(1)} ・ 外へ 200px: ずれ ${dtOut.toExponential(1)}s`,
    );
    ok(
      'クリップの外へ出した打点は、外に居るものとして数えられる',
      outward.got.t > clipEnd(outward.before.clip) - outward.before.clip.start + outward.before.clip.sourceIn - 1e-9,
      `打点 ${outward.got.t.toFixed(2)}（素材の秒）・ クリップの尻は素材の ${(outward.before.clip.sourceIn + outward.before.clip.duration * outward.before.clip.speed).toFixed(2)}`,
    );
  }

  // 1 画素が指す秒（時間軸と速さで変わる）。**つまむ側の分解能はここで決まる。**
  const resolution = {};
  for (const [name, scenario, base] of [
    ['source ×1', 'video-punch', 'source'],
    ['source ×2', 'video-2x', 'source'],
    ['local', 'text-intro', 'local'],
    ['fraction', 'image-kenburns', 'fraction'],
  ]) {
    await api((n) => window.__labKeyframe.setScenario(n), scenario);
    await api((b) => window.__labKeyframe.setBase(b), base);
    const a = await api(() => window.__labKeyframe.keyAtPixel(100, 100));
    const b2 = await api(() => window.__labKeyframe.keyAtPixel(101, 100));
    resolution[name] = Math.abs(b2.t - a.t);
  }
  ok(
    '1 画素が指す打点の秒を測れている（時間軸と速さで変わる）',
    Object.values(resolution).every((v) => v > 0),
    Object.entries(resolution)
      .map(([k, v]) => `${k} ${k === 'fraction' ? `${(v * 100).toFixed(2)}%` : `${(v * 1000).toFixed(1)}ms`}`)
      .join(' / '),
  );

  // --- クリップの外に居る打点（刈らないと決めたもの）を掴めるか ---
  await api(() => window.__labKeyframe.setScenario('video-fade-in'));
  await api(() => window.__labKeyframe.applyEdit('trimLeft', 0));
  const trimmed = await api(() => window.__labKeyframe.state());
  ok(
    '頭を詰めると、打点がクリップの外に残る（刈らない決まり）',
    trimmed.outside > 0,
    `外に ${trimmed.outside} 個 ・ 打点の秒 ${trimmed.keys.map((k) => k.t.toFixed(2)).join(' / ')} ・ クリップのイン点 ${trimmed.clip.sourceIn.toFixed(2)}`,
  );
  {
    const box2 = await curveBox();
    const outsideKey = trimmed.keys[0];
    const outsideAt = timeAtKeyTime('source', trimmed.clip, outsideKey.t);
    const op = await api((a) => window.__labKeyframe.toPixel(a.t, a.v), { t: outsideAt, v: outsideKey.v });
    const opTo = { x: op.x + 12, y: op.y };
    const wantOutside = await api((q) => window.__labKeyframe.keyAtPixel(q.x, q.y), opTo);
    await page.mouse.move(box2.x + op.x, box2.y + op.y);
    await page.mouse.down();
    await page.mouse.move(box2.x + opTo.x, box2.y + opTo.y, { steps: 6 });
    await page.mouse.up();
    const afterOutside = await api(() => window.__labKeyframe.state());
    const movedOutside = afterOutside.keys[0];
    // 丸めた写し（本体の `sourceTimeAt`）を使っていたら、ここは `sourceIn` に張り付く。
    const clampedWould = keyTimeIn('source', trimmed.clip, timeAtKeyTime('source', trimmed.clip, wantOutside.t));
    ok(
      'クリップの外の打点を掴んでも、頭に張り付かない（丸めない写しを使っている）',
      Math.abs(movedOutside.t - wantOutside.t) < 1e-5 && movedOutside.t < trimmed.clip.sourceIn,
      `掴んだ先 ${movedOutside.t.toFixed(3)}s ・ 丸めた式なら ${clampedWould.toFixed(3)}s（差 ${Math.abs(clampedWould - wantOutside.t).toFixed(3)}s）`,
    );
  }

  // --- 繋ぎ方を選ぶ ---
  await api(() => window.__labKeyframe.setScenario('image-kenburns'));
  const linearAt = await api(() => {
    const kf = window.__labKeyframe;
    kf.setTime(2.5);
    return kf.state().composed.values.scale;
  });
  // 1 つ目の打点を選んで hold にする（選ぶのは画面の当たり判定を通す）
  const kb = await api(() => window.__labKeyframe.state());
  const kbBox = await curveBox();
  const kbPixel = await api(
    (a) => window.__labKeyframe.toPixel(a.t, a.v),
    { t: timeAtKeyTime('fraction', kb.clip, kb.keys[0].t), v: kb.keys[0].v },
  );
  await page.mouse.click(kbBox.x + kbPixel.x, kbBox.y + kbPixel.y);
  await page.selectOption('#kf-ease', 'hold');
  const holdAt = await api(() => window.__labKeyframe.state().composed.values.scale);
  ok(
    '繋ぎ方を hold にすると、次の打点まで動かない',
    Math.abs(linearAt - 1.1) < 1e-9 && Math.abs(holdAt - 1) < 1e-9,
    `真ん中の値 linear ${linearAt.toFixed(3)} → hold ${holdAt.toFixed(3)}`,
  );
  const easeState = await api(() => window.__labKeyframe.state());
  ok(
    '選んだ打点にだけ繋ぎ方が付く',
    easeState.keys[0].ease === 'hold' && !easeState.keys[1].ease,
    `${easeState.keys.map((k) => k.ease ?? 'linear').join(' / ')}`,
  );

  // --- 打点を置く / 消す。**既定でない時間軸が、打点を全部消しても残るか** ---
  //
  // 2026-09-27 の 2 回目の画面は `state.base` という**自分の欄**に軸を覚えていたので、
  // 「打点が 0 個になると軸が消える」は画面では起きなかった（起きるのは本体へ持っていったとき）。
  // 3 回目に画面は覚えるのをやめて値から読むようにしたので、**ここで初めて画面から確かめられる。**
  //
  // 打点の立つ秒は `keyStandsAt()` に聞く。**確かめの側で時間軸ごとの式を書くと 2 本目の物差しになる**
  //（実際、前の回はここに `fraction` だけの式を直書きしていた）。
  const clearAllKeys = () =>
    api(() => {
      const kf = window.__labKeyframe;
      const canvas = document.getElementById('kf-curve');
      // Alt を押しながら押す＝画面と同じ「消す」操作。
      for (let guard = 0; guard < 16 && kf.state().keys.length > 0; guard += 1) {
        const stands = kf.keyStandsAt();
        const k = kf.state().keys[0];
        const p2 = kf.toPixel(stands[0], k.v);
        const r = canvas.getBoundingClientRect();
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            altKey: true,
            clientX: r.left + p2.x,
            clientY: r.top + p2.y,
          }),
        );
      }
      return kf.state();
    });

  await api(() => window.__labKeyframe.setScenario('image-kenburns'));
  await api(() => window.__labKeyframe.setBase('fraction'));
  const kbEmpty = await clearAllKeys();
  ok('打点を全部消せる（Alt を押しながら）', kbEmpty.keys.length === 0, `残り ${kbEmpty.keys.length} 個`);
  ok(
    '打点を全部消しても、選んだ時間軸が値に残る（畳んだ形）',
    kbEmpty.base === 'fraction' && /"base":"fraction"/.test(kbEmpty.valueJson),
    `${kbEmpty.valueJson} ・ 軸 ${kbEmpty.base}`,
  );
  ok(
    '畳んでも値が既定へ跳ねない（絵がそのまま出る）',
    Number.isFinite(kbEmpty.composed.alpha) && Math.abs(kbEmpty.composed.values.scale - 1.2) < 1e-9,
    `拡大 ${kbEmpty.composed.values.scale.toFixed(3)}`,
  );
  await page.getByRole('button', { name: 'いまの時刻に打点を置く' }).click();
  const kbAgain = await api(() => window.__labKeyframe.state());
  ok(
    '軸を渡さずに置き直しても fraction で入る（画面が覚えなくてよくなった）',
    kbAgain.base === 'fraction' && kbAgain.keys.length === 1,
    `軸 ${kbAgain.base} ・ 打点 ${kbAgain.keys.length} 個 ・ ${kbAgain.valueJson}`,
  );

  // 既定の軸まで覚えると JSON が太るので、既定へ戻したら素の数へ畳むこと。
  await api(() => window.__labKeyframe.setBase('local'));
  const kbPlain = await clearAllKeys();
  ok(
    '既定の軸へ戻して全部消すと、素の数へ畳む（JSON を太らせない）',
    kbPlain.keys.length === 0 &&
      kbPlain.valueJson === String(Number(kbPlain.valueJson)) &&
      typeof kbPlain.clip.value === 'number',
    `${kbPlain.valueJson}`,
  );

  // 打点が 0 個の状態で軸だけ選ぶ（`setTrackBase()` の口。2 回目には作れなかった操作）
  await api(() => window.__labKeyframe.setBase('fraction'));
  const kbSeated = await api(() => window.__labKeyframe.state());
  ok(
    '打点が 0 個でも時間軸だけ先に選べる（置く前に決められる）',
    kbSeated.keys.length === 0 && kbSeated.base === 'fraction' && /"base":"fraction"/.test(kbSeated.valueJson),
    `${kbSeated.valueJson}`,
  );
  await page.getByRole('button', { name: 'いまの時刻に打点を置く' }).click();
  const kbFirstKey = await api(() => window.__labKeyframe.state());
  ok(
    '先に選んだ軸で 1 つ目の打点が入る',
    kbFirstKey.keys.length === 1 && kbFirstKey.base === 'fraction',
    `軸 ${kbFirstKey.base} ・ ${kbFirstKey.valueJson}`,
  );

  // 粗探し: **打点 0 個 × 既定でない軸**のまま編集を当てる。
  // 畳んだ形は `Animated`（素の数か打点の列）ではないので、そのまま編集へ渡すと落ちる所があった。
  await api(() => window.__labKeyframe.setScenario('image-kenburns'));
  await api(() => window.__labKeyframe.setBase('fraction'));
  const kbNone = await clearAllKeys();
  for (const step of OP_STEPS) await api((a) => window.__labKeyframe.applyEdit(a.op, a.pick), step);
  const kbEdited = await api(() => window.__labKeyframe.state());
  ok(
    '打点 0 個 × 既定でない軸のまま編集しても割れない（軸は残る）',
    kbNone.keys.length === 0 &&
      kbEdited.keys.length === 0 &&
      kbEdited.base === 'fraction' &&
      Number.isFinite(kbEdited.composed.alpha) &&
      Number.isFinite(kbEdited.score.fraction),
    `${kbEdited.valueJson} ・ 尺 ${kbEdited.clip.duration.toFixed(3)}s ・ 透明度 ${kbEdited.composed.alpha.toFixed(3)}`,
  );

  // --- 絵（本体へ差す形）。矩形と透明度が Node 側と合うか ---
  await api(() => window.__labKeyframe.setScenario('video-punch'));
  let worstRect = 0;
  let worstAlpha = 0;
  for (const t of [2.0, 3.2, 4.0, 5.0, 6.4, 7.0, 7.9]) {
    const got = await api((time) => {
      window.__labKeyframe.setTime(time);
      return window.__labKeyframe.state();
    }, t);
    const s = SCENARIOS.find((x) => x.name === 'video-punch');
    const want = composeAt(
      { ...baseClip(s), fadeIn: 0, fadeOut: 0 },
      { scale: got.clip.value, x: 0, y: 0, opacity: 1 },
      t,
      { width: 270, height: 480 },
      { width: 1280, height: 720 },
    );
    worstRect = Math.max(
      worstRect,
      Math.abs(got.composed.rect.x - want.rect.x),
      Math.abs(got.composed.rect.w - want.rect.w),
    );
    worstAlpha = Math.max(worstAlpha, Math.abs(got.composed.alpha - want.alpha));
  }
  ok(
    '画面の矩形と透明度が、Node 側の composeAt と一致（7 コマ）',
    worstRect <= 1e-9 && worstAlpha <= 1e-9,
    `矩形の差 ${worstRect.toExponential(1)} / 透明度の差 ${worstAlpha.toExponential(1)}`,
  );

  /** プレビューの真ん中あたりの明るさ（0〜255）。絵が本当に出ているかを見る。 */
  const previewLuma = () =>
    api(() => {
      const canvas = document.getElementById('kf-preview');
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(canvas.width / 2 - 20, canvas.height / 2 - 20, 40, 40).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return sum / (d.length / 4);
    });

  // 打点で不透明度を 0 にした所では、絵が出ていないこと（＝差し方が効いていること）。
  // **わざと壊して FAIL することまで見る**（表紙の画面が 2026-09-23 に踏んだ教訓）。
  await api(() => window.__labKeyframe.setScenario('video-fade-in'));
  await api(() => window.__labKeyframe.setTime(2));
  const dark = await previewLuma();
  await api(() => window.__labKeyframe.setTime(3));
  const bright = await previewLuma();
  ok(
    '打点で不透明度 0 の所は絵が出ず、1 の所では出る（検査が向きを持っている）',
    dark < 1 && bright > 20,
    `0 の所 ${dark.toFixed(1)} / 1 の所 ${bright.toFixed(1)}（0〜255）`,
  );

  // フェードと打点は掛け算で重なる（画面のつまみを通して）
  await api(() => window.__labKeyframe.setScenario('video-2x'));
  await api(() => window.__labKeyframe.setTime(3));
  const noFade = await api(() => {
    window.__labKeyframe.setFade(0, 0, true);
    return window.__labKeyframe.state().composed;
  });
  const withFade = await api(() => {
    // 係数が 1 になる所で測ると、掛け算になっているかどうかが出ない（前は 2 秒で 1.000 だった）。
    window.__labKeyframe.setFade(4, 0, true);
    return window.__labKeyframe.state().composed;
  });
  ok(
    '画面のフェードのつまみが、打点と掛け算で重なる',
    Math.abs(noFade.alpha - 0.4) < 1e-9 &&
      Math.abs(withFade.fade - 0.5) < 1e-9 &&
      Math.abs(withFade.alpha - 0.4 * withFade.fade) < 1e-9,
    `打点だけ ${noFade.alpha.toFixed(3)} / フェード ${withFade.fade.toFixed(3)} を掛けて ${withFade.alpha.toFixed(3)}`,
  );

  // --- 粗探し: 同じ操作を何度も当てる / 打点を全部消す ---
  //
  // 尺は本体の最小（0.1 秒）で止まるので、そこまで詰めても割れないこと。
  // **`splitAt` は素材が書いた秒なので、2 度割るとクリップの外へ出る**（画面側で内側へ寄せてある）。
  await api(() => window.__labKeyframe.setScenario('audio-duck'));
  for (let i = 0; i < 3; i += 1) {
    for (const step of OP_STEPS) await api((a) => window.__labKeyframe.applyEdit(a.op, a.pick), step);
  }
  const hammered = await api(() => window.__labKeyframe.state());
  ok(
    '同じ編集を 3 周当てても割れない（尺は本体の最小で止まる）',
    hammered.clip.duration >= 0.1 - 1e-9 &&
      Number.isFinite(hammered.score.source) &&
      Number.isFinite(hammered.composed.alpha),
    `尺 ${hammered.clip.duration.toFixed(3)}s ・ 打点 ${hammered.keys.length} 個 ・ ずれ ${hammered.score.source.toFixed(4)}`,
  );

  // 打点を 1 つも持たない状態でも、絵と数字が出ること（素の数へ畳んだ形＝いまの本体と同じ）
  await api(() => window.__labKeyframe.setScenario('video-punch'));
  const bare = await api(() => {
    const kf = window.__labKeyframe;
    const canvas = document.getElementById('kf-curve');
    for (let i = kf.state().keys.length - 1; i >= 0; i -= 1) {
      const s2 = kf.state();
      const k = s2.keys[i];
      const t = s2.clip.start + (k.t - s2.clip.sourceIn) / s2.clip.speed;
      const p2 = kf.toPixel(t, k.v);
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          altKey: true,
          clientX: r.left + p2.x,
          clientY: r.top + p2.y,
        }),
      );
    }
    return kf.state();
  });
  ok(
    '打点が 0 個でも、素の数として絵が出る（保存済みプロジェクトと同じ形）',
    bare.keys.length === 0 && typeof bare.clip.value === 'number' && Number.isFinite(bare.composed.alpha),
    `値 ${JSON.stringify(bare.clip.value)} ・ 透明度 ${bare.composed.alpha.toFixed(3)} ・ 拡大 ${bare.composed.values.scale.toFixed(3)}`,
  );

  ok('画面がエラーを出していない', errors.length === 0, errors.slice(0, 3).join(' / '));
} finally {
  await browser.close();
  server.stop();
}

console.log(failed === 0 ? '\nすべて通りました。' : `\n${failed} 件が失敗しています。`);
process.exit(failed === 0 ? 0 : 1);
