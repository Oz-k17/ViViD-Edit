/**
 * 処理の重さを測る（開発用。配布物には入らない）。
 *
 *   node perf/bench.mjs            … 全部の項目を 3 回ずつ測って中央値を出す
 *   node perf/bench.mjs --json     … 結果を JSON でも出す（PERF.md へ写すとき用）
 *
 * 本番と同じ組み立て（perf/.dist）を自分で作って配り、Chromium で「重めのプロジェクト」を開いて測る。
 *   - 映像クリップ 300 個（同じ 6 秒の素材を 1 秒ずつ）＋ テロップ 100 個
 * 測るのは、使う人が「待たされる」と感じる所だけ。
 *
 * Chromium の場所は環境変数 CHROMIUM で変えられる（既定は Claude Code のクラウド環境の場所）。
 * 端末の速さで数字は変わるので、**同じ環境で前後を比べる**ためのもの。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = createRequire('/')('/opt/node22/lib/node_modules/playwright');
}
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 5299;
const ROUNDS = 3;
const asJson = process.argv.includes('--json');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

// 配布物と同じ「本番の組み立て」で測る。開発サーバーの React は検査つきで数倍遅く、数字が当てにならない。
// 速さを測るための入口（window.__vivid）だけを足した組み立てを、perf/.dist に作る。
const outDir = path.join('perf', '.dist');
await new Promise((resolve, reject) => {
  const build = spawn('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_BENCH: '1' },
  });
  build.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error('組み立てに失敗しました'))));
});
const vite = spawn('npx', ['vite', 'preview', '--outDir', outDir, '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
const stop = () => {
  try {
    vite.kill('SIGTERM');
  } catch {
    /* もう止まっている */
  }
};
process.on('exit', stop);

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {
      /* まだ */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('vite が立ち上がりません');
}

async function makeVideo(page) {
  return page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 640;
    cv.height = 360;
    const g = cv.getContext('2d');
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dst = ac.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();
    const rec = new MediaRecorder(new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dst.stream.getAudioTracks()]), {
      mimeType: 'video/webm;codecs=vp8,opus',
    });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(300);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = `hsl(${(t * 50) % 360},70%,50%)`;
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = '#fff';
        g.font = '64px sans-serif';
        g.fillText(t.toFixed(1), 220, 200);
        if (t < 6) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    rec.stop();
    await done;
    osc.stop();
    const { withWebmDuration } = window.__vivid;
    return Array.from(new Uint8Array(await (await withWebmDuration(new Blob(chunks, { type: 'video/webm' }), 6)).arrayBuffer()));
  });
}

/** 2 フレーム待つ（画面に反映されるまで）。 */
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))));

