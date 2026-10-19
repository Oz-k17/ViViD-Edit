/**
 * Web 版のビルド結果を、配布用の 2 か所へ配る。
 *
 *  - docs/                      … そのまま開ける Web 版。GitHub Pages の公開元にもできる
 *  - ios/ViVidEdit.swiftpm/...  … iOS 版に同梱する分
 *
 * ラボ（lab/auto-cut）のビルド結果があれば docs/lab/ にも置く。
 * docs/ は毎回まるごと作り直すので、ここで一緒に配らないと消えてしまう。
 * iOS 版には入れない（同梱するのは製品のほうだけ）。
 *
 * 通常ならビルド生成物はコミットしないが、ここでは
 * 「リポジトリを落として index.html を開けば動く」「iPad には npm が無い」
 * という 2 点を優先して、あえてリポジトリに含めている。
 */
import { cp, mkdir, readFile, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildManualHtml } from './manual-html.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

const targets = [
  path.join(root, 'docs'),
  path.join(root, 'ios', 'ViVidEdit.swiftpm', 'Resources', 'web'),
];

if (!existsSync(dist)) {
  console.error('dist/ がありません。先に `npm run build` を実行してください。');
  process.exit(1);
}

async function totalBytes(dir) {
  let sum = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    sum += entry.isDirectory() ? await totalBytes(full) : (await stat(full)).size;
  }
  return sum;
}

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(dist, target, { recursive: true });
  const bytes = await totalBytes(target);
  console.log(`同梱しました: ${path.relative(root, target)} (${(bytes / 1024).toFixed(0)} KB)`);
}

const labDist = path.join(root, 'lab', 'auto-cut', 'dist');
if (existsSync(labDist)) {
  const labTarget = path.join(root, 'docs', 'lab');
  await cp(labDist, labTarget, { recursive: true });
  console.log(`同梱しました: ${path.relative(root, labTarget)} (${((await totalBytes(labTarget)) / 1024).toFixed(0)} KB)`);
} else {
  console.log('ラボのビルドが無いので docs/lab は作りませんでした（`npm run lab:build` で作れます）。');
}

// 文字起こし（whisper）の駆け出し部分だけ。
// transformers.js とモデルは配らない。押されたときに取りに行く
//（手元に置きたい場合は `npm run whisper:pack`）。
// iOS 版（file://）では Worker も fetch も通らないので、あちらには入れない。
const whisperDist = path.join(root, 'whisper-dist');
if (existsSync(whisperDist)) {
  const whisperTarget = path.join(root, 'docs', 'whisper');
  await mkdir(whisperTarget, { recursive: true });
  await cp(whisperDist, whisperTarget, { recursive: true });
  console.log(`同梱しました: ${path.relative(root, whisperTarget)} (${((await totalBytes(whisperTarget)) / 1024).toFixed(0)} KB)`);
} else {
  console.log('文字起こしのビルドが無いので docs/whisper は作りませんでした（`npm run whisper:build` で作れます）。');
}

// GitHub Pages は既定で Jekyll が走り、_ で始まるファイルなどを無視してしまう。
await writeFile(path.join(root, 'docs', '.nojekyll'), '');

// README の「いまの版」を、組み立ての印に合わせる。
// ダウンロードした人が、アプリの「設定 → このアプリについて」と見比べて、最新かどうかを確かめられるように。
try {
  const { stamp } = JSON.parse(await readFile(path.join(dist, 'version.json'), 'utf8'));
  const readmePath = path.join(root, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  const marked = /<!-- version -->[\s\S]*?<!-- \/version -->/;
  if (stamp && marked.test(readme)) {
    const line = `<!-- version -->いまの版: **${stamp}** に組み立てたもの<!-- /version -->`;
    await writeFile(readmePath, readme.replace(marked, line));
    console.log(`README の版を更新しました: ${stamp}`);
  }
} catch (error) {
  console.log(`README の版は更新しませんでした（${error instanceof Error ? error.message : error}）`);
}

// 操作説明書（README）を HTML にして docs/ に置く。ZIP（パソコン用・iPad 用）にはここから入れる。
const manualPath = path.join(root, 'docs', '使い方.html');
await writeFile(manualPath, buildManualHtml(await readFile(path.join(root, 'README.md'), 'utf8')));
console.log(`説明書を作りました: ${path.relative(root, manualPath)}`);
