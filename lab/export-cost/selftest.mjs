/**
 * 書き出しの仕事量・段ごとの取り分・重ねる待ち行列の検算をコマンドラインから走らせる。
 *
 *   npm run lab:test   （ほかの試作のぶんと続けて走る）
 *
 * 並べ方も集計も待ち行列も DOM に触らないので、ブラウザは要らない。
 * 実測のほうは `npm run lab:export`（playwright が無ければ飛ばす）。
 */

const { runSelfTest, runPipelineSelfTest } = await import('./src/selftest.ts');
const { runAudioSelfTest } = await import('./src/audio-selftest.ts');
const { runRangeSelfTest } = await import('./src/range-selftest.ts');

// 待ち行列のほうだけ非同期（約束を手で解いて確かめるため）。並べて 1 つの表に出す。
const results = [...runSelfTest(), ...(await runPipelineSelfTest()), ...runAudioSelfTest(), ...runRangeSelfTest()];
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