async function round(browser, videoBytes) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addInitScript(() => {
    try {
      if (!localStorage.getItem('vivid.settings')) localStorage.setItem('vivid.settings', JSON.stringify({ uiMode: 'full', layout: 'desktop' }));
    } catch {
      /* 無い環境 */
    }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/#/`);
  await page.waitForSelector('.tl-toolbar');
  await page.setInputFiles('input[type=file]', [{ name: 'bench.webm', mimeType: 'video/webm', buffer: Buffer.from(videoBytes) }]);
  await page.waitForFunction(() => window.__vivid?.mediaRegistry.all().some((a) => a.name === 'bench.webm'), null, { timeout: 20000 });

  // 重いプロジェクトを作って、保存した状態から開き直す（起動の重さも測るため）。
  await page.evaluate(async () => {
    const { createSequence, baseClip, textClip } = window.__vivid.factory;
    const asset = window.__vivid.mediaRegistry.all().find((a) => a.name === 'bench.webm');
    const seq = createSequence();
    const v1 = seq.tracks.find((t) => t.kind === 'video');
    const t1 = seq.tracks.find((t) => t.kind === 'text');
    const clips = [];
    for (let i = 0; i < 300; i++) {
      clips.push({ ...baseClip('video', v1.id), id: `bv${i}`, mediaId: asset.id, start: i, duration: 1, sourceIn: (i % 5) + 0.2 });
    }
    for (let i = 0; i < 100; i++) {
      clips.push({ ...textClip(t1.id, i * 3, 2.5, { content: `テロップ ${i} ちょっと長めの文を入れて折り返しも試す` }), id: `bt${i}` });
    }
    seq.clips = clips;
    localStorage.setItem('vivid.project', JSON.stringify({ name: 'bench', sequence: seq }));
  });

  const t0 = Date.now();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.tl-clip').length > 20, null, { timeout: 30000 });
  await settle(page);
  const openMs = Date.now() - t0;

  // 長く固まった時間（50ms 超の処理）を数える。
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: false });
  });
  const longSince = async (fn) => {
    await page.evaluate(() => (window.__long.length = 0));
    await fn();
    return page.evaluate(() => ({ count: window.__long.length, total: Math.round(window.__long.reduce((a, b) => a + b, 0)) }));
  };

  // 初回起動の準備（効果音づくり・サムネイル）が終わって、静かになるまで待つ。
  // 測っている最中に裏の仕事が重なると、同じ操作でも数倍に振れる。
  await page.evaluate(async () => {
    const start = performance.now();
    let lastLong = performance.now();
    const seen = window.__long.length;
    while (performance.now() - start < 15000) {
      if (window.__long.length !== seen) lastLong = performance.now();
      if (performance.now() - lastLong > 1000) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  // 分割（再生ヘッドの位置で）× 5 回。何も選んでいない状態で行う（選んでいると、そのクリップしか切らない）
  const splitTimes = [];
  for (let i = 0; i < 5; i++) {
    await page.evaluate((x) => window.__vivid.player.seek(x), 10.5 + i * 7);
    await settle(page);
    const ms = await page.evaluate(async () => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '分割');
      const t = performance.now();
      button.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t;
    });
    splitTimes.push(ms);
  }

  const afterSplit = await page.evaluate(() => document.querySelectorAll('.tl-clip').length);

  // クリップを選ぶ（5 か所で測って中央値）
  const selectMs = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const el = document.querySelectorAll('.tl-clip')[i * 2 + 1];
      const box = el.getBoundingClientRect();
      const t = performance.now();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 10, clientY: box.top + 10, button: 0, pointerId: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      times.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 150));
    }
    times.sort((a, b) => a - b);
    return times[2];
  });

  // 拡大縮小 × 6
  const zoom = await longSince(async () => {
    for (let i = 0; i < 3; i++) {
      await page.locator('.zoom button').nth(1).click();
      await settle(page);
    }
    for (let i = 0; i < 3; i++) {
      await page.locator('.zoom button').nth(0).click();
      await settle(page);
    }
  });

  // シーク × 20（離れた所へ飛ぶ）
  const seekMs = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      window.__vivid.player.seek((i * 37) % 290);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  });

  // 再生 3 秒（コマの間隔）
  const play = await page.evaluate(async () => {
    window.__vivid.player.seek(20);
    await new Promise((r) => setTimeout(r, 300));
    const gaps = [];
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    window.__vivid.player.play();
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 3000));
    running = false;
    window.__vivid.player.pause();
    gaps.sort((a, b) => a - b);
    return { p50: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)], over50: gaps.filter((g) => g > 50).length };
  });

  const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : null));
  // 測った前提がそろっているか（クリップが全部読めたか）。ここが違えば、ほかの数字は比べられない。
  const clipCount = await page.evaluate(() => document.querySelectorAll('.tl-clip').length);
  await ctx.close();
  return { openMs, selectMs, splitMs: median(splitTimes), zoomLong: zoom.total, seekMs, playP50: play.p50, playP95: play.p95, playOver50: play.over50, heapMB: heap, clipCount: afterSplit, errors: errors.length };
}

try {
  await waitServer();
  const browser = await pw.chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
  const helper = await browser.newPage();
  await helper.goto(`http://localhost:${PORT}/#/`);
  await helper.waitForSelector('.tl-toolbar');
  await helper.waitForFunction(() => !!window.__vivid);
  const video = await makeVideo(helper);
  await helper.close();
  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) rounds.push(await round(browser, video));
  await browser.close();
  const keys = Object.keys(rounds[0]);
  const result = Object.fromEntries(keys.map((k) => [k, rounds[0][k] === null ? null : Math.round(median(rounds.map((r) => r[k])) * 10) / 10]));
  const labels = {
    openMs: '開く（300+100 クリップ）ms',
    selectMs: 'クリップを選ぶ ms',
    splitMs: '分割 ms（中央値）',
    zoomLong: '拡大縮小 6 回で固まった合計 ms',
    seekMs: 'シーク 1 回 ms（中央値）',
    playP50: '再生中のコマ間隔 p50 ms',
    playP95: '再生中のコマ間隔 p95 ms',
    playOver50: '再生 3 秒で 50ms 超のコマ',
    heapMB: 'JS ヒープ MB',
    clipCount: '分割後のクリップ数（前提の確認。405 になるはず）',
    errors: 'エラー数',
  };
  for (const k of keys) console.log(`${labels[k] ?? k}: ${result[k]}`);
  if (asJson) console.log(JSON.stringify(result));
} finally {
  stop();
}
