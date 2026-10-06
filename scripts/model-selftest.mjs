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

// ---- 声の指紋で話者を見分けられるか ----
{
  const { voicePrint, similarity, pickSpeaker } = await import('../src/engine/voiceprint.ts');

  const SR = 24000;
  /** 種を固定した乱数。毎回同じ音になるので、数字がそのまま比べられる。 */
  const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  /**
   * 声のつもりの音を作る。基本の高さの倍音を、フォルマント（声道の共鳴）の
   * 形で重みづけして足す。息継ぎを入れ、高さもゆっくり揺らす。
   */
  function synth({ f0, formants, seconds, seed, gain = 0.5 }) {
    const rand = rng(seed);
    const n = Math.floor(SR * seconds);
    const out = new Float32Array(n);
    const harmonics = Math.min(40, Math.floor(SR / 2 / f0));
    const phase = new Float64Array(harmonics + 1);
    let jitter = 0;
    for (let i = 0; i < n; i += 1) {
      const t = i / SR;
      // 0.28 秒ごとに音節、そのうち 0.06 秒は息継ぎ
      const inSyllable = (t % 0.28) < 0.22;
      const env = inSyllable ? 0.35 + 0.65 * Math.sin((Math.PI * (t % 0.28)) / 0.22) : 0;
      if (i % 200 === 0) jitter = (rand() - 0.5) * 0.06;
      const f = f0 * (1 + jitter);
      let sample = 0;
      for (let h = 1; h <= harmonics; h += 1) {
        const hz = f * h;
        let amp = 1 / h; // 声帯の音は高い倍音ほど弱い
        let shape = 0.02;
        for (const F of formants) shape += 1 / (1 + Math.pow((hz - F) / 110, 2));
        amp *= shape;
        phase[h] += (2 * Math.PI * hz) / SR;
        sample += amp * Math.sin(phase[h]);
      }
      out[i] = gain * env * sample * 0.08 + (rand() - 0.5) * 0.002;
    }
    return out;
  }

  const A = { f0: 208, formants: [720, 1280, 2800] }; // 高めの声
  const B = { f0: 116, formants: [500, 1500, 2400] }; // 低めの声

  const printOf = (spec, seed, gain) => voicePrint(synth({ ...spec, seconds: 1.6, seed, gain }), SR);

  const anchorA = printOf(A, 1);
  const anchorB = printOf(B, 2);
  check('手本の指紋が取れる', !!anchorA && !!anchorB);
  check('高さを当てられる（高い声）', Math.abs(anchorA.pitch - A.f0) / A.f0 < 0.08, `${anchorA.pitch.toFixed(1)}Hz`);
  check('高さを当てられる（低い声）', Math.abs(anchorB.pitch - B.f0) / B.f0 < 0.08, `${anchorB.pitch.toFixed(1)}Hz`);

  const anchors = [{ id: 'A', print: anchorA }, { id: 'B', print: anchorB }];
  let right = 0;
  let total = 0;
  const margins = [];
  for (let i = 0; i < 6; i += 1) {
    for (const [name, spec] of [['A', A], ['B', B]]) {
      const print = printOf(spec, 100 + i * 7 + (name === 'A' ? 0 : 3));
      const decision = pickSpeaker(print, anchors);
      total += 1;
      if (decision.id === name) right += 1;
      margins.push(decision.margin);
    }
  }
  check('12 区間すべてを正しく振り分ける', right === total, `${right} / ${total}`);
  const worst = Math.min(...margins);
  check('いちばん迷った所でも差がある', worst > 0.02, `いちばん小さい差 ${worst.toFixed(3)}`);

  // 同じ人どうしは、違う人どうしより必ず近いこと
  const a2 = printOf(A, 31);
  const b2 = printOf(B, 32);
  check('同じ人どうしのほうが近い（高い声）', similarity(anchorA, a2) > similarity(anchorA, b2),
    `${similarity(anchorA, a2).toFixed(3)} 対 ${similarity(anchorA, b2).toFixed(3)}`);
  check('同じ人どうしのほうが近い（低い声）', similarity(anchorB, b2) > similarity(anchorB, a2),
    `${similarity(anchorB, b2).toFixed(3)} 対 ${similarity(anchorB, a2).toFixed(3)}`);

  // 録りの音量で結論が変わらないこと（マイクの近さで振り分けが変わると使えない）
  const quiet = printOf(A, 55, 0.08);
  const loud = printOf(A, 55, 1.0);
  check('小さく録っても同じ人と判る', pickSpeaker(quiet, anchors).id === 'A');
  check('大きく録っても同じ人と判る', pickSpeaker(loud, anchors).id === 'A');

  // ここからが本番。声の高さがほとんど同じ 2 人（音色だけが手がかり）。
  {
    const C = { f0: 190, formants: [700, 1150, 2700] };
    const D = { f0: 196, formants: [560, 1750, 2500] };
    const ac = printOf(C, 201);
    const ad = printOf(D, 202);
    const pair = [{ id: 'C', print: ac }, { id: 'D', print: ad }];
    let ok2 = 0;
    let n2 = 0;
    const m2 = [];
    for (let i = 0; i < 6; i += 1) {
      for (const [name, spec] of [['C', C], ['D', D]]) {
        const decision = pickSpeaker(printOf(spec, 300 + i * 11 + (name === 'C' ? 0 : 5)), pair);
        n2 += 1;
        if (decision.id === name) ok2 += 1;
        m2.push(decision.margin);
      }
    }
    check('高さが近い 2 人でも振り分けられる', ok2 === n2, `${ok2} / ${n2}`);
    check(
      '高さが近いと差は小さくなる',
      Math.min(...m2) < worst,
      `いちばん小さい差 ${Math.min(...m2).toFixed(3)}（高さが違うときは ${worst.toFixed(3)}）`,
    );
  }

  // 声の出ていない所からは指紋を作らない（間や無音で判定してしまわないこと）
  check('無音からは指紋を作らない', voicePrint(new Float32Array(SR), SR) === null);
  check('短すぎる区間からは作らない', voicePrint(new Float32Array(200), SR) === null);
}

