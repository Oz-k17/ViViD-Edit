/**
 * ラボの解析（判断の部分）を src/analysis/ へ写す。
 *
 *   npm run analysis:sync          写し直す
 *   npm run analysis:sync -- --check   ずれていないかだけ見る（ずれていれば終了コード 1）
 *
 * 対象は、本体で手を入れていないもの。`decode.ts` と `cover-export.ts` は
 * 本体の都合で変えてあるので対象外（`src/analysis/README.md` を参照）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');

/** [原本, 写し先, 写すときに直す所] */
const FILES = [
  ['lab/scene-cut/src/frames.ts', 'src/analysis/frames.ts'],
  ['lab/scene-cut/src/scene.ts', 'src/analysis/scene.ts'],
  ['lab/thumbnail/src/thumb.ts', 'src/analysis/thumb.ts'],
  [
    'lab/thumbnail/src/pick.ts',
    'src/analysis/pick.ts',
    (text) => text.replaceAll("'../../scene-cut/src/frames.ts'", "'./frames.ts'"),
  ],
  ['lab/reframe/src/columns.ts', 'src/analysis/columns.ts'],
  ['lab/reframe/src/reframe.ts', 'src/analysis/reframe.ts'],
  ['lab/auto-cut/src/loudness.ts', 'src/analysis/audio/loudness.ts'],
  ['lab/auto-cut/src/lufs.ts', 'src/analysis/audio/lufs.ts'],
  ['lab/auto-cut/src/limiter.ts', 'src/analysis/audio/limiter.ts'],
];

let drifted = 0;
for (const [from, to, fix] of FILES) {
  const original = fs.readFileSync(path.join(root, from), 'utf8');
  const want = fix ? fix(original) : original;
  const target = path.join(root, to);
  const have = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (have === want) continue;
  drifted += 1;
  if (check) {
    console.log(`ずれている: ${to}（原本 ${from}）`);
  } else {
    fs.writeFileSync(target, want);
    console.log(`写しました: ${from} → ${to}`);
  }
}

if (check) {
  if (drifted) {
    console.log(`\n${drifted} 件ずれています。ラボを直したなら \`npm run analysis:sync\` で写し直してください。`);
    process.exit(1);
  }
  console.log(`写しは原本どおりです（${FILES.length} 件）。`);
} else if (drifted === 0) {
  console.log('すでに原本どおりです。');
}
