/**
 * テロップの折り返し規則を、ブラウザ無しで確かめる。
 *
 *   npm run test:text
 *
 * 幅の測り方を差し替えられるようにしてあるので、ここでは「1 文字 = 1」として測る。
 * 実際の描画幅とは違うが、**どこで切るかの規則**はこれで十分試せる。
 * 壊れていれば終了コード 1 で落ちる。
 */

const { wrapJapanese, canBreakAt, breakScore } = await import('../src/engine/linebreak.ts');

/** 全角も半角も 1 文字 1 として数える測り方。 */
const mono = (s) => [...s].length;
const wrap = (text, width, opts = {}) => wrapJapanese(text, { measure: mono, maxWidth: width, ...opts });

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得たもの ${JSON.stringify(got)} / 欲しいもの ${JSON.stringify(want)}`);

// ---- 意味の切れ目で折る ----
eq('「から」のあとで切る', wrap('英語どこから喋れるの', 9), ['英語どこから', '喋れるの']);
eq('助詞「は」のあとで切る', wrap('自動翻訳は結構すごい', 7), ['自動翻訳は', '結構すごい']);
eq('読点のあとで切る', wrap('そうだね、たぶんそう', 6), ['そうだね、', 'たぶんそう']);
eq('平仮名の途中では切らない', wrap('自動翻訳できるぐらいには英語喋れるの', 9), [
  '自動翻訳',
  'できるぐらいには',
  '英語喋れるの',
]);

// ---- 禁則 ----
{
  const lines = wrap('そうだね、たぶんそうだと思う', 4);
  check('行頭に読点を送らない', lines.every((l) => !/^[、。！？]/.test(l)), lines.join(' / '));
}
{
  const lines = wrap('ちょっとまってっていうか', 5);
  check('行頭に小書きの文字を送らない', lines.every((l) => !/^[っゃゅょぁぃぅぇぉー]/.test(l)), lines.join(' / '));
}
check('閉じ括弧は行頭に来られない', canBreakAt('あ」い', 1) === false);
check('開き括弧は行末に置けない', canBreakAt('あ「い', 2) === false);

// ---- 空白 ----
eq('空白で切る', wrap('hello world foo', 11), ['hello world', 'foo']);
check('空白の切れ目が助詞より強い', breakScore('あ い', 1) > breakScore('あはい', 2));

// ---- 収まるときはそのまま ----
eq('幅に収まるなら切らない', wrap('みじかい', 10), ['みじかい']);
eq('空文字', wrap('', 10), ['']);

// ---- 進まなくならないこと ----
{
  const lines = wrap('ーーーーーーーーーー', 3);
  check('切れ目が無くても必ず進む', lines.length >= 2 && lines.join('') === 'ーーーーーーーーーー', lines.join(' / '));
}
{
  const lines = wrap('あ'.repeat(200), 7);
  check('長い文字列でも止まらない', lines.length === Math.ceil(200 / 7), `${lines.length} 行`);
}
{
  // 1 文字でも幅を超えるとき（文字が大きすぎる場合）。無限に回らないことだけ見る。
  const lines = wrapJapanese('あいう', { measure: () => 99, maxWidth: 10 });
  check('1 文字で溢れても止まらない', lines.length === 3, lines.join(' / '));
}

// ---- 戻りすぎない ----
{
  // 「は」が行のごく手前にあるとき、そこまで戻ると行が極端に短くなる。
  const lines = wrap('はあああああああああ', 9);
  check('切れ目が手前すぎるときは戻らない', lines[0].length >= 5, lines.join(' / '));
}

// ---- 字幕なし版の作り方 ----
{
  const { withoutCaptions, captionCount } = await import('../src/model/captions.ts');
  const textClip = (id, role) => ({ id, kind: 'text', text: role ? { role } : {} });
  const sequence = {
    clips: [
      textClip('caption', 'caption'),
      textClip('old'), // 古い保存ファイル。role が無いものは字幕とみなす
      textClip('title', 'design'),
      { id: 'movie', kind: 'video', text: null },
    ],
  };
  const left = withoutCaptions(sequence).clips.map((c) => c.id);
  eq('字幕なし版に残るもの', left, ['title', 'movie']);
  check('字幕の数を数えられる', captionCount(sequence) === 2, String(captionCount(sequence)));
  check('元のシーケンスは変えない', sequence.clips.length === 4);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  :: ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed} / ${results.length} 件が通りました。`);
process.exit(failed ? 1 : 0);
