/**
 * Web 版のビルド結果を Swift Playgrounds パッケージへ同梱する。
 *
 * iPad の Swift Playgrounds では npm が使えないので、ビルド済みの成果物を
 * リポジトリに含めておく必要がある。通常ならビルド生成物はコミットしないが、
 * ここでは「そのまま開いて実機で動く」ことを優先している。
 */
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const target = path.join(root, 'ios', 'TateyokoStudio.swiftpm', 'Resources', 'web');

if (!existsSync(dist)) {
  console.error('dist/ がありません。先に `npm run build` を実行してください。');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(dist, target, { recursive: true });

async function totalBytes(dir) {
  let sum = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    sum += entry.isDirectory() ? await totalBytes(full) : (await stat(full)).size;
  }
  return sum;
}

const bytes = await totalBytes(target);
console.log(`同梱しました: ${path.relative(root, target)} (${(bytes / 1024).toFixed(0)} KB)`);