// ---- 切り抜き枠を掴むところ ----
{
  const { handleSize, handleSizeFor, handleRect, moveCropRect, CROP_HANDLES } = await import('../src/engine/crop.ts');
  const W = 1080;
  const source = { x: 0, y: 0, w: 1080, h: 1920 };

  // 大きい枠では、つまみは今までどおりの大きさ
  const big = { x: 100, y: 200, w: 800, h: 1200 };
  check('大きい枠ではつまみの大きさは変わらない', handleSizeFor(W, big) === handleSize(W));

  // 小さい枠では、つまみが枠の 1/3 を超えない
  const small = { x: 400, y: 800, w: 120, h: 90 };
  const s = handleSizeFor(W, small);
  check('小さい枠ではつまみが縮む', s < handleSize(W), `${s.toFixed(1)} < ${handleSize(W).toFixed(1)}`);
  check('つまみは枠の 1/3 まで', s <= small.h / 3 + 1e-9, `${s.toFixed(1)} <= ${(small.h / 3).toFixed(1)}`);

  // 真ん中はどのつまみにも取られていない（＝掴んで動かせる）
  const center = { x: small.x + small.w / 2, y: small.y + small.h / 2 };
  const inside = (r, pt) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
  const taken = CROP_HANDLES.filter((h) => inside(handleRect(W, small, h), center));
  check('小さい枠でも真ん中は掴める', taken.length === 0, `取られているつまみ: ${taken.join(',') || 'なし'}`);

  // 場所だけずらす＝大きさは変わらない
  const moved = moveCropRect(small, 60, -40, source);
  check('ずらしても大きさは変わらない', moved.w === small.w && moved.h === small.h);
  check('ずらした量どおりに動く', moved.x === 460 && moved.y === 760, `${moved.x} / ${moved.y}`);

  // 素材の外へは出ない
  const pushed = moveCropRect(small, 9999, -9999, source);
  check('右へ押しても素材の外へ出ない', pushed.x === source.w - small.w && pushed.y === 0, `${pushed.x} / ${pushed.y}`);
  check('端まで行っても大きさは保つ', pushed.w === small.w && pushed.h === small.h);
}

