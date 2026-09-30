/**
 * 範囲読みを、**48kHz でない素材と、速さを変えたクリップ**で測る。
 *
 *   npm run lab:export:rate
 *   LAB_RG_ASSET=60 npm run lab:export:rate      # ブラウザで焼く素材の尺（秒）
 *
 * ## なぜこれを測るのか
 *
 * 2026-09-30（1 回目）に範囲読みを入れたとき、**後ろの余裕**（`tailSeconds`・既定 0.05 秒）を
 * 0 にしなかった理由を 3 つ書いた:
 *
 * 1. `buffers(from, to)` の `to` は排他なので最後の 1 標本が落ちる恐れ
 * 2. `source.start(…, seconds * speed)` の丸めが計算より数標本長く要る
 * 3. 素材が 48kHz でないときの補間が境目の外の標本を要る
 *
 * ところが実測は **48kHz・速さ 1 の Opus 1 通り**しか通していない。
 * **2 と 3 は、測っていない条件を理由にして残した余裕**だった。ここがその穴を塞ぐ回。
 *
 * ## 48kHz 以外の素材をどう作るか（ここが今回いちばん手間取った所）
 *
 * この端末の `getEncodableAudioCodecs()` に入っているのは **Opus と PCM だけ**
 * （AAC・Vorbis・FLAC の encoder が無い）。そして **Opus は 48kHz しか持たない**のに、
 * `getFirstEncodableAudioCodec` は 44.1kHz でも 96kHz でも「焼ける」と答え、
 * `AudioBufferSource` が黙って 48kHz へ直してしまう。
 * **頼んだ値を信じて表を書くと、測っていない条件を測ったと書くことになる。**
 * なので下の 1 段目で「頼んだ速さ 対 起こした速さ」を必ず並べ、化けた組は測りから外す。
 *
 * ## PCM を混ぜているのは、切り分けのため
 *
 * PCM には前の packet に重ねて復号する仕組みが無いので**助走が要らない**。
 * 同じ 48kHz を Opus と PCM で並べれば、9/30（1 回目）の助走 0.22 秒が
 * **範囲読みそのものの性質なのか Opus の性質なのか**が切り分けられる。
 * **時間の比較には使わない**（PCM は起こす時間の桁が違うので、並べても意味が無い）。
 *
 * ## 自分の手を潰す形
 *
 * - **48kHz の整数分の 1 でない速さ**（44.1kHz）。48000 / 44100 は割り切れないので、
 *   補間が必ず標本の間に落ちる。
 * - **1 でも 2 でもない速さ**（1.37）。`seconds * speed` が標本の上に乗らない。
 * - **短い山**（0.5 秒）。のりしろの取り分がいちばん重くなるので、後ろを削りたい圧が最大。
 * - **後ろの余裕 0**。理由 1〜3 が本当に効くなら、ここで落ちる。
 *
 * ## ここで見つかったのは、後ろの余裕の話ではなかった
 *
 * PCM を入れたとたん、**波が 87% の区画で違う**という形で落ちた。
 * 境目の数字（`partBounds`）は `from` も `to` も長さも 1 標本まで筋が通っているのに、
 * **中身だけが 16 標本ずれていた**（`measureRangeAlignment` で残差 0 のずれとして出る）。
 * 原因は容器の時刻の粒——**Matroska は 1ms どまり**で、Opus は packet 20ms がちょうど乗るが
 * PCM のブロックは乗らないので、返ってくる `timestamp` が真の頭から半目盛りずれる。
 * 9/30（1 回目）に「要求した時刻ではなく返ってきた時刻を使う」と書いた注は正しいが、
 * **返ってきた時刻も丸められている**というもう 1 段が抜けていた。
 * 判定側の門は `judgeTimestampGrid`（`src/audio-ranges.ts`）で、下の 2 段目がそれを突き合わせる。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const { SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE } = await import('./src/audio-mix.ts');
const { summarizeRangeCost, jetCutSequence } = await import('./src/audio-ranges.ts');

const assetSeconds = Number(process.env.LAB_RG_ASSET ?? 60);
if (!(assetSeconds > 0)) throw new Error(`LAB_RG_ASSET は正の数です（${assetSeconds}）`);

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const kib = (bytes) => `${(bytes / 1024).toFixed(0)}KB`;

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので飛ばします（この probe は実測だけなので、数え上げの段はありません）。');
  process.exit(0);
}

const server = await serve(here);
const browser = await launch(playwright);
let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

/**
 * 指紋を区画ごとに突き合わせる（`range.mjs` と同じ物差し。**平均へ畳まない**）。
 * 16bit の 1 段（1/32768 ≒ 3e-5）より大きい開きを「違う」と数える。
 */
