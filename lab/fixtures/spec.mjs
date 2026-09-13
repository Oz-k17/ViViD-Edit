/**
 * 試し用素材の「正解」。
 *
 * どこでしゃべっているかを作る側と測る側の両方から参照できるようにしておく。
 * 正解が分かっていれば、「この特徴量は声とそれ以外をどれくらい分けられるか」を
 * 当てずっぽうではなく数字で比べられる。
 */

export const SHORT_LENGTH = 13;

/**
 * まばらな発話（秒）。BGM の上でたまにしゃべるだけ、という素材のため。
 * 13 秒のうち 2.6 秒しかしゃべらない（20%）。
 */
export const SPARSE_UTTERANCES = [
  [2.0, 3.4],
  [9.0, 10.2],
];

/** 発話の並び（秒）。息継ぎ（0.2 秒）と間（0.7〜1.2 秒）を混ぜてある。 */
export const UTTERANCES = [
  [1.0, 2.2],
  [2.9, 4.4],
  [4.6, 5.4],
  [6.6, 8.0],
  [8.2, 8.9],
  [10.0, 11.6],
];

/**
 * 短いほうの素材の一覧。`hard` は「声を見分ける処理をいじめるために足したもの」。
 * options はそのまま make-audio.mjs の makeShort へ渡る。
 */