// ---- 書き起こしの取り込み ----
{
  const {
    parseTimecode, parseTranscript, parseCueFile, parseWhisperJson,
    splitCue, tidyCues, readableDuration, mapSpeakers,
  } = await import('../src/model/transcript.ts');

  check('時刻: 時分秒コンマ', parseTimecode('00:01:02,500') === 62.5);
  check('時刻: 分秒ピリオド', parseTimecode('01:02.500') === 62.5);
  check('時刻: 秒だけ', parseTimecode('7.25') === 7.25);
  check('時刻: 読めないものは null', parseTimecode('あ') === null);

  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    '英語どこから喋れんの',
    '',
    '2',
    '00:00:03,500 --> 00:00:05,000',
    'ペラペラペーニョ',
    '',
  ].join('\n');
  const fromSrt = parseCueFile(srt);
  check('SRT を読める', fromSrt.length === 2, `${fromSrt.length} 行`);
  check('SRT の時刻', fromSrt[0].start === 1 && fromSrt[0].end === 3.5);
  eq('SRT の本文', fromSrt[1].text, 'ペラペラペーニョ');

  const vtt = [
    'WEBVTT',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:03.500 line:90%',
    '<v ルミ>英語どこから喋れんの</v>',
    '',
  ].join('\n');
  const fromVtt = parseCueFile(vtt);
  check('VTT を読める', fromVtt.length === 1, `${fromVtt.length} 行`);
  eq('VTT の飾りは落とす', fromVtt[0].text, '英語どこから喋れんの');
  check('VTT の後ろの設定は時刻に混ぜない', fromVtt[0].end === 3.5, String(fromVtt[0].end));

  const json = JSON.stringify({
    segments: [
      {
        start: 1, end: 4, text: '英語どこから喋れんの', speaker: 'SPEAKER_00',
        words: [
          { word: '英語', start: 1, end: 1.6 },
          { word: 'どこから', start: 1.6, end: 2.6 },
          { word: '喋れんの', start: 2.6, end: 4 },
        ],
      },
      { start: 4, end: 5, text: 'ペラペラペーニョ', speaker: 'SPEAKER_01' },
    ],
  });
  const fromJson = parseWhisperJson(json);
  check('JSON を読める', fromJson.length === 2);
  check('JSON の話者を持つ', fromJson[0].speaker === 'SPEAKER_00');
  check('JSON の単語を持つ', (fromJson[0].words ?? []).length === 3);
  check('中身を見て選り分ける', parseTranscript(json).length === 2 && parseTranscript(srt).length === 2);

  // 割る（単語の時刻あり）
  const byWords = splitCue(fromJson[0], 6);
  check('長い行は割れる', byWords.length > 1, `${byWords.length} 行`);
  check('割っても頭と尻は動かない', byWords[0].start === 1 && byWords[byWords.length - 1].end === 4);
  check('割った時刻は前後しない', byWords.every((c, i) => i === 0 || c.start >= byWords[i - 1].start && c.end >= c.start));
  check('単語の終わりで切れている', byWords.slice(0, -1).every((c) => [1.6, 2.6, 4].includes(c.end)),
    byWords.map((c) => `${c.start}-${c.end}`).join(' '));

  // 割る（単語の時刻なし）
  const plain = { start: 0, end: 4, text: '自動翻訳できるぐらいには英語喋れるの', speaker: null };
  const byChars = splitCue(plain, 8);
  check('単語が無くても割れる', byChars.length > 1, `${byChars.length} 行`);
  check('按分しても頭と尻は動かない', byChars[0].start === 0 && byChars[byChars.length - 1].end === 4);
  check('割った本文をつなぐと元に戻る', byChars.map((c) => c.text.replace(/\n/g, '')).join('') === plain.text,
    byChars.map((c) => c.text.replace(/\n/g, '/')).join(' | '));

  // 短い行を伸ばす
  {
    const r = tidyCues([
      { start: 0, end: 0.2, text: '英語どこから喋れんの', speaker: null },
      { start: 3, end: 3.1, text: 'うそ', speaker: null },
    ], { maxChars: 40 });
    check('短い行を伸ばした', r.extended === 2, `${r.extended} 行`);
    check('伸ばしても次の行にぶつからない', r.cues[0].end <= r.cues[1].start, `${r.cues[0].end} <= ${r.cues[1].start}`);
    check('読める長さに届いている', r.cues[1].end - r.cues[1].start >= readableDuration('うそ') - 1e-9);
  }
  // 次の行がすぐ来るときは、伸ばしきれないことを数える
  {
    const r = tidyCues([
      { start: 0, end: 0.1, text: '英語どこから喋れんの', speaker: null },
      { start: 0.3, end: 3, text: 'ペラペラペーニョ', speaker: null },
    ], { maxChars: 40 });
    check('伸ばしきれない行を数える', r.stillShort === 1, `${r.stillShort} 行`);
    check('それでも重なってはいない', r.cues[0].end <= r.cues[1].start);
  }
  // 伸ばさない指定
  {
    const r = tidyCues([{ start: 0, end: 0.2, text: 'うそ', speaker: null }], { extendShort: false });
    check('伸ばさない指定が効く', r.extended === 0 && r.cues[0].end === 0.2);
  }
  // 先頭のずれ
  {
    const r = tidyCues([{ start: 1, end: 3, text: 'うそ', speaker: null }], { offset: 10 });
    check('先頭のずれを足せる', r.cues[0].start === 11, String(r.cues[0].start));
  }

  // whisper の返しを行にする
  {
    const { cuesFromSegments, cuesFromWords, clipTimeline } = await import('../src/model/transcript.ts');
    const segs = cuesFromSegments([
      { timestamp: [0, 2], text: ' 英語どこから喋れんの' },
      { timestamp: [2.5, null], text: ' は?' },
    ]);
    check('文ごとの結果を行にする', segs.length === 2);
    eq('前後の空白は落とす', segs[0].text, '英語どこから喋れんの');
    check('終わりが無いものを埋める', segs[1].end === 4.5, String(segs[1].end));

    const words = cuesFromWords([
      { timestamp: [0, 0.4], text: '英語' },
      { timestamp: [0.4, 0.9], text: 'どこから' },
      { timestamp: [0.9, 1.4], text: '喋れんの?' },
      { timestamp: [3.0, 3.4], text: 'は?' },
    ]);
    check('間があいたら切る', words.length === 2, `${words.length} 行`);
    eq('つないだ本文', words[0].text, '英語どこから喋れんの?');
    check('単語の時刻を持ち越す', (words[0].words ?? []).length === 3);
    check('行の頭と尻は単語のとおり', words[0].start === 0 && words[0].end === 1.4);

    const long = cuesFromWords(
      Array.from({ length: 10 }, (_, i) => ({ timestamp: [i * 0.2, i * 0.2 + 0.2], text: 'あいう' })),
      { maxChars: 6 },
    );
    check('長くなりすぎたら切る', long.length === 5, `${long.length} 行`);

    // 素材の中の時刻 → タイムライン上の時刻
    const moved = clipTimeline(
      [
        { start: 0, end: 1, text: '前', speaker: null },
        { start: 10, end: 12, text: '中', speaker: null, words: [{ start: 10, end: 12, text: '中' }] },
        { start: 99, end: 100, text: '後', speaker: null },
      ],
      { start: 5, sourceIn: 8, duration: 6, speed: 1 },
    );
    check('使っていない範囲は落とす', moved.length === 1 && moved[0].text === '中',
      moved.map((c) => c.text).join(','));
    check('タイムラインの時刻へ移す', moved[0].start === 7 && moved[0].end === 9,
      `${moved[0].start} / ${moved[0].end}`);
    check('単語の時刻も移す', moved[0].words[0].start === 7);

    // 速さを変えたクリップ
    const fast = clipTimeline([{ start: 4, end: 6, text: 'あ', speaker: null }],
      { start: 0, sourceIn: 0, duration: 5, speed: 2 });
    check('速さを変えても合う', fast[0].start === 2 && fast[0].end === 3, `${fast[0].start} / ${fast[0].end}`);

    // 端が掛かっているものは、掛かっている所だけ
    const edge = clipTimeline([{ start: 0, end: 10, text: 'あ', speaker: null }],
      { start: 0, sourceIn: 4, duration: 3, speed: 1 });
    check('端は切り詰める', edge[0].start === 0 && edge[0].end === 3, `${edge[0].start} / ${edge[0].end}`);
  }

  // 話者の割り当ては出てきた順
  {
    const map = mapSpeakers([
      { start: 0, end: 1, text: 'あ', speaker: 'B' },
      { start: 1, end: 2, text: 'い', speaker: 'A' },
      { start: 2, end: 3, text: 'う', speaker: 'B' },
    ], ['1', '2']);
    check('話者は出てきた順に割り当てる', map.get('B') === '1' && map.get('A') === '2');
  }
}

