/**
 * 文字起こしを**ネット無し**で回せるようにする。
 *
 *   npm i --no-save @huggingface/transformers onnxruntime-web
 *   npm run whisper:pack
 *   npm uninstall @huggingface/transformers onnxruntime-web
 *
 * transformers.js（約 570KB）と onnxruntime の wasm（14〜28MB）を
 * docs/whisper/ へ写す。どちらも普段は取りに行く形にしてあるので、
 * 依存には入れていない（入れると onnxruntime-node まで付いてきて 290MB 増える）。
 *
 * モデル本体は別。Hugging Face から落としたものを
 * docs/whisper/models/<作者>/<名前>/ に置くと、そこだけを見に行くようになる。
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'docs', 'whisper');
const modules = path.join(root, 'node_modules');

if (!existsSync(path.join(target, 'worker.js'))) {
  console.error('docs/whisper/worker.js がありません。先に `npm run bundle` を実行してください。');
  process.exit(1);
}

const missing = ['@huggingface/transformers', 'onnxruntime-web'].filter(
  (name) => !existsSync(path.join(modules, ...name.split('/'))),
);
if (missing.length) {
  console.error(`${missing.join(' と ')} がありません。ネット無しで回したいときだけ要ります。`);
  console.error(`  npm i --no-save ${missing.join(' ')}`);
  console.error('を実行してから、もう一度このコマンドを動かしてください。');
  process.exit(1);
}

let bytes = 0;
const take = async (from, to) => {
  await cp(from, to);
  bytes += (await stat(from)).size;
};

// transformers.js 本体
await take(
  path.join(modules, '@huggingface', 'transformers', 'dist', 'transformers.min.js'),
  path.join(target, 'transformers.min.js'),
);

// onnxruntime。読み込みに要るのは wasm と、その受け渡しをする .mjs だけ。
const ortFrom = path.join(modules, 'onnxruntime-web', 'dist');
const ortTo = path.join(target, 'ort');
await mkdir(ortTo, { recursive: true });
for (const name of await readdir(ortFrom)) {
  if (!/\.(wasm|mjs)$/.test(name)) continue;
  await take(path.join(ortFrom, name), path.join(ortTo, name));
}

console.log(`写しました: ${path.relative(root, target)} (${(bytes / 1024 / 1024).toFixed(0)} MB)`);
console.log('モデルは docs/whisper/models/<作者>/<名前>/ に置いてください。');
console.log('画面の「手元に置いたモデルだけを使う」を入れると、そこだけを見に行きます。');
