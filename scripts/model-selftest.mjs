/**
 * 画面に依存しない所（折り返し・寸法・振り分け）を、ブラウザ無しで確かめる。
 *
 *   npm run test:model
 *
 * 折り返しは幅の測り方を差し替えられるので、ここでは「1 文字 = 1」として測る。
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

// ---- 3 分割の寸法 ----
{
  const { goldenBands, coverSource, bandCrop } = await import('../src/model/layout.ts');

  const b = goldenBands(1920);
  eq('1920 を黄金比で割る', [b.top.h, b.middle.h, b.bottom.h], [366, 960, 594]);
  check('3 つの合計が元の高さと一致する', b.top.h + b.middle.h + b.bottom.h === 1920);
  check('帯が隙間なく並ぶ', b.middle.y === b.top.h && b.bottom.y === b.top.h + b.middle.h);
  for (const h of [1080, 1350, 1920, 1000]) {
    const g = goldenBands(h);
    check(`高さ ${h} でも合計が合う`, g.top.h + g.middle.h + g.bottom.h === h);
    check(`高さ ${h} でも偶数`, g.top.h % 2 === 0 && g.middle.h % 2 === 0 && g.bottom.h % 2 === 0);
  }

  const media = { width: 1920, height: 1080 };
  const mid = coverSource(media, 1080 / 960);
  check('比のとおりに切り出す', Math.abs((mid.sw * 1920) / (mid.sh * 1080) - 1080 / 960) < 1e-9);
  check('高さいっぱいを使う', Math.abs(mid.sh - 1) < 1e-9, String(mid.sh));
  check('左右の余りが同じ', Math.abs(mid.sx - (1 - mid.sw - mid.sx)) < 1e-9);

  const zoomed = coverSource(media, 1080 / 594, 4);
  check('寄せると枠が小さくなる', zoomed.sw < coverSource(media, 1080 / 594).sw / 3.9);
  check('寄せても中心は同じ', Math.abs(zoomed.sx + zoomed.sw / 2 - 0.5) < 1e-9);

  const crop = bandCrop(mid, b.middle);
  check('帯いっぱいに置く', crop.enabled && crop.dx === 0 && crop.dw === 1);
  check('置き場所は帯のとおり', Math.abs(crop.dy - 366 / 1920) < 1e-9 && Math.abs(crop.dh - 960 / 1920) < 1e-9);
}

// ---- 3 分割の組み上がり ----
{
  const { buildThreeBand } = await import('../src/model/threeBand.ts');
  const { createSequence, baseClip } = await import('../src/model/factory.ts');

  const sequence = createSequence(); // 1080x1920 / V1 V2 T1 A1 A2
  const track = sequence.tracks.find((t) => t.kind === 'video');
  const source = {
    ...baseClip('video', track.id),
    mediaId: 'media1',
    start: 2,
    duration: 7,
    sourceIn: 1.5,
    volume: 0.8,
  };
  const before = { ...sequence, clips: [source] };
  const after = buildThreeBand(before, source, { width: 1920, height: 1080 });

  check('元のクリップは残らない', !after.clips.some((c) => c.id === source.id));
  const videos = after.clips.filter((c) => c.kind === 'video');
  check('映像は 3 本になる', videos.length === 3, String(videos.length));
  check('映像トラックが 3 本ある', after.tracks.filter((t) => t.kind === 'video').length === 3);
  check('3 本とも別のトラック', new Set(videos.map((c) => c.trackId)).size === 3);
  check('時間は元のまま', videos.every((c) => c.start === 2 && c.duration === 7 && c.sourceIn === 1.5));
  check('同じ素材を見ている', videos.every((c) => c.mediaId === 'media1'));
  check('音が鳴るのは 1 本だけ', videos.filter((c) => !c.muted).length === 1, String(videos.filter((c) => !c.muted).length));

  // 帯が隙間なく画面を埋めているか（置き場所の高さの合計が 1）
  const heights = videos.map((c) => c.crop.dh).sort((a, b) => a - b);
  check('帯の合計が画面いっぱい', Math.abs(heights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  check('すべて切り抜きが入っている', videos.every((c) => c.crop.enabled && c.crop.dw === 1));
  // 上の帯（いちばん小さい）は、ぼかして暗くしてある
  const top = videos.find((c) => Math.abs(c.crop.dy) < 1e-9);
  check('上の帯はぼかして暗くする', top.effects.length === 2 && top.effects.some((e) => e.type === 'blur'));
  const bottom = videos.reduce((lowest, c) => (c.crop.dy > lowest.crop.dy ? c : lowest));
  check('下の帯は寄せてある', bottom.crop.sw < 0.4, String(bottom.crop.sw));

  // 絵がつぶれないこと＝切り出しの比と置き場所の比が一致する
  for (const c of videos) {
    const srcAspect = (c.crop.sw * 1920) / (c.crop.sh * 1080);
    const dstAspect = (c.crop.dw * 1080) / (c.crop.dh * 1920);
    check(`比が合っている（dy=${c.crop.dy.toFixed(3)}）`, Math.abs(srcAspect - dstAspect) < 1e-6, `${srcAspect} / ${dstAspect}`);
  }

  // 見出しつき
  const titled = buildThreeBand(before, source, { width: 1920, height: 1080 }, {
    titleStyle: { content: '見出し', role: 'design' },
    titleText: 'ただ喋れば\nいいってもんじゃない',
  });
  const title = titled.clips.find((c) => c.kind === 'text');
  check('見出しが作られる', !!title);
  check('見出しの文言が入る', title.text.content === 'ただ喋れば\nいいってもんじゃない');
  check('見出しは上の帯の中に置かれる', Math.abs(title.y - (183 / 1920 - 0.5)) < 0.01, String(title.y));
  check('見出しは字幕なし版でも残る', title.text.role === 'design');
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  :: ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed} / ${results.length} 件が通りました。`);
process.exit(failed ? 1 : 0);