// ---- 文字起こしに渡す前の下ごしらえ ----
{
  const { voiceSpans, condense, restoreTime, normalize, highpass } = await import('../src/engine/speech.ts');
  const SR = 16000;

  /** 声のつもりの音（倍音つき）を、その区間だけ置いた波形を作る。 */
  const make = (seconds, spans) => {
    const out = new Float32Array(Math.round(seconds * SR));
    for (const [from, to] of spans) {
      for (let i = Math.round(from * SR); i < Math.round(to * SR) && i < out.length; i += 1) {
        const t = i / SR;
        out[i] = 0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.2 * Math.sin(2 * Math.PI * 360 * t);
      }
    }
    return out;
  };

  // 0–1 秒と 3–4 秒だけ声、あいだは無音
  const audio = make(5, [[0, 1], [3, 4]]);
  const spans = voiceSpans(audio, SR);
  check('声のある所を 2 つ見つける', spans.length === 2, spans.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(' '));
  check('1 つ目はだいたい 0〜1 秒', spans[0].start <= 0.05 && Math.abs(spans[0].end - 1) < 0.3,
    `${spans[0].start.toFixed(2)}-${spans[0].end.toFixed(2)}`);
  check('2 つ目はだいたい 3〜4 秒', Math.abs(spans[1].start - 3) < 0.3 && Math.abs(spans[1].end - 4) < 0.3,
    `${spans[1].start.toFixed(2)}-${spans[1].end.toFixed(2)}`);

  // 短い息継ぎでは切らない
  const breath = voiceSpans(make(3, [[0, 1], [1.15, 2.5]]), SR);
  check('短い切れ目では切らない', breath.length === 1, `${breath.length} 区間`);

  // 雑音のような一瞬は拾わない
  const blip = voiceSpans(make(3, [[0, 1], [2.0, 2.05]]), SR);
  check('一瞬の音は拾わない', blip.length === 1, `${blip.length} 区間`);

  // 全部無音なら何も見つけない
  check('無音からは何も見つけない', voiceSpans(new Float32Array(SR * 2), SR).length === 0);

  // 繋いで、時刻を戻す
  {
    const packed = condense(audio, SR, spans);
    check('繋ぐと短くなる', packed.audio.length < audio.length,
      `${(packed.audio.length / SR).toFixed(2)} 秒 < ${(audio.length / SR).toFixed(2)} 秒`);
    check('残した割合を返す', packed.kept > 0.3 && packed.kept < 0.8, packed.kept.toFixed(2));

    // 繋いだあとの 0 秒は、元の 1 つ目の頭
    check('頭の時刻はそのまま', Math.abs(restoreTime(packed.map, 0) - spans[0].start) < 1e-6);
    // 2 つ目の頭（繋いだあと）は、元の 2 つ目の頭に戻る
    const second = packed.map[1].at;
    check('2 つ目の頭が元へ戻る', Math.abs(restoreTime(packed.map, second) - spans[1].start) < 1e-6,
      `${restoreTime(packed.map, second).toFixed(2)} / ${spans[1].start.toFixed(2)}`);
    // 戻した時刻は前後しない
    let prev = -1;
    let ordered = true;
    for (let t = 0; t < packed.audio.length / SR; t += 0.05) {
      const at = restoreTime(packed.map, t);
      if (at < prev - 1e-9) ordered = false;
      prev = at;
    }
    check('戻した時刻は前後しない', ordered);
  }

  // 音量を揃える
  {
    const quiet = new Float32Array(1000);
    for (let i = 0; i < quiet.length; i += 1) quiet[i] = 0.02 * Math.sin(i / 5);
    const loud = normalize(quiet);
    const peak = Math.max(...Array.from(loud).map(Math.abs));
    check('小さい音を持ち上げる', Math.abs(peak - 0.95) < 0.01, peak.toFixed(3));
    // すでに大きいものは触らない
    const already = new Float32Array([0.99, -0.99, 0.5]);
    check('大きい音はそのまま', normalize(already) === already);
  }

  // 低い所を落とす
  {
    const n = SR;
    const low = new Float32Array(n);
    const mid = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      low[i] = Math.sin((2 * Math.PI * 20 * i) / SR);
      mid[i] = Math.sin((2 * Math.PI * 500 * i) / SR);
    }
    const rms = (a) => Math.sqrt(Array.from(a).reduce((s, v) => s + v * v, 0) / a.length);
    const lowAfter = rms(highpass(low, SR)) / rms(low);
    const midAfter = rms(highpass(mid, SR)) / rms(mid);
    check('低い音は落ちる', lowAfter < 0.4, lowAfter.toFixed(3));
    check('声の高さは残る', midAfter > 0.9, midAfter.toFixed(3));
  }
}

