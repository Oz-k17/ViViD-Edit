/**
 * 持ち出し／取り込みの検算をコマンドラインから走らせる。
 *
 *   npm run lab:test   （ほかの試作のぶんと続けて走る）
 *
 * 合成したバイト列しか使わないので、ブラウザも素材も要らない。
 * 大きさ・時間・メモリのほうは `npm run lab:pack` が測る。
 */

const { runSelfTest } = await import('./src/selftest.ts');

const results = await runSelfTest();
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
