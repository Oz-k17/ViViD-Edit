/**
 * **本物のサムネイルは何バイトか。**
 *
 *   npm run lab:pack:thumbsize
 *
 * 2026-09-28（1 回目）の積み残しに「`thumbnail` の data URL を入れると 1 素材 10〜20KB」と
 * 書いたが、**それは測った数字ではない。** 置き所を決めるのに効くのはここの桁なので、
 * 先に測る。
 *
 * ## なぜブラウザを立てるのか
 *
 * 本体（`src/engine/media.ts` の `snapshot()`）が焼いているのは
 * `canvas.toDataURL('image/jpeg', 0.7)` で、JPEG を焼く道具は Node に無い。
 * **画面が実際に使う口でしか、実際の長さは出ない**（`lab:thumb:format` と同じ理由）。
 * playwright が無い環境では、その旨を出して成功扱いで終わる。
 *
 * ## 何を焼くか
 *
 * 素材は `lab/fixtures/` の合成映像を**実寸（1920×1080）で描いて**から、
 * `snapshot()` と同じ規則（長辺 240・品質 0.7）で縮めて焼く。
 * 引き伸ばした絵を縮めると本物より滑らかになって JPEG に有利なので
 * （`thumbnail/README.md` が 9/24 に踏んだ穴）、**実寸で描く道（`renderSpec` の `scale`）を通す。**
 * それでも合成は合成なので、**ここで出る数字は本物の映像より小さめに出るはず**——
 * 置き所を決めるのには足りる（小さめに出てなお見出しに載らない、なら答えは動かない）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, loadPlaywright, serve } from '../browser.mjs';

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないのでサムネイルの大きさの測定は飛ばします。');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * 画面を持たない試作なので、vite の root は `lab/thumbnail` を借りる
 * （あちらは `server.fs.allow` がリポジトリ全体に開いているので、
 *  `/@fs/…` で `lab/fixtures/` を読める）。借りるのは**サーバだけ**で、
 * 表紙の判定は 1 行も通っていない。
 */
const SERVE_ROOT = path.join(ROOT, 'lab', 'thumbnail');
const fsUrl = (rel) => `/@fs${path.join(ROOT, rel)}`;

/** 測る素材。**壊れ方ではなく「縮めたときの中身の多さ」で選ぶ**（それが JPEG の長さを決める）。 */
const NAMES = (process.env.LAB_FIXTURES ?? 'whip-still,whip-captions,whip-grain,cuts-plain,dark-noise,handheld').split(
  ',',
);
const ASPECTS = (process.env.LAB_ASPECTS ?? 'landscape,native').split(',');
/** 本体の `snapshot()` がそのまま持っている 2 つ。ここを変えると本体と話が合わなくなる。 */
const LONG_SIDE = 240;
const QUALITY = 0.7;

const pad = (s, n) => String(s).padEnd(n, ' ');
const rpad = (s, n) => String(s).padStart(n, ' ');

const server = await serve(SERVE_ROOT);
const browser = await launch(playwright);
const rows = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 400, height: 300 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });

  for (const aspect of ASPECTS) {
    for (const name of NAMES) {
      process.stdout.write(`${name}（${aspect}）を焼いています…\n`);
      const got = await page.evaluate(
        async ([framesUrl, thumbsUrl, fixture, view, longSide, quality]) => {
          const { renderSpec } = await import(framesUrl);
          const { thumbFixture } = await import(thumbsUrl);
          // 実寸で描く。15 倍が 1920×1080（`renderSpec` の `scale` の注）。
          // コマは 3 枚あれば散らばりが見える。1 枚ずつ描き直すほうが速いが、
          // renderSpec は素材まるごとを一度に返す形なので、fps を落として枚数を絞る。
          const spec = renderSpec(thumbFixture(fixture), { aspect: view, scale: 15, fps: 0.2 });
          const src = document.createElement('canvas');
          src.width = spec.width;
          src.height = spec.height;
          const sctx = src.getContext('2d');

          const out = [];
          for (const frame of spec.frames) {
            sctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
            // ここから下は `src/engine/media.ts` の `snapshot()` と同じ規則。
            const scale = Math.min(1, longSide / Math.max(spec.width, spec.height, 1));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(spec.width * scale));
            canvas.height = Math.max(1, Math.round(spec.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
            const url = canvas.toDataURL('image/jpeg', quality);
            const comma = url.indexOf(',');
            const b64 = url.length - comma - 1;
            // base64 の「=」の詰め物を差し引いて生の長さへ戻す。
            const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0;
            out.push({ urlLength: url.length, rawBytes: (b64 / 4) * 3 - padding, w: canvas.width, h: canvas.height });
          }
          return { width: spec.width, height: spec.height, shots: out };
        },
        [fsUrl('lab/fixtures/make-frames.mjs'), fsUrl('lab/fixtures/thumbs.mjs'), name, aspect, LONG_SIDE, QUALITY],
      );
      rows.push({ name, aspect, ...got });
    }
  }
  if (errors.length) console.error(`\n画面の例外: ${errors.slice(0, 3).join(' / ')}`);
} finally {
  await browser.close();
  server.stop();
}

console.log(`\n## 本体と同じ規則で焼いたサムネイル（長辺 ${LONG_SIDE} / JPEG 品質 ${QUALITY}）\n`);
console.log(pad('素材', 16) + pad('向き', 11) + pad('焼いた大きさ', 14) + rpad('生 B', 8) + rpad('data URL B', 12) + rpad('倍', 7));

const all = [];
for (const row of rows) {
  const raw = row.shots.reduce((s, x) => s + x.rawBytes, 0) / row.shots.length;
  const url = row.shots.reduce((s, x) => s + x.urlLength, 0) / row.shots.length;
  all.push({ raw, url });
  const size = `${row.shots[0].w}×${row.shots[0].h}`;
  console.log(
    pad(row.name, 16) + pad(row.aspect, 11) + pad(size, 14) + rpad(raw.toFixed(0), 8) + rpad(url.toFixed(0), 12) + rpad((url / raw).toFixed(3), 7),
  );
}

if (all.length) {
  const urls = all.map((a) => a.url).sort((a, b) => a - b);
  const mid = urls[urls.length >> 1];
  console.log(
    `\n中央値 ${(mid / 1024).toFixed(1)}KB / 幅 ${(urls[0] / 1024).toFixed(1)}〜${(urls[urls.length - 1] / 1024).toFixed(1)}KB` +
      `（${all.length} 通り）`,
  );
  console.log(
    '\n読み方: 「倍」は data URL ÷ 生バイト。**1.34 前後で頭打ち**になるのが正しい\n' +
      '（base64 の 4/3 ＋ `data:image/jpeg;base64,` の 23 文字）。\n' +
      '合成の素材は本物の映像より滑らかなので、ここの数字は**本物より小さめ**に出る。',
  );
}