// ---- 幻の行を落とす ----
{
  const { dropHallucinations } = await import('../src/model/transcript.ts');
  const cue = (start, end, text) => ({ start, end, text, speaker: null });

  const r = dropHallucinations([
    cue(0, 2, '英語どこから喋れんの'),
    cue(2, 4, 'ご視聴ありがとうございました'),
    cue(4, 6, 'ご視聴ありがとうございました。'),
    cue(6, 8, 'ペラペラペーニョ'),
    cue(8, 10, 'ペラペラペーニョ'),
    cue(10, 12, 'あああああああああ'),
    cue(12, 12.5, 'これはどう考えても一息では言い切れない長さの文章である'),
  ]);
  eq('残った本文', r.cues.map((c) => c.text), ['英語どこから喋れんの', 'ペラペラペーニョ']);
  check('決まり文句を 2 つ落とす', r.boilerplate === 2, String(r.boilerplate));
  check('繰り返しを 1 つ落とす', r.repeated === 1, String(r.repeated));
  check('壊れた出力を 2 つ落とす', r.garbled === 2, String(r.garbled));
  check('繰り返しを畳んだぶん尺は伸びる', r.cues[1].end === 10, String(r.cues[1].end));

  // 短い相槌や、正しく繰り返される言葉は落とさない
  const keep = dropHallucinations([cue(0, 0.4, 'は?'), cue(1, 1.4, 'うそ'), cue(2, 2.4, 'は?')]);
  check('離れた同じ相槌は残す', keep.cues.length === 3, `${keep.cues.length} 行`);
  // 「そうそうそう」くらいは壊れた出力にしない
  const three = dropHallucinations([cue(0, 1.5, 'そうそうそう')]);
  check('三回続く言い回しは残す', three.cues.length === 1);
}

