/**
 * キーフレーム（時間で変化する値）の検算をコマンドラインから走らせる。
 *
 *   npm run lab:test   （ほかの試作のぶんと続けて走る）
 *
 * 値と時刻しか見ないので、ブラウザも素材も要らない（数ミリ秒で終わる）。
 * 効きのほうは `npm run lab:keyframe:probe`（持ち方の当たり外れ）と
 * `npm run lab:keyframe`（読み出しの費用）が見る。
 */

const { runSelfTest } = await import('./src/selftest.ts');

const results = runSelfTest();
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  :: ${r.detail}` : ''}`);
}

console.log(`\n${results.length - failed} / ${results.length} 件が通りました。`);
if (failed > 0) {
  console.error(`${failed} 件が失敗しています。`);
  process.exit(1);
}
