/**
 * 自動リフレームの画面を通して確かめる。
 *
 *   npm run lab:reframe:uitest
 *
 * selftest（ブラウザ不要）が「計算が合っているか」を見るのに対して、
 * こちらは **「本物の動画を読む → 枠を決める → 切り出して見せる」が繋がっているか**を見る。
 * 計算が正しくても配線が切れていれば使えないので、両方要る。
 *
 * ## 素材は、その場で**本物の動画に焼いて**渡す
 *
 * シーン検出の確かめと同じ形（`scene-cut/uitest.mjs` の注に事情が書いてある）。
 * 焼く部品まで同じものを借りているので、**圧縮の粒が乗った状態**で測れる。
 * リフレームでは、これが効きの確認でもある——被写体を指す手（`spatial`）は
 * 「そのコマの中で色が浮いている列」を見るので、**量子化の粒は列の色を動かす側**に居る。
 *
 * ## 突き合わせるのは枠そのものではなく、採点
 *
 * 圧縮を通すと生の位置は 1 列ぶんくらい動くので、枠の中心はコマンドラインとぴったりは揃わない。
 * そこで見るのは `score.mjs`（`bench.mjs` と同じ関数）が出す**入れた率・ずれ・泳ぎ**。
 * ここが揃わなければ、配線か、圧縮への弱さのどちらか。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFRAME_FIXTURES, REFRAME_V_FIXTURES, SCENE_FIXTURES, SCENE_FPS } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';
import { launch, loadPlaywright, serve } from '../browser.mjs';
import { scoreFollow, scoreSwim, totalSwim } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 撮った絵から取る明るさの本数。元が 32 列なので、切り出した 31.6% には 10 本ぶんしか無い。
 *
 * **ここで宣言しているのは、下の `matchCrop` が本体の途中から呼ばれるため。**
 * 末尾に `const` で置くと、呼ぶほうが先に走って初期化前に触ることになる
 * （`function` なら巻き上がるので気づけない）。
 */
const CROP_SAMPLES = 10;

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので画面の確認は飛ばします（計算は npm run lab:test で確認できます）。');
  process.exit(0);
}

const {
  DEFAULT_REFRAME,
  REFRAME_ANALYSIS_FPS: DEFAULT_REFRAME_FPS,
  VERTICAL_REFRAME,
  planReframe,
  planReframeVertical,
  summarizeForReframe,
  summarizeForReframeVertical,
} = await import('./src/reframe.ts');

let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

const fixtureOf = (name) =>
  [...SCENE_FIXTURES, ...REFRAME_FIXTURES, ...REFRAME_V_FIXTURES].find((f) => f.name === name);

/** コマンドライン側の答え（合成したコマをそのまま測る）。 */
function commandLine(name, { fps = SCENE_FPS, options = {} } = {}) {
  const clip = renderFixture(name, { fps });
  const cols = summarizeForReframe(clip.frames, clip.times, options);
  const centers = planReframe(cols, options).frames.map((f) => f.center);
  return { times: [...clip.times], centers, cuts: clip.cuts, fps };
}

/**
 * コマンドライン側の答え（**縦の軸**）。
 *
 * 焼く素材と同じ `aspect: 'native'`（最初から縦 9:16）で描く。
 * **ここを `landscape` のままにすると、画面は縦の素材を読んでいるのに
 * 比べる相手だけが横型**になり、ずれの原因が配線なのか素材なのか読めなくなる。
 */
function commandLineVertical(name, { fps = SCENE_FPS, options = {} } = {}) {
  const clip = renderFixture(name, { fps, aspect: 'native' });
  const rows = summarizeForReframeVertical(clip.frames, clip.times, options);
  const centers = planReframeVertical(rows, options).frames.map((f) => f.center);
  return { times: [...clip.times], centers, cuts: clip.cuts, fps };
}

/**
 * 軸を切り替えて、判定が回りきるまで待つ。
 *
 * **読み直しは起きない**（畳む向きが変わるだけ）ので、待つのは `axis` が変わるところまで。
 */
async function setAxis(page, axis) {
  await page.locator('#axis').selectOption(axis);
  await page.waitForFunction((want) => window.__labReframe.state().axis === want, axis, { timeout: 30000 });
  await page.waitForTimeout(300);
}

/**
 * 素材を本物の動画に焼いて、画面へ読ませ、判定が終わるまで待つ。
 *
 * 待ち方を「コマが揃ったか」にしてあるのは、**尺だけ見ると読み込み途中で通ってしまう**ため。
 *
 * `aspect` は焼くときの形。縦の軸の素材は `native`（最初から縦 9:16）で焼く
 * ——`portrait`（横型から切り出す）ではないのは、**切り出しは横の動きを 3.2 倍に増幅する**ので
 * 縦の軸の話にならないため（2026-09-22・3 回目に測ってある）。
 */
async function feed(page, name, { fps, bitrate, aspect } = {}) {
  const encoded = await page.evaluate(
    ([n, f, b, a]) =>
      window
        .__labReframeEncode(n, {
          ...(f ? { fps: f } : {}),
          ...(b ? { bitrate: b } : {}),
          ...(a ? { aspect: a } : {}),
        })
        .then((r) => ({
          bytes: [...r.bytes],
          cuts: r.cuts,
          fps: r.fps,
          frames: r.frames,
          codec: r.codec,
        })),
    [name, fps ?? null, bitrate ?? null, aspect ?? null],
  );
  await page.locator('#rf-file').setInputFiles({
    name: `${name}.webm`,
    mimeType: 'video/webm',
    buffer: Buffer.from(encoded.bytes),
  });
  await page.waitForFunction(
    () => window.__labReframe.state().frames > 0 && !window.__labReframe.state().loading,
    null,
    { timeout: 90000 },
  );
  await page.waitForTimeout(300);
  return { encoded, state: await page.evaluate(() => window.__labReframe.state()) };
}

/**
 * 読み込み直す速さを変えて、読み終わるまで待つ。
 *
 * つまみを動かすだけでは足りない（速さは**何を読むか**の話なので読み直しになる）ので、
 * `change` まで投げて、`fps` が実際に変わるのを待つ。
 */