// ---- エフェクトを時間で効かせる ----
{
  const { effectAmount, effectIntensity, EFFECT_NEUTRAL, DEFAULT_EFFECT_TIMING } =
    await import('../src/model/effects.ts');

  const head = { start: 0, duration: 0.25, attack: 0, release: 0.2 };
  check('区間の外は効かない', effectAmount(head, 0.5, 3) === 0 && effectAmount(head, -1, 3) === 0);
  check('区間の頭では効いている', effectAmount(head, 0.01, 3) > 0.9, effectAmount(head, 0.01, 3).toFixed(2));
  check('抜けの途中は中くらい', effectAmount(head, 0.15, 3) > 0.1 && effectAmount(head, 0.15, 3) < 0.9,
    effectAmount(head, 0.15, 3).toFixed(2));
  check('区間の終わりでは戻っている', effectAmount(head, 0.249, 3) < 0.1, effectAmount(head, 0.249, 3).toFixed(2));

  // 長さ 0 は「最後まで」
  const rest = { start: 1, duration: 0, attack: 0, release: 0 };
  check('長さ 0 は最後まで', effectAmount(rest, 2.9, 3) === 1 && effectAmount(rest, 0.5, 3) === 0);

  // 立ち上がりと抜けが区間を超えても、はみ出さない
  const tight = { start: 0, duration: 0.2, attack: 1, release: 1 };
  let inside = true;
  for (let t = -0.5; t < 1; t += 0.01) {
    const v = effectAmount(tight, t, 3);
    if (v > 0 && (t <= 0 || t >= 0.2)) inside = false;
    if (v < 0 || v > 1) inside = false;
  }
  check('立ち上がりと抜けは区間の内側に収まる', inside);

  // 素通しの値へ戻る（明るさは 0 ではなく 0.5 が素通し）
  const dark = { id: 'x', type: 'brightness', intensity: 0.1, timing: head };
  check('効いていない所は素通しの値', Math.abs(effectIntensity(dark, 1.0, 3) - EFFECT_NEUTRAL.brightness) < 1e-9,
    String(effectIntensity(dark, 1.0, 3)));
  check('効いている所は掛けた値', Math.abs(effectIntensity(dark, 0.01, 3) - 0.1) < 0.02,
    String(effectIntensity(dark, 0.01, 3)));

  // 時間の指定が無ければ、これまでどおり
  const plain = { id: 'y', type: 'blur', intensity: 0.4 };
  check('指定が無ければ強さそのまま', effectIntensity(plain, 0, 3) === 0.4 && effectIntensity(plain, 2, 3) === 0.4);

  // 既定の形は「頭だけ」
  check('既定は頭で効く', effectAmount(DEFAULT_EFFECT_TIMING, 0.01, 3) > 0.9);
}

// ---- 外で組み立てたプロジェクト ----
{
  const { buildAutoEdit, toProjectFile } = await import('../src/model/autoedit.ts');
  const media = {
    id: 'asset_x', name: '配信.mp4', kind: 'video', src: '配信/haishin.mp4',
    width: 1920, height: 1080, duration: 3600,
  };
  const cues = [
    { start: 3600 - 3590, end: 3600 - 3588, text: '英語どこから喋れんの', speaker: null },
    { start: 12, end: 14, text: 'ペラペラペーニョ', speaker: null },
    { start: 3000, end: 3002, text: 'これは範囲の外', speaker: null },
  ];

  const r = buildAutoEdit(media, cues, { from: 5, to: 20, name: '切り抜き' });
  check('名前が付く', r.project.name === '切り抜き');
  check('画角は縦', r.project.sequence.width === 1080 && r.project.sequence.height === 1920);

  const video = r.project.sequence.clips.filter((c) => c.kind === 'video');
  check('素材は 1 本', video.length === 1, `${video.length} 本`);
  check('使う範囲だけ切り出す', video[0].sourceIn === 5 && video[0].duration === 15,
    `${video[0].sourceIn} / ${video[0].duration}`);
  check('横長は寄せてある', video[0].crop.enabled && video[0].crop.sw < 1, String(video[0].crop.sw));

  check('範囲の外の行は入らない', r.captions === 2, `${r.captions} 枚`);
  const texts = r.project.sequence.clips.filter((c) => c.kind === 'text');
  check('テロップは 1 行ずつ別のクリップ', texts.length === r.captions);
  check('タイムラインの時刻に直っている', texts.every((c) => c.start >= 0 && c.start < 15),
    texts.map((c) => c.start.toFixed(1)).join(','));
  check('確かめてほしい所を返す', r.notes.length > 0);

  // 範囲が空なら、黙って空のものを作らずに止まる
  let threw = false;
  try { buildAutoEdit(media, cues, { from: 10, to: 10 }); } catch { threw = true; }
  check('範囲が空なら止まる', threw);

  // 見出しは「飾り」なので、字幕なしで書き出しても残る側
  const titled = buildAutoEdit(media, cues, {
    from: 0, to: 20, title: 'ただ喋れば', titleStyle: { fontSize: 140 },
  });
  const title = titled.project.sequence.clips.find((c) => c.text?.content === 'ただ喋れば');
  check('見出しを置ける', !!title);
  check('見出しは飾り扱い', title.text.role === 'design', String(title.text.role));

  // 3 段
  const three = buildAutoEdit(media, cues, { from: 0, to: 20, layout: 'three' });
  const videos = three.project.sequence.clips.filter((c) => c.kind === 'video');
  check('3 段は映像が 3 本', videos.length === 3, `${videos.length} 本`);

  // そのまま書ける形
  const file = toProjectFile(r, media);
  check('アプリが読む形になっている', file.app === 'vivid-edit' && file.version === 1);
  check('素材の在り処が入っている', file.assets[0].src === '配信/haishin.mp4');
  check('JSON にできる', typeof JSON.stringify(file) === 'string');
}