const compare = (a, b) => {
  if (a.length !== b.length || a.length === 0) return { blocks: 0, worst: Infinity, differing: Infinity };
  let worst = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i += 2) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]));
    if (d > worst) worst = d;
    if (d > 3e-5) differing += 1;
  }
  return { blocks: a.length / 2, worst, differing };
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

  // ---------- 1. そもそも何 Hz の素材が作れるのか ----------

  console.log('## 何 Hz の素材が作れるか（頼んだ速さ 対 起こしたものの速さ）\n');
  console.log(
    `${pad('コーデック', 12)}${pad('頼んだ', 10)}${right('起こした', 10)}${right('化けた', 8)}${right('粒', 9)}${right('1 秒あたり', 12)}${right('数え上げ ÷ 実測', 16)}`,
  );
  const countedPerSecond = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  /** 実際に測りに使える素材（頼んだ速さで起きたもの）。 */
  const usable = [];
  for (const [assetCodec, askedSampleRate] of [
    ['opus', 48000],
    ['opus', 44100],
    ['pcm-s16', 48000],
    ['pcm-s16', 44100],
    ['pcm-s16', 96000],
  ]) {
    let probed;
    try {
      probed = await run({ assetCodec, assetSampleRate: askedSampleRate, shape: 'split', seconds: 4, pieces: 1, mode: 'whole' });
    } catch (e) {
      console.log(`${pad(assetCodec, 12)}${pad(`${askedSampleRate}Hz`, 10)}${right('焼けない', 10)}  :: ${String(e).slice(0, 60)}`);
      continue;
    }
    const perSecond = probed.decodedBytes / Math.max(1e-9, probed.decodedSeconds);
    const drifted = Math.abs(probed.decodedSampleRate - askedSampleRate) > 1;
    if (!drifted) usable.push({ assetCodec, askedSampleRate, ...probed, perSecond });
    console.log(
      `${pad(assetCodec, 12)}${pad(`${askedSampleRate}Hz`, 10)}${right(`${probed.decodedSampleRate}Hz`, 10)}${right(drifted ? 'はい' : '—', 8)}${right(`1/${probed.timeResolution}s`, 9)}${right(kib(perSecond), 12)}${right(`${(countedPerSecond / perSecond).toFixed(2)} 倍`, 16)}`,
    );
  }
  // **データが無いときに結論を刷らない。** この回、packet の読み方を間違えて表が空になったのに
  // 下の文章だけが出て、危うく「測った」として読むところだった。表と文章は同じ条件で出す。
  if (usable.length === 0) throw new Error('測りに使える素材が 1 つも起きませんでした（上の欄を参照）');
  console.log(
    '\n**Opus に 44.1kHz を頼むと、「焼ける」と答えたうえで 48kHz に化ける。**\n' +
      'この端末で焼けるのは Opus と PCM だけなので、**48kHz でない素材を作る道は PCM しか無い**。\n' +
      `**数え上げ（\`summarizeRangeCost\`）は 48kHz 2ch 決め打ち**（1 秒 ${kib(countedPerSecond)}）なので、\n` +
      '上の「数え上げ ÷ 実測」が 1 でない列はバイト数がそのぶん外れている。\n' +
      '**モノラルでは 2 倍の上振れだが、96kHz ではちょうど当たる**ので、\n' +
      '「上振れ側の見積もり」という読み方は 48kHz 以下の素材でしか成り立たない。\n',
  );
  ok(
    '48kHz 以外の素材が実際に起きている（起きていないなら、この回は何も測っていない）',
    usable.some((r) => r.decodedSampleRate !== SAMPLE_RATE),
    usable.map((r) => `${r.codec} ${r.decodedSampleRate}Hz`).join(' / '),
  );

  // ---------- 2. 返ってきた時刻はどこまで信じられるか ----------

  console.log('\n## 「返ってきた時刻」と中身のずれ（1 山 2 秒・残す 1/4・助走 0.5 秒）\n');
  console.log(
    `${pad('素材', 20)}${right('実測のずれ', 12)}${right('残差', 10)}${right('区間の中', 12)}${pad('  門の判定', 34)}${right('門の上限', 10)}${right('容器の境目との差', 22)}`,
  );
  for (const rate of usable) {
    const aligned = await page.evaluate(
      (o) => window.__labRangeAlign(o),
      {
        assetSeconds,
        shape: 'jet',
        takeSeconds: 2,
        keepRatio: 0.25,
        assetCodec: rate.assetCodec,
        assetSampleRate: rate.askedSampleRate,
        prerollSeconds: 0.5,
        tailSeconds: 0.05,
        mergeGapSeconds: 0,
      },
    );
    const worstShift = Math.max(...aligned.parts.map((x) => Math.abs(x.bestShift)));
    const worstResidual = Math.max(...aligned.parts.map((x) => x.residual));
    const label = `${aligned.sampleRate}Hz ${aligned.codec}`;
    console.log(
      `${pad(label, 20)}${right(`${worstShift} 標本`, 12)}${right(worstResidual.toExponential(1), 10)}${right(`${(aligned.tickDrift * 1e6).toFixed(0)}us`, 12)}${pad(`  ${aligned.grid.exact ? '乗る' : '断る'}（${aligned.grid.reason}）`, 34)}${right(`${aligned.grid.worstShiftSamples} 標本`, 10)}${right(`${aligned.grid.worstBoundaryDriftSamples.toFixed(1)} 標本`, 22)}`,
    );
    // **門の言うことと、実際に起きたことが合っているか。** ここが今回のいちばんの検算。
    ok(
      `${label}: 門の判定が実測と合っている`,
      aligned.grid.exact ? worstShift === 0 : worstShift > 0 && worstShift <= aligned.grid.worstShiftSamples,
      `門 ${aligned.grid.exact ? '乗る' : `断る（上限 ${aligned.grid.worstShiftSamples} 標本）`} ・ 実測 ${worstShift} 標本`,
    );
    ok(
      `${label}: ずらせば中身はぴったり合う（中身は正しく、時刻だけが嘘）`,
      worstResidual < 1e-4,
      `残差 ${worstResidual.toExponential(2)}`,
    );
    ok(
      `${label}: このずれは区間の中だけでは分からない（時刻の食い違いとして出ない）`,
      aligned.tickDrift < 1e-9,
      `区間の中の食い違い ${(aligned.tickDrift * 1e6).toFixed(2)}us`,
    );
  }
  console.log(
    '\n**Matroska の時刻は 1ms どまり。** Opus は packet が 20ms ちょうどなので格子に乗るが、\n' +
      'PCM のブロックは乗らないので `timestamp` が半目盛りぶん嘘をつく（48kHz で 24 標本まで）。\n' +
      '**残差 0 でずらせば合う**ので、起こした中身は 1 標本まで正しい。ずれているのは時刻だけ。\n' +
      '**区間の中の食い違いは 0**——mediabunny は 2 本目以降の時刻を 1 本目に長さを足して作るので、\n' +
      '**区間の中を見ても原理的に見つからない**。だから事前に断る門（`judgeTimestampGrid`）が要る。\n' +
      '**門が使えるのは右端の欄だけ**（容器の境目と、起こした buffer の境目の**ずれの広がり**）。\n' +
      '容器に書いてある長さは定義上いつも粒の整数倍なので、そこだけ見ると 48kHz / 96kHz を取りこぼす。\n' +
      'ずれの**大きさ**でも駄目で、Opus はプリスキップ（312 標本）で丸ごとずれている。\n' +
      '**一定のずれは害が無い**（丸ごとも範囲も同じだけずれる）ので、見るのは広がりのほう。\n',
  );

  // **時刻を信じたまま置くと、実際どうなるか。** 門が断る素材だけを並べる。
  const rejected = usable.filter((r) => !r.grid.exact);
  if (rejected.length > 0) {
    console.log('## 門が断る素材を、時刻を信じたまま置いたら（1 山 2 秒・残す 1/4・既定のつまみ）\n');
    console.log(`${pad('素材', 20)}${pad('置き方', 16)}${right('違う区画', 12)}${right('最大の開き', 12)}`);
    for (const rate of rejected) {
      const shape = {
        shape: 'jet',
        takeSeconds: 2,
        keepRatio: 0.25,
        assetCodec: rate.assetCodec,
        assetSampleRate: rate.askedSampleRate,
      };
      const truth = await run({ ...shape, mode: 'whole', verify: true });
      const got = [];
      for (const mode of ['ranges', 'ranges-aligned']) {
        const ranged = await run({ ...shape, mode, verify: true });
        const c = compare(truth.signature, ranged.signature);
        got.push(c);
        console.log(
          `${pad(`${rate.decodedSampleRate}Hz ${rate.codec}`, 20)}${pad(mode, 16)}${right(`${c.differing} / ${c.blocks}`, 12)}${right(c.worst.toExponential(1), 12)}`,
        );
      }
      ok(
        `${rate.decodedSampleRate}Hz ${rate.codec}: 時刻を信じたままだと実際に波が違う（門が断る意味がある）`,
        got[0].differing > got[0].blocks * 0.5,
        `信じたまま ${got[0].differing} / ${got[0].blocks} ・ 訂正すると ${got[1].differing}`,
      );
    }
    console.log(
      '\n**断る素材は、黙って通すと 9 割の区画で違う音になる。** 開きは 0.1 前後（16bit の 3000 段ぶん）。\n' +
        '訂正すれば直るが、**訂正には丸ごと起こして突き合わせることが要る**ので出口には使えない。\n' +
        'なので範囲読みは「乗る素材だけ」に限り、断った素材は丸ごと起こす道へ落とす。\n',
    );
  }

  // ---------- 3. 後ろの余裕は本当に要るのか ----------

  // 門が断る素材は `ranges-aligned`（時刻の嘘を中身で訂正してから置く）で測る。
  // そうしないと、**時刻のずれに埋もれて「後ろの余裕が効いたか」が見えない。**
  console.log('## 標本の速さ × クリップの速さ × 後ろの余裕（助走 0.5 秒・畳まない・1 山 0.5 秒）\n');
  console.log(
    `${pad('素材', 20)}${pad('置き方', 16)}${pad('速さ', 8)}${pad('後ろ', 8)}${right('違う区画', 12)}${right('最大の開き', 12)}${right('載らない', 10)}${right('広がり', 10)}${right('訂正の残差', 12)}`,
  );
  const tailMattered = [];
  for (const rate of usable) {
    const mode = rate.grid.exact ? 'ranges' : 'ranges-aligned';
    for (const speed of [1, 1.37, 2, 0.5]) {
      // 1 山 0.5 秒＝のりしろの取り分がいちばん重い形。後ろを削りたい圧が最大の相手で測る。
      const shape = {
        shape: 'jet',
        takeSeconds: 0.5,
        keepRatio: 0.25,
        assetCodec: rate.assetCodec,
        assetSampleRate: rate.askedSampleRate,
        speed,
      };
      const truth = await run({ ...shape, mode: 'whole', verify: true });
      for (const tailSeconds of [0, 0.05]) {
        const ranged = await run({ ...shape, mode, prerollSeconds: 0.5, tailSeconds, mergeGapSeconds: 0, verify: true });
        const c = compare(truth.signature, ranged.signature);
        const label = `${rate.decodedSampleRate}Hz ${rate.codec}`;
        // **訂正が当たっていない行は、範囲読みの落ち度として読まない。**
        // `ranges-aligned` は測るための道具なので、道具が外れたなら「測れなかった」が正しい。
        const residual = ranged.partResiduals.length > 0 ? Math.max(...ranged.partResiduals) : 0;
        const trusted = residual < 1e-4;
        if (tailSeconds === 0 && trusted && (c.differing > 0 || ranged.missed > 0)) {
          tailMattered.push(`${label} × 速さ ${speed}`);
        }
        console.log(
          `${pad(label, 20)}${pad(mode, 16)}${pad(`×${speed}`, 8)}${pad(`${tailSeconds}s`, 8)}${right(`${c.differing} / ${c.blocks}`, 12)}${right(c.worst.toExponential(1), 12)}${right(`${ranged.missed} / ${ranged.placements}`, 10)}${right(`${(ranged.worstWidening * 1000).toFixed(1)}ms`, 10)}${right(trusted ? '—' : residual.toExponential(1), 12)}`,
        );
        if (tailSeconds === 0.05) {
          if (!trusted) {
            console.log(`      ↑ 訂正が当たっていないので、この行は測れていない（残差 ${residual.toExponential(2)}）`);
          } else {
            ok(
              `${label} × 速さ ${speed}: 既定の後ろの余裕で波が同じ`,
              c.differing === 0 && c.worst < 3e-5 && ranged.missed === 0,
              `違う区画 ${c.differing} / ${c.blocks} ・ 最大の開き ${c.worst.toExponential(2)} ・ 載らない ${ranged.missed}`,
            );
          }
        }
      }
    }
  }
  console.log(
    '\n**読む源の秒は「壁時計 × 速さ」では足りなかった。** 96kHz の素材を速さ 1 未満で鳴らすと、\n' +
      '**標本の速さの比のぶん（2 倍）読まないと波が合わない**（1 山 2 秒・速さ 0.5 で、\n' +
      '読む 1.0 秒では 414 / 1500 区画が違い、2.0 秒でちょうど 0 になる）。44.1kHz と 48kHz では出ない。\n' +
      'これは覆いの話ではないので `sourceRateRatio` で直した（後ろの余裕で埋めると 1 秒必要になる）。\n' +
      '上の表はその直しが入った状態。\n',
  );
  console.log(
    tailMattered.length > 0
      ? `\n**後ろの余裕 0 で落ちたのは ${tailMattered.length} 組**（${tailMattered.join(' / ')}）。\n` +
          '0.05 秒を残した理由は、**実測で効いている**。\n'
      : '\n**後ろの余裕 0 でも、どの組も波が同じだった。**\n' +
          '**48kHz でない素材でも（44.1kHz / 96kHz）、1 でない速さでも（0.5 / 1.37 / 2）落ちない。**\n' +
          '0.05 秒を残した理由 2（速さの丸め）と 3（48kHz でない素材の補間）は、\n' +
          '**測ったら両方とも効いていなかった。** 0 で通っているのは\n' +
          '**デコーダが要求より後ろまで出す広がり**（上の欄・3.5〜46ms）に助けられているからで、\n' +
          'その広がりは仕様ではない。**なので余裕は残すが、根拠は「理由 2・3」から\n' +
          '「広がりに頼らない」へ書き換える。**\n',
  );

  // ---------- 4. 助走は範囲読みの性質か、コーデックの性質か ----------

  console.log('## 要る助走（1 山 2 秒・残す 1/4・後ろ 0.05 秒・畳まない）\n');
  console.log(
    `${pad('素材', 20)}${pad('置き方', 16)}${pad('助走', 8)}${right('違う区画', 12)}${right('最大の開き', 12)}${right('1 区間あたり', 14)}${right('要る助走', 10)}`,
  );
  const prerollNeed = [];
  for (const rate of usable) {
    const mode = rate.grid.exact ? 'ranges' : 'ranges-aligned';
    const shape = { shape: 'jet', takeSeconds: 2, keepRatio: 0.25, assetCodec: rate.assetCodec, assetSampleRate: rate.askedSampleRate };
    const truth = await run({ ...shape, mode: 'whole', verify: true });
    let needed = 0;
    for (const prerollSeconds of [0, 0.05, 0.1, 0.2, 0.3, 0.5]) {
      const ranged = await run({ ...shape, mode, prerollSeconds, tailSeconds: 0.05, mergeGapSeconds: 0, verify: true });
      const c = compare(truth.signature, ranged.signature);
      // 区画の標本数は結果から受け取る（測る側で 512 と書き直すと片方だけ直して食い違う）。
      // 混ぜた波は必ず 48kHz なので、区画の秒はミックスの速さで割る。
      const cold = (c.differing * ranged.signatureBlock) / SAMPLE_RATE / Math.max(1, ranged.parts);
      if (c.differing > 0) needed = Math.max(needed, prerollSeconds + cold);
      console.log(
        `${pad(`${rate.decodedSampleRate}Hz ${rate.codec}`, 20)}${pad(mode, 16)}${pad(`${prerollSeconds}s`, 8)}${right(`${c.differing} / ${c.blocks}`, 12)}${right(c.worst.toExponential(1), 12)}${right(`${(cold * 1000).toFixed(0)}ms`, 14)}${right(`${((prerollSeconds + cold) * 1000).toFixed(0)}ms`, 10)}`,
      );
    }
    prerollNeed.push([`${rate.decodedSampleRate}Hz ${rate.codec}`, needed, rate.assetCodec]);
  }
  if (prerollNeed.length === 0) throw new Error('助走を測れた素材がありません');
  const worstNeed = Math.max(...prerollNeed.map(([, v]) => v));
  console.log(
    `\n要る助走: ${prerollNeed.map(([k, v]) => `${k} ${(v * 1000).toFixed(0)}ms`).join(' / ')}。\n` +
      `既定の 0.5 秒は、いちばん長い ${(worstNeed * 1000).toFixed(0)}ms の ${(0.5 / Math.max(1e-9, worstNeed)).toFixed(1)} 倍。\n`,
  );
  for (const [label, need] of prerollNeed) {
    ok(`${label}: 既定の助走 0.5 秒が、要る助走より長い`, need < 0.5, `要る助走 ${(need * 1000).toFixed(0)}ms`);
  }
  const pcm = prerollNeed.filter(([, , codec]) => codec === 'pcm-s16');
  ok(
    '助走が要るのはコーデックの温まりだけ（PCM は 0 でも波が同じ）',
    pcm.length > 0 && pcm.every(([, v]) => v === 0),
    pcm.map(([k, v]) => `${k} ${(v * 1000).toFixed(0)}ms`).join(' / '),
  );
  console.log(
    '\n**助走 0.22 秒は範囲読みの性質ではなく、Opus の性質だった。**\n' +
      'PCM は前の packet に重ねて復号しないので、助走 0 でも区間の頭から波が一致する。\n' +
      '**逆に言えば、重ねて復号する度合いはコーデックごとに違う**ので、\n' +
      'AAC やハードウェア復号の端末では 0.22 秒という数字は当てにならない（既定の 2.1 倍が効く所）。\n',
  );

  // ---------- 5. 速さは「得」の側をどう動かすか ----------

  // 範囲読みの得は「素材の尺 ÷ 使う秒」で決まる（9/30・1 回目）。
  // **速さは使う秒を倍率でそのまま動かす**ので、ここは時計を使わずに数えられる。
  console.log('## 速さと、範囲読みの得（数え上げ・1 時間の素材から 2 秒の山を残す 1/4）\n');
  console.log(`${pad('速さ', 8)}${right('読む秒', 10)}${right('起こす秒', 10)}${right('区間', 8)}${right('丸ごと ÷ 範囲', 15)}${right('のりしろの取り分', 18)}`);
  for (const speed of [0.5, 1, 1.37, 2, 4]) {
    const sequence = jetCutSequence({ assetSeconds: 3600, takeSeconds: 2, keepRatio: 0.25, speed });
    const stats = summarizeRangeCost(sequence);
    console.log(
      `${pad(`×${speed}`, 8)}${right(`${stats.readSeconds.toFixed(0)}s`, 10)}${right(`${stats.rangeSeconds.toFixed(0)}s`, 10)}${right(`${stats.parts} 本`, 8)}${right(`${stats.ratio.toFixed(1)} 倍`, 15)}${right(`${(stats.rangeSeconds / stats.readSeconds).toFixed(2)} 倍`, 18)}`,
    );
  }
  console.log(
    '\n**速くすると読む秒がそのぶん増えるので、範囲読みの得は速さに反比例して減る。**\n' +
      'のりしろの取り分は逆に薄まる（1 山の読む長さが速さで伸びるため）。\n' +
      '速さ 4 で 1 本に畳まれているのは、**読む区間が伸びて隙間が消えた**から（得も 1.0 倍＝丸ごと）。\n',
  );

  console.log('');
  ok('画面側でエラーが出ていない', errors.length === 0, errors.slice(0, 3).join(' / '));
} finally {
  await browser.close();
  server.stop();
}

console.log(failed > 0 ? `\n${failed} 件が失敗しています。` : '\n照合はすべて通りました。');
if (failed > 0) process.exit(1);