export const SHORT_FIXTURES = [
  { name: 'speech.wav', note: 'きれいに録れた声', speech: true, options: { seed: 1 } },
  { name: 'speech-bgm.wav', note: 'BGM 込みで録った', speech: true, options: { bgm: true, seed: 2 } },
  { name: 'speech-noisy.wav', note: '部屋のノイズが大きい', speech: true, options: { noiseLevel: 0.02, seed: 3 } },
  {
    name: 'speech-quiet.wav',
    note: '録音レベルが小さい',
    speech: true,
    options: { speechLevel: 0.06, noiseLevel: 0.0006, seed: 4 },
  },
  { name: 'bgm.wav', note: '音楽だけ', speech: false, options: { speech: false, bgm: true, noiseLevel: 0.0005, seed: 5 } },

  // ここから下は意地悪な素材。「うまくいった」が素材のおかげでないことを確かめるためのもの。
  {
    name: 'speech-bgm-loud.wav',
    note: 'BGM が大きい（音量では分けられない）',
    speech: true,
    hard: true,
    options: { bgm: true, bgmLevel: 0.4, seed: 6 },
  },
  {
    name: 'speech-drums.wav',
    note: '1 秒に 4 回刻む打楽器の上でしゃべる',
    speech: true,
    hard: true,
    options: { beat: 4, seed: 7 },
  },
  {
    name: 'drums.wav',
    note: 'その打楽器だけ（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, beat: 4, noiseLevel: 0.0005, seed: 8 },
  },
  {
    name: 'music-tremolo.wav',
    note: '声と同じ速さで震える楽器だけ（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, bgm: true, bgmLevel: 0.3, bgmTremolo: 4.5, noiseLevel: 0.0005, seed: 10 },
  },
  {
    // 「包絡（スペクトルの形）が動いたか」で声を見分ける手を潰しにいく素材。
    // 音量だけでなく**形そのもの**が声と同じ速さで動くので、
    // トレモロを弾けた手（shapeChange）でも弾けないはず。
    name: 'music-wah.wav',
    note: '声と同じ速さでフォルマントが動く楽器（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, wah: 4.2, noiseLevel: 0.0005, seed: 13 },
  },
  {
    // 「どこかで形が動いたら声がある」とみなす素材単位の判定を潰しにいく素材。
    // 本物の曲はたいてい和音が変わるので、鳴りっぱなしの bgm.wav よりこちらが普通。
    name: 'music-chords.wav',
    note: '和音が 1.5 秒ごとに変わる音楽（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, chordEvery: 1.5, noiseLevel: 0.0005, seed: 14 },
  },
  {
    // **包絡の門＋保持**（2026-09-11・3 回目）を潰しにいく素材。
    // 保持は「いったん音色が動いたら 0.5 秒は開けたまま」なので、
    // **保持より短い間隔で音色が動き続ける音楽**なら、門は一度も閉まらない。
    // 和音を 0.4 秒ごとに変えれば、声がゼロでも門を開けっぱなしにできるはず。
    // 現実の曲でも、刻みの速い伴奏はこれくらいの速さで音が変わる。
    name: 'music-chords-fast.wav',
    note: '和音が 0.4 秒ごとに変わる音楽（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, chordEvery: 0.4, noiseLevel: 0.0005, seed: 16 },
  },
  {
    // **素材単位の形の判定そのもの**を潰しにいく素材（2026-09-12）。
    // 0.4 秒ごとでは「形が動いた秒数」が 0.30 秒までしか伸びず、しきい値 0.5 秒に届かなかった。
    // ところがこれは「声が無いから」ではなく、**変化の間隔が均す窓（0.15 秒）より広いから**
    // 棘が均されて消えていただけ。間隔を窓より狭くすれば、声がゼロでも埋め尽くせるはず。
    // 0.2 秒ごとは 16 分音符（BPM 150）くらいで、刻みの速い伴奏なら現実にいくらでもある。
    name: 'music-chords-faster.wav',
    note: '和音が 0.2 秒ごとに変わる音楽（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, chordEvery: 0.2, noiseLevel: 0.0005, seed: 17 },
  },
  {
    // 「形の変化」で判定する手を潰しにいく素材。背景がほとんど無いので、
    // 声が背景と混ざる効果に頼っていると、ここで声を見失う。
    name: 'speech-dry.wav',
    note: '背景がほぼ無い、乾いた声だけ',
    speech: true,
    hard: true,
    options: { noiseLevel: 0.00002, seed: 11 },
  },
  {
    // 「包絡が動いていないコマは声ではない」とコマ単位で判断する手を潰しにいく素材。
    // 母音を伸ばしている間は口が動かないので、包絡も動かない。
    // **伸ばした母音は現実の話し声に普通にある**ので、ここで声を切るのは
    // 素材の欠陥ではなく判定の欠陥になる。背景も無いので逃げ場は無い。
    name: 'speech-sustained.wav',
    note: '乾いた声・母音を長く伸ばす',
    speech: true,
    hard: true,
    options: { noiseLevel: 0.00002, sustain: true, seed: 12 },
  },
  {
    // **子音に頼る判定を潰しにいく素材**（2026-09-12・2 回目）。
    // この日に `speak()` へ子音と息を足したので、今後「広い帯域に散る雑音の粒があるか」で
    // 声を見分ける手が考えられる。ところが**子音がほとんど無い発声は現実にある**
    // （ハミング・詠唱・歌の母音・伸ばした「あー」）。子音を必須にすると、そこで声を切る。
    // `speech-dry.wav` と**子音と息の有無だけ**が違う（背景も乱数の種も同じ 11）ので、
    // 2 本を並べれば「その判定は子音を見ているのか、声を見ているのか」が出る。
    name: 'speech-vowels-only.wav',
    note: '乾いた声・子音も息も無い（ハミングのような発声）',
    speech: true,
    hard: true,
    options: { noiseLevel: 0.00002, vowelsOnly: true, seed: 11 },
  },
  {
    // 「音量の揺れが規則正しすぎるものは楽器だ」で音楽を弾く手を潰しにいく素材。
    // 音節の長さが揃っているだけで、中身はまぎれもない声（母音も音程も動く）。
    // 拍に乗ってしゃべる場面（ラップ・詠唱・秒読み）は現実にいくらでもある。
    name: 'speech-steady.wav',
    note: '拍に乗って等間隔にしゃべる声',
    speech: true,
    hard: true,
    options: { noiseLevel: 0.00002, steady: true, seed: 15 },
  },
  // 2026-09-11 以前の合成の声（倍音の重みも f0 も発話中ずっと固定）は、**一覧から外した**。
  // スペクトルの形の上ではトレモロの楽器と同じもので、声の模型としては壊れている。
  // これを「守るべき声」として一覧に置くと、判定のほうを素材の欠陥に縛ることになる
  // （実際、そのせいで包絡をコマ単位の門にする手が止まっていた）。
  // 過去の数字を測り直したいときだけ makeShort に `{ flat: true }` を渡して作る。
  {
    // **揺れの割合（modulation）の分母をいじる手**を潰しにいく素材（2026-09-12・3 回目）。
    // いまの分母には「その窓に含まれる揺れ全部」が敷いてある。だから遅く大きなうねりがあると、
    // 音節帯の取り分は分母に食われて小さく出る。**遅いうねりが速い刻みを隠している**わけで、
    // 「遅い帯を分母から外す」のは筋が通って見える。
    // ところがそれをやると、**うねりに隠れていた浅い刻みが表に出てくる**。
    // ゆっくり大きくうねり（0.5Hz・深さ 0.45）、その上に声と同じ速さで浅く刻む音楽（4.2Hz・深さ 0.08）は、
    // 外したとたんに声らしさが跳ね上がるはず。うねりで音量が大きく上下するので
    // 「全編が鳴っている」に落ちず、破れれば声ゼロの素材が切り刻まれる形で実害が出る。
    name: 'music-swell.wav',
    note: 'ゆっくり大きくうねり、浅く刻む音楽（声は無い）',
    speech: false,
    hard: true,
    options: {
      speech: false,
      bgm: true,
      bgmLevel: 0.45,
      bgmSwellDepth: 0.45,
      bgmTremolo: 4.2,
      bgmTremoloDepth: 0.08,
      noiseLevel: 0.0005,
      seed: 18,
    },
  },
  {
    // **「雑音の粒があるか」系の手がかり全部**を潰しにいく素材（2026-09-13）。
    // 2026-09-12（2 回目）に「雑音の粒と音程の粒が短い間に混じるか」を測って、
    // `music-wah` はようやく音楽の側へ落ちたのに、`drums.wav` が完全に破った。
    // そのとき記録に書いた見立てが **「手元の音楽 6 本のうち 5 本が正弦波の和で、
    // 雑音を持つのは drums だけ。だから雑音を手がかりにすると全部お手盛りになる」**。
    // 雑音を持つ音楽が 1 本しか無い状態では、その見立て自体が確かめられない。
    //
    // `music-chords.wav` と**ハイハットの有無だけ**が違う（和音・背景・種はすべて同じ 14）。
    // 2 本を並べれば、動いた数字はハイハットだけが理由だと言い切れる。
    // 和音がゆっくり変わる上で高い雑音が音節の速さで刻む、というのは
    // 現実のポップスの伴奏そのもので、意地悪というより**普通の音楽**に近い。
    name: 'music-hats.wav',
    note: '和音の上でハイハットが刻む音楽（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, chordEvery: 1.5, hat: 4.2, hatLevel: 0.1, noiseLevel: 0.0005, seed: 14 },
  },
  {
    // **`tone`（音色の尖り具合 = 1 - 平坦さ）**を潰しにいく素材（2026-09-13）。
    // 声らしさは `modulation × tone` で測っているが、いま `tone` が声の側で高く出るのは
    // **音楽の側が正弦波の和だから**（鳴っているコマの平坦さ上位 10% が
    // bgm 0.074 / music-chords 0.040 に対し、声は 0.774〜0.823）。
    // 現実の管楽器も弓の擦り音も、音程と**同時に**広い帯域の雑音を出す。
    //
    // 声と違うのは共鳴（フォルマント）が動かないこと。管の長さは音程と一緒に変わるので、
    // 包絡は音程に付いてくるだけで、口のようには独立して動かない。
    // **「雑音があるか」では分けられず、「包絡が動くか」でだけ分かれる**はずの素材で、
    // どちらの手がかりが本物かを切り分けられる。
    name: 'music-flute.wav',
    note: '息の雑音を持つ管楽器（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, flute: true, fluteLevel: 0.07, noiseLevel: 0.0005, seed: 19 },
  },
  {
    name: 'speech-sparse-bgm.wav',
    note: 'BGM の上でたまにしゃべるだけ（20%）',
    speech: true,
    sparse: true,
    hard: true,
    options: { bgm: true, bgmLevel: 0.25, sparse: true, seed: 9 },
  },
];

/** その素材の発話の並び。 */
export function utterancesOf(fixture) {
  if (!fixture.speech) return [];
  return fixture.sparse ? SPARSE_UTTERANCES : UTTERANCES;
}

/** 時刻が発話の中かどうか。声の無い素材は常に false。 */
export function isSpeechAt(fixture, seconds) {
  return utterancesOf(fixture).some(([from, to]) => seconds >= from && seconds < to);
}