// ---- 解析の結果を編集に直す ----
{
  const { segmentCenters } = await import('../src/analysis/segments.ts');
  const {
    sourceToTimeline, timelineToSource, splitClipAtTimes, splitAtSceneBoundaries,
    reframeWindow, reframeCrop, applyReframeSegments,
  } = await import('../src/model/analysisEdits.ts');
  const { createProject, clipFromAsset } = await import('../src/model/factory.ts');
  const { placeClip, tracksOf } = await import('../src/model/ops.ts');

  // --- 中心の列 → 止まった区間 ---
  const track = (fn, seconds = 6, fps = 30) =>
    Array.from({ length: seconds * fps }, (_, i) => ({ time: i / fps, center: fn(i / fps) }));

  check('空の列は空', segmentCenters([]).length === 0);

  const flat = segmentCenters(track(() => 0.5));
  check('動かない列は 1 区間', flat.length === 1 && Math.abs(flat[0].center - 0.5) < 1e-9, `${flat.length} 区間`);

  const three = segmentCenters(track((t) => (t < 2 ? 0.3 : t < 4 ? 0.7 : 0.3)));
  check('3 つに分かれる', three.length === 3, `${three.length} 区間`);
  check('中心が合っている', Math.abs(three[0].center - 0.3) < 0.01 && Math.abs(three[1].center - 0.7) < 0.01);
  check('区間は隙間なく並ぶ', three[0].to === three[1].from && three[1].to === three[2].from);
  check('境目はだいたい 2 秒と 4 秒', Math.abs(three[1].from - 2) < 0.1 && Math.abs(three[2].from - 4) < 0.1,
    `${three[1].from.toFixed(2)} / ${three[2].from.toFixed(2)}`);

  // 0.3 秒だけ寄り道する列は、区間にしない（短すぎて割るとちらつく）
  const blip = segmentCenters(track((t) => (t > 2.9 && t < 3.2 ? 0.8 : 0.3)));
  check('短い寄り道は区間にしない', blip.length === 1, `${blip.length} 区間`);

  // 上限を超えるときは畳んで収める
  const zigzag = track((t) => (Math.floor(t / 1) % 2 ? 0.8 : 0.2), 20);
  const capped = segmentCenters(zigzag, { maxSegments: 5 });
  check('数の上限に収まる', capped.length <= 5, `${capped.length} 区間`);
  check('畳んでも全部の秒をまたぐ', capped[0].from === 0 && capped[capped.length - 1].to > 19.9);

  // --- 2 つの時計 ---
  const project = createProject('test');
  let seq = project.sequence;
  const videoTrack = tracksOf(seq, 'video')[0];
  const base = { ...clipFromAsset({ id: 'm', kind: 'video', duration: 100 }, videoTrack.id, 5), sourceIn: 20, duration: 10 };
  seq = placeClip(seq, base);

  check('素材の秒 → タイムライン', sourceToTimeline(base, 23) === 8);
  check('タイムライン → 素材の秒', timelineToSource(base, 8) === 23);
  const fast = { ...base, speed: 2 };
  check('速さ 2 倍で往復が合う', Math.abs(timelineToSource(fast, sourceToTimeline(fast, 27)) - 27) < 1e-9);
  check('速さ 2 倍だと素材の 2 秒が 1 秒', sourceToTimeline(fast, 22) === 6);

  // --- クリップを割る ---
  const split = splitClipAtTimes(seq, base.id, [8, 12]);
  const pieces = split.pieceIds.map((id) => split.sequence.clips.find((c) => c.id === id));
  check('3 つに割れる', pieces.length === 3 && pieces.every(Boolean), `${pieces.length} 本`);
  check('割った長さの合計は元と同じ', Math.abs(pieces.reduce((n, c) => n + c.duration, 0) - 10) < 1e-9);
  check('素材のイン点が連なる', pieces[0].sourceIn === 20 && pieces[1].sourceIn === 23 && pieces[2].sourceIn === 27,
    pieces.map((c) => c.sourceIn).join(','));
  check('時間順に並ぶ', pieces[0].start === 5 && pieces[1].start === 8 && pieces[2].start === 12);

  // 端に近い・重複した秒は飛ばす
  const edgy = splitClipAtTimes(seq, base.id, [5.02, 8, 8, 14.97]);
  check('端と重複は飛ばす', edgy.pieceIds.length === 2, `${edgy.pieceIds.length} 本`);

  // 存在しない id
  check('無い id は何もしない', splitClipAtTimes(seq, 'nope', [8]).sequence === seq);

  // シーンの切れ目：使っていない範囲は無視する
  const scene = splitAtSceneBoundaries(seq, base.id, [10, 23, 27, 50]);
  check('使っている範囲の切れ目だけで割る', scene.pieceIds.length === 3, `${scene.pieceIds.length} 本`);

  // --- リフレーム ---
  const wide = reframeWindow({ width: 1920, height: 1080 }, 1080 / 1920);
  check('横長 → 横の窓', wide.axis === 'x' && Math.abs(wide.size - 0.3164) < 0.001, JSON.stringify(wide));
  const tall = reframeWindow({ width: 1080, height: 1920 }, 1);
  check('縦長 → 縦の窓', tall.axis === 'y' && Math.abs(tall.size - 0.5625) < 1e-9, JSON.stringify(tall));
  check('同じ縦横比なら要らない', reframeWindow({ width: 1080, height: 1920 }, 1080 / 1920) === null);
  check('寸法が無ければ null', reframeWindow({ width: 0, height: 0 }, 1) === null);

  const left = reframeCrop(wide, 0.02);
  check('左へはみ出さない', left.sx === 0 && left.sw === wide.size);
  const right = reframeCrop(wide, 0.99);
  check('右へはみ出さない', Math.abs(right.sx + right.sw - 1) < 1e-9);
  const mid = reframeCrop(wide, 0.5);
  check('中央なら窓が真ん中', Math.abs(mid.sx - (0.5 - wide.size / 2)) < 1e-9);
  check('全面へ置く', mid.dx === 0 && mid.dy === 0 && mid.dw === 1 && mid.dh === 1 && mid.enabled);
  const vertical = reframeCrop(tall, 0.3);
  check('縦の窓は縦を切る', vertical.sx === 0 && vertical.sw === 1 && vertical.sh === tall.size);

  // 区間を適用する
  const segs = [
    { from: 20, to: 24, center: 0.3 },
    { from: 24, to: 30, center: 0.7 },
  ];
  const applied = applyReframeSegments(seq, base.id, segs, wide);
  check('区間の数だけクリップになる', applied.segments === 2, `${applied.segments} 本`);
  const parts = applied.sequence.clips.filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start);
  check('クリップが 2 本', parts.length === 2);
  check('区間ごとに別の枠', Math.abs(parts[0].crop.sx - parts[1].crop.sx) > 0.3,
    `${parts[0].crop.sx.toFixed(2)} / ${parts[1].crop.sx.toFixed(2)}`);
  check('境目は区間の頭', Math.abs(parts[1].start - 9) < 1e-9, String(parts[1].start));
  check('合計の長さは元と同じ', Math.abs(parts[0].duration + parts[1].duration - 10) < 1e-9);

  // 1 区間だけなら割らずにクロップだけ入れる
  const one = applyReframeSegments(seq, base.id, [{ from: 20, to: 30, center: 0.5 }], wide);
  const single = one.sequence.clips.filter((c) => c.kind === 'video');
  check('1 区間は割らない', one.segments === 1 && single.length === 1 && single[0].crop.enabled);

  // 使っていない範囲の区間は無視する
  const none = applyReframeSegments(seq, base.id, [{ from: 60, to: 70, center: 0.5 }], wide);
  check('範囲外の区間だけなら何もしない', none.segments === 0 && none.sequence === seq);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  :: ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed} / ${results.length} 件が通りました。`);
process.exit(failed ? 1 : 0);