async function readAt(page, fps) {
  await setRange(page, '#fps', String(fps), 100);
  await page.locator('#fps').dispatchEvent('change');
  await page.waitForFunction(
    (want) => !window.__labReframe.state().loading && Math.abs((window.__labReframe.state().fps ?? 0) - want) < 3,
    fps,
    { timeout: 120000 },
  );
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__labReframe.state());
}

/** つまみを動かして、判定が回りきるまで待つ。 */
async function setRange(page, selector, value, settle = 500) {
  await page.locator(selector).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.waitForTimeout(settle);
}

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1000, height: 1500 }, deviceScaleFactor: 2 })
  ).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(server.url, { waitUntil: 'networkidle' });
  // 焼く部品は画面には入っていないので、確かめるときだけ差し込む。
  await page.addScriptTag({ type: 'module', url: './testkit/encode.ts' });
  await page.waitForFunction(() => typeof window.__labReframeEncode === 'function', null, { timeout: 30000 });

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

  // **既定は画面に直書きせず、判定の側から写している。** ここが落ちたら、
  // 画面だけが別の設定で動いていることになる（数字は出たままなので気づけない）。
  const defaults = await page.evaluate(() => window.__labReframe.defaults);
  ok(
    '画面の既定が判定の側から来ている',
    Math.abs(defaults.reframe.cropWidth - 81 / 256) < 1e-9 &&
      defaults.reframe.deadband === 0.03 &&
      defaults.reframe.gate === 'soft' &&
      defaults.reframe.maxSpeed === 0.22 &&
      defaults.reframe.settle === 0.3 &&
      defaults.reframe.smooth === 1 &&
      defaults.reframe.rowBand.from === 0.15 &&
      defaults.reframe.leadIn === true &&
      defaults.analysisFps === DEFAULT_REFRAME_FPS,
    `${JSON.stringify(defaults.reframe)} / ${defaults.analysisFps}fps`,
  );
  // **コマの速さも、目盛りが表せるかまで見る**（窓の幅で 1 度踏んだ穴）。
  // こちらは 1fps きざみなので 30 は乗るが、**乗らない値を既定にしたときに黙って外れる**
  // のは同じなので、画面が実際に持っている値を見る。
  ok(
    'コマの速さのつまみが、既定をちょうど表せている',
    Number(await page.locator('#fps').inputValue()) === DEFAULT_REFRAME_FPS,
    `画面 ${await page.locator('#fps').inputValue()}fps / 判定 ${DEFAULT_REFRAME_FPS}fps`,
  );

  // --- 素直な素材: 焼く → 読む → 枠を決める ---
  const motion = await feed(page, 'motion');
  ok(
    '焼いた動画が本物として読めている',
    motion.state.frames > 180 && motion.state.duration > 12.5 && Math.abs(motion.state.sourceFps - 15) < 1.5,
    `${motion.encoded.codec} ・ ${motion.state.frames} コマ ・ ${motion.state.duration?.toFixed(2)}s ・ 素材 ${motion.state.sourceFps?.toFixed(1)}fps`,
  );
  ok(
    'コマは長辺 128 まで縮めて読んでいる',
    motion.state.width === 128 && motion.state.height === 72,
    `${motion.state.width}×${motion.state.height}`,
  );
  ok('コマの欠けが無い', motion.state.missing === 0, `${motion.state.missing} 枚`);
  ok('統計が画面に出る', (await page.locator('#rf-stats div').count()) === 8);
  // **既定が「写っている」だけでは足りない。つまみの目盛りが既定を表せるかまで見る。**
  // 目盛りが 0.005 きざみだったとき、画面は既定（81/256 = 0.31640625）を表せずに
  // 黙って 0.315 で動いていた。既定を写す行は通っているので、そこを見ても気づけない。
  ok(
    'つまみの目盛りが既定をちょうど表せている（画面が別の幅で動いていない）',
    Math.abs(motion.state.cropWidth - DEFAULT_REFRAME.cropWidth) < 1e-12,
    `画面 ${motion.state.cropWidth} / 判定 ${DEFAULT_REFRAME.cropWidth}`,
  );
  ok('枠の動きが描かれている', await hasInk(page, 'rf-canvas'));

  // **ここがこの確認のいちばんの目的。** 画面で出た枠を、コマンドラインと同じ物差しで
  // 採点して突き合わせる。判定を画面でやり直していたらここでずれる。
  console.log('\n画面（焼いた動画）とコマンドライン（合成コマ）の突き合わせ\n');
  console.log('素材                   入れた率（画面 / CLI）      ずれ（画面 / CLI）');
  console.log('-'.repeat(68));
  for (const name of ['motion', 'subject-pan', 'subject-pause', 'subject-cuts', 'subject-static', 'subject-decoy']) {
    const { state } = name === 'motion' ? motion : await feed(page, name);
    const cli = commandLine(name);
    const fixture = fixtureOf(name);
    const screen = scoreFollow(fixture, state.times, state.centers, state.cropWidth);
    const command = scoreFollow(fixture, cli.times, cli.centers, DEFAULT_REFRAME.cropWidth);
    console.log(
      `${name.padEnd(20)} ${`${screen.inside.toFixed(1)}%`.padStart(8)} / ${`${command.inside.toFixed(1)}%`.padStart(7)}` +
        `      ${screen.error.toFixed(3)} / ${command.error.toFixed(3)}`,
    );
    // 幅は 6 ポイント。圧縮の粒で生の位置が 1 列（3.1%）動くと、deadband の縁に居るコマの
    // 行き先が変わるので、ぴったり一致は求められない。
    //
    // **3 ポイントから広げたのは、その幅を測ったから**（2026-09-25・2 回目）。
    // 中身も速さも変えずに**焼くビットレートだけ**振ると、入れた率は
    // `motion` で 92.6〜98.4%（5.7pt）・`subject-decoy` で 92.6〜96.7%（4.1pt）動く。
    // 3 ポイントは、**この判定が同じ動画の焼き直しで動く幅より狭かった。**
    // それでも**判定が別物なら 6 ポイントでは収まらない**（枠を真ん中に固定すると 68pt ずれる。
    // 下にその検査が置いてある）。
    ok(
      `${name}: 画面とコマンドラインで、入れた率が揃う`,
      Math.abs(screen.inside - command.inside) <= 6,
      `コマンドライン ${command.inside.toFixed(1)}% ・ 画面 ${screen.inside.toFixed(1)}%（ずれ ${command.error.toFixed(3)} / ${screen.error.toFixed(3)}）`,
    );
  }

  // --- 自分の手を潰す素材（1）: 被写体が居ない ---
  //
  // **入れた率だけを見ると「ずっと貼り付ける」が満点になる**ので、居ない側を必ず併せて見る。
  // ここで圧縮が効くとしたら、**粒が列の色を動かして枠を泳がせる**向き。
  for (const name of ['captions-only', 'cuts-plain']) {
    const { state } = await feed(page, name);
    const cli = commandLine(name);
    const fixture = fixtureOf(name);
    const screen = scoreSwim(state.times, state.centers, fixture.cuts, SCENE_FPS);
    const command = scoreSwim(cli.times, cli.centers, fixture.cuts, SCENE_FPS);
    ok(
      `${name}: 被写体が居ないとき、画面でも枠が泳がない`,
      screen.swim <= Math.max(command.swim, 0.01) + 0.02,
      `コマンドライン ${command.swim.toFixed(3)} / 秒 ・ 画面 ${screen.swim.toFixed(3)} / 秒`,
    );
  }

  // --- 自分の手を潰す素材（2）: 上下の帯を外す ---
  //
  // 既定（上下 15% を見ない）を選んだ理由がここ。**数字が動くことではなく、
  // 守っていたものが壊れること**で「その線が画面から効いている」を見る。
  const caps = await feed(page, 'captions-only');
  const capsDefault = scoreSwim(caps.state.times, caps.state.centers, [], SCENE_FPS);
  await setRange(page, '#row-band', '0');
  const capsFull = await page.evaluate(() => window.__labReframe.state());
  const capsFullScore = scoreSwim(capsFull.times, capsFull.centers, [], SCENE_FPS);
  ok(
    '上下の帯を外すと、字幕だけの素材で枠が泳ぎ出す',
    capsFullScore.swim > capsDefault.swim * 3 && capsFullScore.range > capsDefault.range * 3,
    `泳ぎ ${capsDefault.swim.toFixed(3)} → ${capsFullScore.swim.toFixed(3)} / 振れ幅 ${capsDefault.range.toFixed(3)} → ${capsFullScore.range.toFixed(3)}`,
  );
  await setRange(page, '#row-band', String(DEFAULT_REFRAME.rowBand.from));

  // --- コマの速さ（シーン検出との違いを、画面から確かめる） ---
  //
  // シーン検出は既定のつまみが **15fps という単位を隠し持っていた**ので、速いまま渡すと壊れた。
  // こちらが 30 を持っている理由は、**2026-09-25（3 回目）に入れ替わった。**
  //
  // 2 回目に 30 を選んだ理由は「間引くと焼き直しで答えが振れる（4.1pt 対 0.4pt）」だった。
  // その振れは**門が増幅器だったせい**で、門を `soft` にしたら
  // **どちらの読み方でも 0.0pt になった**（`npm run lab:reframe:decimate`）。
  // つまり**当時の理由は、もう残っていない。**
  //
  // それでも 30 のままにしているのは別の理由で、**間引くとカメラの動く素材で泳ぐ**から
  // （`pan` が 0.029 → 0.091 / 秒）。下の 2 つは、その 2 つをそれぞれ押さえる。
  // 合成コマでは 1 桁も動かないので、**ここは画面でしか測れない。**
  const fast = await feed(page, 'motion', { fps: 30 });
  ok(
    '30fps の素材を、既定では間引かずに読む（シーン検出の 15fps とは別に持っている）',
    Math.abs(fast.state.sourceFps - 30) < 3 && Math.abs(fast.state.fps - 30) < 0.5,
    `素材 ${fast.state.sourceFps?.toFixed(1)}fps → 解析 ${fast.state.fps?.toFixed(1)}fps（${fast.state.frames} コマ）`,
  );
  const dense = fast.state;
  const denseScore = scoreFollow(fixtureOf('motion'), dense.times, dense.centers, dense.cropWidth);

  // 間引いた側へ落とす。**ここで見るのは「落ちるか」ではなく「振れるか」。**
  // 1 回目（9/25）は落ちると書いたが、読む時刻の置き方を直して 7 本並べたら
  // 平均はどちらも 96.5% で同じだった。残ったのは**当たり外れの幅**のほう。
  const decimated = await readAt(page, 15);
  const decimatedScore = scoreFollow(fixtureOf('motion'), decimated.times, decimated.centers, decimated.cropWidth);

  // 同じ素材を**粗く焼き直す**。中身も速さも同じなので、
  // ここで動く幅は「読み方の差」ではなく「この判定の当たり外れ」。
  await feed(page, 'motion', { fps: 30, bitrate: 150_000 });
  const coarseThin = await page.evaluate(() => window.__labReframe.state());
  const coarseThinScore = scoreFollow(fixtureOf('motion'), coarseThin.times, coarseThin.centers, coarseThin.cropWidth);
  const coarseDense = await readAt(page, DEFAULT_REFRAME_FPS);
  const coarseDenseScore = scoreFollow(fixtureOf('motion'), coarseDense.times, coarseDense.centers, coarseDense.cropWidth);

  const thinSpread = Math.abs(decimatedScore.inside - coarseThinScore.inside);
  const denseSpread = Math.abs(denseScore.inside - coarseDenseScore.inside);
  // **門を直したので、ここは「間引いた側のほうが大きい」ではなくなった。**
  // 2 回目はこの行で `thinSpread > denseSpread + 1` を見ていた（15fps 読みで 5.7pt 振れていた）。
  // いまは**どちらも振れない**ので、見るのは「小さいこと」のほう。
  // ここが再び開いたら、門が貯める形へ戻っている。
  ok(
    '焼き直しただけでは答えが動かない（門を直した効きを、画面から見る）',
    thinSpread <= 2 && denseSpread <= 2,
    `15fps 読み ${decimatedScore.inside.toFixed(1)}% → ${coarseThinScore.inside.toFixed(1)}%（${thinSpread.toFixed(1)}pt） / ` +
      `30fps 読み ${denseScore.inside.toFixed(1)}% → ${coarseDenseScore.inside.toFixed(1)}%（${denseSpread.toFixed(1)}pt）` +
      ` ・ 粒は 15fps 読みで ${grain(decimated.raws).toFixed(5)} → ${grain(coarseThin.raws).toFixed(5)} としか動いていない`,
  );

  // **いま 30 を持っている理由のほう。** 間引くと、カメラが動く素材で枠が泳ぐ。
  // 被写体の居ない素材で見るのは、ここに「追えているか」の言い訳が効かないから。
  const panDense = await feed(page, 'pan', { fps: 30 });
  const panDenseSwim = scoreSwim(panDense.state.times, panDense.state.centers, fixtureOf('pan').cuts, SCENE_FPS);
  const panThin = await readAt(page, 15);
  const panThinSwim = scoreSwim(panThin.times, panThin.centers, fixtureOf('pan').cuts, SCENE_FPS);
  ok(
    '間引くと、カメラの動く素材で枠が泳ぐ（いまの既定が 30 である理由）',
    panThinSwim.swim > panDenseSwim.swim * 1.5,
    `30fps 読み ${panDenseSwim.swim.toFixed(3)} / 秒 ・ 15fps 読み ${panThinSwim.swim.toFixed(3)} / 秒`,
  );
  await readAt(page, DEFAULT_REFRAME_FPS);

  // **「窓を広げれば済む」を潰す素材。** 0.8 秒の寄り道は 1.0 秒の窓では中央値に残るが、
  // 2.0 秒の窓では少数派になって消える。ここが落ちなければ、窓を広げる手を選んでいた。
  const dart = await feed(page, 'subject-dart', { fps: 30 });
  const dartDefault = scoreFollow(fixtureOf('subject-dart'), dart.state.times, dart.state.centers, dart.state.cropWidth);
  await setRange(page, '#smooth', '2');
  const dartWide = await page.evaluate(() => window.__labReframe.state());
  const dartWideScore = scoreFollow(fixtureOf('subject-dart'), dartWide.times, dartWide.centers, dartWide.cropWidth);
  ok(
    'ならしの窓を広げると、窓より短い寄り道が消える（だから広げる手は取っていない）',
    dartDefault.inside > dartWideScore.inside + 2,
    `ならし 1.0 秒 ${dartDefault.inside.toFixed(1)}% → 2.0 秒 ${dartWideScore.inside.toFixed(1)}%`,
  );
  await setRange(page, '#smooth', String(DEFAULT_REFRAME.smooth));

  // --- 出来上がりのプレビュー（枠の列 → 実際に見える絵） ---
  //
  // **ここが「絵は読み直していない」の中身。** 切り出した動画を作っていないので、
  // 確かめるのは「元の動画をどれだけ横へずらしているか」が枠と合っているか。
  await feed(page, 'subject-static');
  const shape = await page.evaluate(() => {
    const crop = document.getElementById('rf-crop');
    const out = document.getElementById('rf-video-out');
    return { cropW: crop.clientWidth, cropH: crop.clientHeight, videoW: out.clientWidth, videoH: out.clientHeight };
  });
  // 16:9 を 31.6% で切ると 9:16。切り出した先の形が縦型になっていなければ、
  // 出来上がりは「縦型」ではない（数字は正しくても使えない）。
  ok(
    '出来上がりの覗き窓が 9:16 になっている',
    Math.abs(shape.cropW / shape.cropH - 9 / 16) < 0.02 && Math.abs(shape.videoW / shape.videoH - 16 / 9) < 0.05,
    `窓 ${shape.cropW}×${shape.cropH}（${(shape.cropW / shape.cropH).toFixed(3)}）・ 中の動画 ${shape.videoW}×${shape.videoH}`,
  );

  // 秒を指して、そこの枠とずらし量が合っているか。**この素材は右寄りに居続ける**ので、
  // 真ん中を切っていたらここで落ちる。
  const at = await page.evaluate(async () => {
    const video = document.getElementById('rf-video');
    const out = document.getElementById('rf-video-out');
    video.currentTime = 6;
    out.currentTime = 6;
    await new Promise((r) => setTimeout(r, 500));
    const m = /translateX\((-?[\d.]+)px\)/.exec(out.style.transform || '');
    return {
      center: window.__labReframe.centerAt(video.currentTime),
      shift: m ? Number(m[1]) : NaN,
      videoW: out.clientWidth,
      windowLeft: document.getElementById('rf-window').style.left,
      cropWidth: window.__labReframe.state().cropWidth,
    };
  });
  const wantShift = -(at.center - at.cropWidth / 2) * at.videoW;
  ok(
    'ずらし量が、その秒の枠とぴったり合う',
    Math.abs(at.shift - wantShift) < 1,
    `枠の中心 ${at.center.toFixed(3)} → ずらし ${at.shift.toFixed(1)}px（枠から出すと ${wantShift.toFixed(1)}px）`,
  );
  ok(
    '右寄りに居続ける被写体を、真ん中では切っていない',
    at.center > 0.6,
    `枠の中心 ${at.center.toFixed(3)} ・ 元の画に重ねた窓の左端 ${at.windowLeft}`,
  );

  // 窓の幅を変えたら、覗き窓の形も一緒に変わる（画面だけ取り残されないか）。
  // **目盛りに乗る値で試す。** 1/256 きざみなので 0.6 は表せず、0.6015625 へ丸められる
  // （ここを 0.6 と書くと、丸めのぶんだけで落ちる検査になる）。
  const WIDE = 154 / 256;
  await setRange(page, '#crop-width', String(WIDE));
  const wide = await page.evaluate(() => ({
    cropW: document.getElementById('rf-crop').clientWidth,
    cropH: document.getElementById('rf-crop').clientHeight,
    cropWidth: window.__labReframe.state().cropWidth,
  }));
  ok(
    '窓の幅を変えると、出来上がりの形も一緒に変わる',
    Math.abs(wide.cropW / wide.cropH - (16 / 9) * WIDE) < 0.05 && Math.abs(wide.cropWidth - WIDE) < 1e-12,
    `31.6% で ${(shape.cropW / shape.cropH).toFixed(3)} → ${(WIDE * 100).toFixed(1)}% で ${(wide.cropW / wide.cropH).toFixed(3)}`,
  );
  await setRange(page, '#crop-width', String(DEFAULT_REFRAME.cropWidth));

  // --- 人が見る絵が、本当に枠の所か ---
  //
  // **数字が合っていても、ずらす向きを間違えれば人が見る絵は別の所になる。**
  // ここだけは画面を撮って中身を読む。撮った縦型の明るさの形を、
  // 元のコマの列（32 列）の上で滑らせて、いちばん合う位置を探す。
  // その位置が枠の左端と合っていれば、見せている絵は枠の所だと言える。
  await page.evaluate(async () => {
    const video = document.getElementById('rf-video');
    const out = document.getElementById('rf-video-out');
    video.currentTime = 6;
    out.currentTime = 6;
    await new Promise((r) => setTimeout(r, 600));
  });
  const shown = await matchCrop(page);
  ok(
    '出来上がりに映っているのが、枠の所の絵',
    Math.abs(shown.best - shown.want) < 0.06,
    `いちばん合う左端 ${shown.best.toFixed(3)}（枠の左端 ${shown.want.toFixed(3)} ・ 相関 ${shown.r.toFixed(3)}）`,
  );

  // **わざと壊して、同じ検査が落ちることまで確かめる**（2026-09-23・2 回目の教訓）。
  // ずらしを 0 に戻すと、映るのは画面の左端になる。
  await page.evaluate(() => {
    document.getElementById('rf-video-out').style.transform = 'translateX(0px)';
  });
  const broken = await matchCrop(page);
  ok(
    'ずらしを消すと、同じ検査が落ちる（検査が効いている）',
    Math.abs(broken.best - broken.want) > 0.06 && broken.best < 0.1,
    `いちばん合う左端 ${broken.best.toFixed(3)}（枠の左端 ${broken.want.toFixed(3)}）`,
  );

  // --- わざと壊して FAIL することを確かめる（2026-09-23・2 回目の教訓） ---
  //
  // 「検査を書いたら、わざと壊して FAIL することまで確かめること」。
  // ここでは枠を真ん中に固定した列を、上と同じ採点へ通す。
  const fixedCenters = motion.state.centers.map(() => 0.5);
  const fixedScore = scoreFollow(fixtureOf('motion'), motion.state.times, fixedCenters, motion.state.cropWidth);
  const movedScore = scoreFollow(fixtureOf('motion'), motion.state.times, motion.state.centers, motion.state.cropWidth);
  ok(
    '枠を真ん中に固定すると、同じ採点が落ちる（検査が効いている）',
    Math.abs(fixedScore.inside - movedScore.inside) > 3 && fixedScore.inside < movedScore.inside,
    `追う ${movedScore.inside.toFixed(1)}% 対 ずっと真ん中 ${fixedScore.inside.toFixed(1)}%（泳ぎ ${totalSwim(motion.state.times, motion.state.centers).toFixed(3)} 対 0.000）`,
  );

  // ================================================================
  // 縦の軸（2026-10-04・2 回目に足した）
  //
  // 最初から縦（9:16）で撮った素材から 1:1 を切る。判定の側は 1 回目に入っていて、
  // **画面だけが無かった**（読み込む → 枠を決める → 1:1 を切って見せる、を通していない）。
  // ここで見るのは横と同じ 3 つ——既定が判定の側から来ているか、
  // 画面とコマンドラインで採点が揃うか、人が見る絵が本当に枠の所か。
  // ================================================================

  await setAxis(page, 'v');

  // **既定は軸ごとに別**なので、切り替えたらつまみが縦の既定へ書き直されていなければならない。
  // `defaults.vertical` は判定の側の値、つまみは画面が実際に持っている値。両方を突き合わせる。
  const vDefaults = await page.evaluate(() => window.__labReframe.defaults.vertical);
  const vKnobs = await page.evaluate(() => ({
    crop: Number(document.getElementById('crop-width').value),
    row: Number(document.getElementById('row-band').value),
    axisBand: Number(document.getElementById('axis-band').value),
    axisBandShown: !document.getElementById('axis-band').closest('label').hidden,
  }));
  ok(
    '縦へ切り替えると、つまみが縦の既定へ書き直される（判定の側から来ている）',
    Math.abs(vDefaults.cropWidth - 9 / 16) < 1e-12 &&
      Math.abs(vKnobs.crop - VERTICAL_REFRAME.cropWidth) < 1e-12 &&
      vKnobs.row === VERTICAL_REFRAME.rowBand.from &&
      vKnobs.axisBand === VERTICAL_REFRAME.axisBand.from &&
      vDefaults.axisBand.from === VERTICAL_REFRAME.axisBand.from,
    `窓の高さ ${vKnobs.crop}（判定 ${VERTICAL_REFRAME.cropWidth}）・ 畳む帯 ${vKnobs.row} ・ 軸の上の帯 ${vKnobs.axisBand}`,
  );
  ok('縦の軸だけのつまみ（axisBand）が、縦で出ている', vKnobs.axisBandShown);

  const vStatic = await feed(page, 'vsubject-static', { aspect: 'native' });
  ok(
    '縦の素材が縦として読めている（長辺 128 を高さで揃える）',
    vStatic.state.width === 72 && vStatic.state.height === 128 && vStatic.state.axis === 'v',
    `${vStatic.state.width}×${vStatic.state.height} ・ 軸 ${vStatic.state.axis} ・ ${vStatic.state.frames} コマ`,
  );
  ok(
    '縦の窓の高さが、目盛りの上でも既定をちょうど表せている',
    Math.abs(vStatic.state.cropWidth - VERTICAL_REFRAME.cropWidth) < 1e-12,
    `画面 ${vStatic.state.cropWidth} / 判定 ${VERTICAL_REFRAME.cropWidth}`,
  );
  ok('縦でも枠の動きが描かれている', await hasInk(page, 'rf-canvas'));

  // **突き合わせ（縦）。** 横と同じく 6 ポイントの幅で見る（理由は横の注）。
  console.log('\n縦の軸: 画面（焼いた動画）とコマンドライン（合成コマ）の突き合わせ\n');
  console.log('素材                   入れた率（画面 / CLI）      ずれ（画面 / CLI）');
  console.log('-'.repeat(68));
  const vScreen = {};
  for (const name of ['vsubject-static', 'vsubject-pause', 'vsubject-tilt', 'vsubject-cuts', 'vsubject-captions', 'vsubject-horizon']) {
    const { state } = name === 'vsubject-static' ? vStatic : await feed(page, name, { aspect: 'native' });
    const cli = commandLineVertical(name);
    const fixture = fixtureOf(name);
    const screen = scoreFollow(fixture, state.times, state.centers, state.cropWidth, 'native', 'v');
    const command = scoreFollow(fixture, cli.times, cli.centers, VERTICAL_REFRAME.cropWidth, 'native', 'v');
    vScreen[name] = { state, screen, command };
    console.log(
      `${name.padEnd(20)} ${`${screen.inside.toFixed(1)}%`.padStart(8)} / ${`${command.inside.toFixed(1)}%`.padStart(7)}` +
        `      ${screen.error.toFixed(3)} / ${command.error.toFixed(3)}`,
    );
    ok(
      `${name}: 縦でも、画面とコマンドラインで入れた率が揃う`,
      Math.abs(screen.inside - command.inside) <= 6,
      `コマンドライン ${command.inside.toFixed(1)}% ・ 画面 ${screen.inside.toFixed(1)}%（ずれ ${command.error.toFixed(3)} / ${screen.error.toFixed(3)}）`,
    );
  }

  // **縦の窓は横の 1.8 倍広いので、入れた率だけでは甘い**（1 回目の記録）。
  // ずれでも突き合わせる。幅は**縦の窓の死に帯（0.03）ぶん**——生の位置が圧縮の粒で
  // 1 行（3.1%）動くと、止まる所がそのぶん変わりうるので、それより細かくは求めない。
  const vErr = Object.entries(vScreen).map(([n, v]) => [n, Math.abs(v.screen.error - v.command.error)]);
  const vErrWorst = vErr.reduce((a, b) => (b[1] > a[1] ? b : a));
  ok(
    '縦でも、画面とコマンドラインでずれ（中央値）が死に帯の内で揃う',
    vErrWorst[1] <= VERTICAL_REFRAME.deadband,
    `いちばん離れた素材 ${vErrWorst[0]}：${vErrWorst[1].toFixed(3)}（死に帯 ${VERTICAL_REFRAME.deadband}）`,
  );

  // 被写体の居ない素材でも泳がないか（縦）。**字幕だけの素材は縦で意地悪が効く側**なので、
  // `captions-only` を選んでいる（縦の軸では字幕が軸の上に載る）。
  {
    const name = 'captions-only';
    const { state } = await feed(page, name, { aspect: 'native' });
    const cli = commandLineVertical(name);
    const fixture = fixtureOf(name);
    const screen = scoreSwim(state.times, state.centers, fixture.cuts, SCENE_FPS);
    const command = scoreSwim(cli.times, cli.centers, fixture.cuts, SCENE_FPS);
    ok(
      `${name}: 縦でも、被写体が居ないときに画面でコマンドラインより泳がない`,
      screen.swim <= Math.max(command.swim, 0.01) + 0.02,
      `コマンドライン ${command.swim.toFixed(3)} / 秒 ・ 画面 ${screen.swim.toFixed(3)} / 秒`,
    );
  }

  // --- 自分の手を潰す素材（縦）: 軸の上の帯を外す ---
  //
  // `axisBand` を選んだ理由がここ。**字幕が軸の上に載っている**ので、締め出しを外すと
  // 判定が被写体ではなく字幕を指す。画面からそのつまみが効いていることを、
  // **守っていたものが壊れること**で確かめる。
  const vCaps = await feed(page, 'vsubject-captions', { aspect: 'native' });
  const vCapsDefault = scoreFollow(fixtureOf('vsubject-captions'), vCaps.state.times, vCaps.state.centers, vCaps.state.cropWidth, 'native', 'v');
  await setRange(page, '#axis-band', '0');
  const vCapsOpen = await page.evaluate(() => window.__labReframe.state());
  const vCapsOpenScore = scoreFollow(fixtureOf('vsubject-captions'), vCapsOpen.times, vCapsOpen.centers, vCapsOpen.cropWidth, 'native', 'v');
  ok(
    '軸の上の帯を外すと、字幕の乗った縦の素材でずれが大きくなる（締め出しが画面から効いている）',
    vCapsOpenScore.error > vCapsDefault.error * 3,
    `ずれ ${vCapsDefault.error.toFixed(3)} → ${vCapsOpenScore.error.toFixed(3)}（入れた率 ${vCapsDefault.inside.toFixed(1)}% → ${vCapsOpenScore.inside.toFixed(1)}%）`,
  );
  await setRange(page, '#axis-band', String(VERTICAL_REFRAME.axisBand.from));

  // --- 軸の往復で、同じ素材から同じ枠が出る ---
  //
  // 軸を替えると畳み直しになる。**往復して戻ったときに、前の軸で畳んだ列が残っていたら
  // 縦の判定へ横の列を渡すことになる**（数字は出たままなので気づけない）。
  //
  // **往復して同じ、だけでは足りない。** 切り替えで 1 度も畳み直していなければ、
  // 往復しても当然同じ列が出てくる（横のあいだ、横の判定に縦の行を渡していたことになる）。
  //
  // しかも**既定のままだと、この穴は既定の違いに隠れる**（2026-10-04・2 回目に壊して分かった）。
  // 軸を替えると既定が写し直され、畳む帯が 0（縦）↔ 0.15（横）と必ず動くので、
  // 「軸が変わったら畳み直す」を消しても**帯の違いだけで畳み直しが起きて、検査が素通りした。**
  // なので縦のまま帯を横の既定（0.15）へ揃えてから替える。こうすると軸のほかに畳み直す理由が無い。
  {
    const lumaAt = () => window.__labReframe.columnLuma(6);
    const before = await page.evaluate(() => window.__labReframe.state().centers);
    await setRange(page, '#row-band', String(DEFAULT_REFRAME.rowBand.from));
    const rowsV = await page.evaluate(lumaAt);
    await setAxis(page, 'u');
    const across = await page.evaluate(() => window.__labReframe.state());
    const colsU = await page.evaluate(lumaAt);
    await setAxis(page, 'v');
    const after = await page.evaluate(() => window.__labReframe.state().centers);
    const same = before.length === after.length && before.every((c, i) => Math.abs(c - after[i]) < 1e-12);
    const refolded = rowsV.some((v, i) => Math.abs(v - colsU[i]) > 1e-3);
    ok(
      '軸を替えると畳み直している（畳む帯を揃えても、横のあいだの 32 本が縦のときと別物）',
      refolded,
      `6 秒の 32 本: 縦 ${rowsV.slice(0, 4).map((v) => v.toFixed(3)).join(',')}… / 横 ${colsU.slice(0, 4).map((v) => v.toFixed(3)).join(',')}…`,
    );
    ok(
      '軸を往復しても、同じ素材から同じ枠が出る（前の軸の列を引きずらない）',
      same && Math.abs(across.cropWidth - DEFAULT_REFRAME.cropWidth) < 1e-12,
      `往復の差 ${same ? 0 : '有り'} ・ 横にいたあいだの窓 ${across.cropWidth.toFixed(4)}`,
    );
  }

  // --- 出来上がり（縦）: 1:1 で、縦へずらしている ---
  await feed(page, 'vsubject-pause', { aspect: 'native' });
  const vShape = await page.evaluate(() => {
    const crop = document.getElementById('rf-crop');
    const out = document.getElementById('rf-video-out');
    return { cropW: crop.clientWidth, cropH: crop.clientHeight, videoW: out.clientWidth, videoH: out.clientHeight };
  });
  ok(
    '縦の出来上がりの覗き窓が 1:1 になっている',
    Math.abs(vShape.cropW / vShape.cropH - 1) < 0.02 && Math.abs(vShape.videoW / vShape.videoH - 9 / 16) < 0.02,
    `窓 ${vShape.cropW}×${vShape.cropH}（${(vShape.cropW / vShape.cropH).toFixed(3)}）・ 中の動画 ${vShape.videoW}×${vShape.videoH}`,
  );

  // **覗き窓を何度並べ直しても縮まない**（`clientHeight` を基準にしていたら、呼ぶたびに縮む）。
  await page.evaluate(() => {
    for (let i = 0; i < 4; i += 1) window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(200);
  const vShapeAgain = await page.evaluate(() => ({
    cropW: document.getElementById('rf-crop').clientWidth,
    cropH: document.getElementById('rf-crop').clientHeight,
  }));
  ok(
    '並べ直しても、縦の覗き窓の大きさが変わらない（基準を自分の答えから取っていない）',
    vShapeAgain.cropW === vShape.cropW && vShapeAgain.cropH === vShape.cropH,
    `${vShape.cropW}×${vShape.cropH} → ${vShapeAgain.cropW}×${vShapeAgain.cropH}`,
  );

  // 秒を指して、そこの枠とずらし量（縦）が合っているか。
  // **12 秒を選んだのは、枠が下寄り（0.7 あたり）に居る秒だから**——
  // ずらしを消したときに映る「画面のいちばん上」と、はっきり離れていてほしい。
  const vAt = await page.evaluate(async () => {
    const video = document.getElementById('rf-video');
    const out = document.getElementById('rf-video-out');
    video.currentTime = 12;
    out.currentTime = 12;
    await new Promise((r) => setTimeout(r, 600));
    const m = /translateY\((-?[\d.]+)px\)/.exec(out.style.transform || '');
    const win = document.getElementById('rf-window');
    return {
      center: window.__labReframe.centerAt(video.currentTime),
      shift: m ? Number(m[1]) : NaN,
      transform: out.style.transform,
      videoH: out.clientHeight,
      windowTop: win.style.top,
      windowLeft: win.style.left,
      windowWidth: win.style.width,
      cropWidth: window.__labReframe.state().cropWidth,
    };
  });
  const vWant = -(vAt.center - vAt.cropWidth / 2) * vAt.videoH;
  ok(
    '縦のずらし量が、その秒の枠とぴったり合う（横ではなく縦へずらしている）',
    Math.abs(vAt.shift - vWant) < 1 && !/translateX/.test(vAt.transform),
    `枠の中心 ${vAt.center.toFixed(3)} → ${vAt.transform}（枠から出すと ${vWant.toFixed(1)}px）`,
  );
  ok(
    '元の画に重ねた窓が、横いっぱいで縦に置かれている（横の軸の値を引きずっていない）',
    (vAt.windowLeft === '0px' || vAt.windowLeft === '0') && vAt.windowWidth === '100%',
    `left ${vAt.windowLeft} ・ width ${vAt.windowWidth} ・ top ${vAt.windowTop}`,
  );
  ok('下寄りに居る被写体を、真ん中では切っていない', vAt.center > 0.6, `枠の中心 ${vAt.center.toFixed(3)}`);

  const vShown = await matchCrop(page);
  ok(
    '縦の出来上がりに映っているのが、枠の所の絵',
    Math.abs(vShown.best - vShown.want) < 0.06,
    `いちばん合う上端 ${vShown.best.toFixed(3)}（枠の上端 ${vShown.want.toFixed(3)} ・ 相関 ${vShown.r.toFixed(3)}）`,
  );
  // わざと壊す。ずらしを消すと、映るのは画面のいちばん上になる。
  await page.evaluate(() => {
    document.getElementById('rf-video-out').style.transform = 'translateY(0px)';
  });
  const vBroken = await matchCrop(page);
  ok(
    '縦のずらしを消すと、同じ検査が落ちる（検査が効いている）',
    Math.abs(vBroken.best - vBroken.want) > 0.06 && vBroken.best < 0.1,
    `いちばん合う上端 ${vBroken.best.toFixed(3)}（枠の上端 ${vBroken.want.toFixed(3)}）`,
  );
  // **向きを取り違えた壊し方も試す。** 縦の軸で横へずらすと、1:1 の窓の中で絵が横へ逃げるだけで、
  // 縦の位置は画面のいちばん上のまま。数字（translate の量）は合っていても絵は別の所になる。
  await page.evaluate((shift) => {
    document.getElementById('rf-video-out').style.transform = `translateX(${shift}px)`;
  }, vWant);
  const vSideways = await matchCrop(page);
  ok(
    '縦の軸で横へずらすと、同じ検査が落ちる（向きの取り違えを見分けている）',
    Math.abs(vSideways.best - vSideways.want) > 0.06,
    `いちばん合う上端 ${vSideways.best.toFixed(3)}（枠の上端 ${vSideways.want.toFixed(3)}）`,
  );

  // 枠を真ん中に固定した列を、同じ採点へ通す（縦）。**`vsubject-tilt` はずっと真ん中で 55.7%** なので、
  // 追っていなければここで落ちる。
  {
    const t = vScreen['vsubject-tilt'];
    const fixed = scoreFollow(fixtureOf('vsubject-tilt'), t.state.times, t.state.centers.map(() => 0.5), t.state.cropWidth, 'native', 'v');
    ok(
      '縦でも、枠を真ん中に固定すると同じ採点が落ちる（検査が効いている）',
      t.screen.inside > fixed.inside + 10,
      `追う ${t.screen.inside.toFixed(1)}% 対 ずっと真ん中 ${fixed.inside.toFixed(1)}%`,
    );
  }

  // --- 画面の記録（縦） ---
  await page.evaluate(async () => {
    const video = document.getElementById('rf-video');
    const out = document.getElementById('rf-video-out');
    video.currentTime = 6;
    out.currentTime = 6;
    await new Promise((r) => setTimeout(r, 400));
  });
  const vShot = path.join(here, '../fixtures/out/uitest-reframe-v.png');
  fs.mkdirSync(path.dirname(vShot), { recursive: true });
  await page.screenshot({ path: vShot, fullPage: true });
  console.log(`\n画面の記録（縦）: ${vShot}`);

  // 横へ戻す（下の記録は横の画面）。
  await setAxis(page, 'u');

  // --- 画面の記録 ---
  await feed(page, 'subject-pause');
  const shot = path.join(here, '../fixtures/out/uitest-reframe.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\n画面の記録: ${shot}`);

  ok('ページ例外なし', errors.length === 0, errors.slice(0, 3).join(' / '));
} finally {
  await browser.close();
  server.stop();
}

if (failed > 0) {
  console.error(`\n${failed} 件が失敗しています。`);
  process.exit(1);
}
console.log('\nすべて通りました。');

/**
 * 画面に映っている切り出しが、元のコマのどこを切ったものかを当てる。
 *
 * 撮った絵から明るさの形（10 本）を作り、元のコマの軸の上の 32 本の上を
 * 1/256 きざみで滑らせて、いちばん相関の高い始まりを返す。
 * **中身を見ずに「ずらし量が合っているか」だけを見ると、向きを間違えても通る。**
 *
 * **軸は画面から読む**（`state().axis`）。縦の軸では標本を**行**で取り、
 * 畳んだときに落とした帯も軸と垂直の側（横）になる。
 * ここを横に決め打ちしたままだと、縦の軸では
 * **「32 行を 10 列と比べる」形になって、相関がどこでも低いまま通ってしまう。**
 */
async function matchCrop(page) {
  const png = await page.locator('#rf-crop').screenshot();
  return page.evaluate(async ([b64, samples]) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const vertical = window.__labReframe.state().axis === 'v';
    // 元の 32 本（`columnLuma`）は軸と垂直の側で帯を落としてあるので、こちらも同じ所だけを見る
    // （横の軸では上下 15%、縦の軸では既定で全部）。
    const band = window.__labReframe.state().rowBand;
    const across = vertical ? canvas.width : canvas.height;
    const a0 = Math.floor(across * band.from);
    const a1 = Math.max(a0 + 1, Math.ceil(across * band.to));
    const along = vertical ? canvas.height : canvas.width;
    const shot = [];
    for (let j = 0; j < samples; j += 1) {
      const s0 = Math.floor((j / samples) * along);
      const s1 = Math.max(s0 + 1, Math.floor(((j + 1) / samples) * along));
      let sum = 0;
      let n = 0;
      for (let u = s0; u < s1; u += 1) {
        for (let v = a0; v < a1; v += 1) {
          const p = ((vertical ? u * canvas.width + v : v * canvas.width + u)) * 4;
          sum += (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
          n += 1;
        }
      }
      shot.push(n ? sum / n : 0);
    }

    const video = document.getElementById('rf-video');
    const cols = window.__labReframe.columnLuma(video.currentTime);
    const state = window.__labReframe.state();
    const w = state.cropWidth;
    const corr = (a, b) => {
      const n = a.length;
      const ma = a.reduce((x, y) => x + y, 0) / n;
      const mb = b.reduce((x, y) => x + y, 0) / n;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let i = 0; i < n; i += 1) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
      }
      return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    };
    // 元の列を、その左端から切り出したときの形に直して比べる。
    const at = (u) => {
      const t = u * cols.length - 0.5;
      const i = Math.max(0, Math.min(cols.length - 2, Math.floor(t)));
      const k = Math.max(0, Math.min(1, t - i));
      return cols[i] + (cols[i + 1] - cols[i]) * k;
    };
    let best = 0;
    let bestR = -2;
    for (let x = 0; x <= 1 - w + 1e-9; x += 1 / 256) {
      const profile = [];
      for (let j = 0; j < samples; j += 1) profile.push(at(x + ((j + 0.5) / samples) * w));
      const r = corr(shot, profile);
      if (r > bestR) {
        bestR = r;
        best = x;
      }
    }
    return { best, r: bestR, want: window.__labReframe.centerAt(video.currentTime) - w / 2 };
  }, [png.toString('base64'), CROP_SAMPLES]);
}

/**
 * 生の位置に乗っている**粒**の大きさ。前後の真ん中からどれだけ外れているか（2 階差）。
 *
 * **隣り合うコマの差では駄目**（2026-09-25・2 回目）。それだと被写体が動いた量そのものを
 * 測ることになり、**間引けば必ず倍になる**。1 回目にここへ「生の位置の荒れ 0.0105 → 0.0065」と
 * 書いたのがそれで、粒ではなく標本の間隔を見ていた。
 * 等速で動く被写体は前後の真ん中に乗るので、2 階差を取れば動きが消えて粒だけが残る。
 *
 * 見るのは `raw`（ならす前）。`target` を見ると「ならしが効いた量」を測ることになる。
 */
function grain(raws) {
  if (raws.length < 3) return 0;
  const d = [];
  for (let i = 1; i < raws.length - 1; i += 1) d.push(Math.abs(raws[i] - (raws[i - 1] + raws[i + 1]) / 2));
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

/** キャンバスに何か描かれているか（真っ黒・真っ白のままでないか）。 */
function hasInk(page, id) {
  return page.evaluate((canvasId) => {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return seen.size > 3;
  }, id);
}
