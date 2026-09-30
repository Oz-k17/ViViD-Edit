/**
 * 素材の**要る範囲だけを起こす**ための、区間の組み立て。
 *
 * 2026-09-26（3 回目）に音の先払いを測って、**本命の壁がミックスではなく
 * 素材まるごとのデコードだった**ことが分かった。本体（`src/engine/offline-export.ts`）の
 * `decodeAssetAudio` は素材を**丸ごと 1 本の `AudioBuffer`** にして持ち続けるので、
 * 1 時間の素材から 10 秒だけ切り出すタイムラインでも **1318MB** 乗る。
 * ミックスを窓に割ってもここは 1 バイトも減らない（減るのはミックスの側だけ）。
 *
 * mediabunny の `AudioBufferSink` は `buffers(from, to)` で範囲を指定して読めるので、
 * 「クリップが使う範囲＋のりしろ」だけを起こす形が作れるはず。その組み立てがここ。
 *
 * ## 難しいのは「どこを読むか」ではなく「読んだものの t=0 がずれる」こと
 *
 * 範囲だけ起こすと、出来た `AudioBuffer` の先頭は**素材の先頭ではない**。
 * `source.start(startAt, offset, …)` に渡す `offset` は素材内の絶対秒なので、
 * **区間の頭ぶん引かないと、その差だけ先を鳴らす**。9/26（3 回目）に窓割りで踏んだ
 * 「素材内の位置を進めるのを忘れる」と**符号が逆の同じ穴**で、しかもこちらは
 * 「1 本ぶんまるごと別の場所を鳴らす」ので、もっと派手に外れる。
 * だから置き換えは `offsetInParts` の 1 か所に閉じ込めて、
 * **載らなかった置き方は黙って 0 にせず null を返す**（無音は穴に見えないので)。
 *
 * ## 判断だけを置く
 *
 * ここは DOM も WebAudio も mediabunny も触らない（`lab/README.md` の決まり）。
 * 本当にそのバイト数で済むか・波が同じかは `testkit/audio-range.ts` が
 * 本物の WebM を起こして測る（`npm run lab:export:range`）。
 */

import {
  CHANNELS,
  SAMPLE_RATE,
  BYTES_PER_SAMPLE,
  soundsOf,
  type LabAudioClip,
  type LabAudioSequence,
  type Placement,
  type Sound,
} from './audio-mix.ts';

/** 素材内の区間（秒）。半開区間 [from, to) として読む。 */
export interface SourceRange {
  from: number;
  to: number;
}

/** 1 つの素材について、何を読むか・何を起こすか。 */
export interface AssetDecodePlan {
  mediaId: string;
  assetDuration: number;
  /** 実際に読む区間（のりしろ無し・畳む前）。音 1 本につき 1 つ。 */
  reads: SourceRange[];
  /** 起こす区間（のりしろを付けて畳んだあと）。昇順・重なり無し。 */
  ranges: SourceRange[];
  /** 起こす秒の合計。 */
  seconds: number;
  /** 丸ごと起こすのと変わらなくなったか（畳んだ結果が素材ぜんたいを覆った）。 */
  whole: boolean;
}

export interface DecodePlanOptions {
  /**
   * **助走**（区間の手前に足す秒）。
   *
   * 見立てでは「デコーダは packet の頭からしか始められないので手前は勝手に付く」
   * だったが、**測ったら逆で、手前がいちばん足りなかった**（`lab:export:range`）。
   * 区間の頭から 0.2 秒あたりまで、丸ごと起こしたときと**値が違う**。
   * 覆いが足りないのではなく（要求からの広がりは 0.01 秒しかない）、
   * **デコーダが温まっていない**。Opus は前の packet に重ねて復号するので、
   * 途中から始めると先頭のしばらくが本来の値にならない。
   *
   * なので助走は「足りないぶん」ではなく「捨てるつもりで起こす秒」。
   * 実測では**要る助走が 0.215〜0.237 秒**（助走を 0 / 0.05 / 0.1 / 0.2 と伸ばすと、
   * 違う区画の秒がちょうどそのぶん減る。4 通りが同じ値を指した）。
   * 0.3 秒で開き 1.0e-6 まで、0.5 秒で 1.5e-8 まで落ちる。既定はその 2.1 倍。
   */
  prerollSeconds?: number;
  /**
   * **後ろの余裕**（区間の後ろに足す秒）。
   *
   * 助走と違って、こちらは覆いの話しかない:
   * `buffers(from, to)` の `to` は排他なので最後の 1 標本が落ちる恐れ、
   * `source.start(…, seconds * speed)` の丸めが計算より数標本長く要る、
   * 素材が 48kHz でないときの補間が境目の外の標本を要る。
   * **前後で理由が違うので、対称にする意味がない**（対称にすると助走のぶんだけ
   * 後ろも太って、1 山が短い素材で取り分が倍になる。0.5 対称で 1.50 倍 / 0.5＋0.05 で 1.27 倍）。
   *
   * 実測では**0 でも波は同じ**だった（要求からの広がりが 3.5〜13.5ms あり、それで足りている）。
   * それでも 0 にしていないのは、**48kHz でない素材と速さの丸めを試していない**ため。
   * 1 山 2 秒に対して 2.5% しか増えないので、そこは安いほうへ倒してある。
   */
  tailSeconds?: number;
  /**
   * この隙間以下なら 2 つの区間を 1 本に畳む（秒）。
   *
   * 畳むと起こす秒は増えるが、**区間の数が減る**。区間 1 つごとに
   * 頭出し（seek）とデコーダの立ち上げが要るので、隙間が小さいうちは
   * 「余分に起こす」より「もう 1 回頭出しする」のほうが高い。
   * 釣り合う所は `lab:export:range` が測って出す（この端末では 0.7〜0.9 秒）。
   */
  mergeGapSeconds?: number;
}

/** 助走（秒）。実測した 0.22 秒前後の 2.1 倍。端末やコーデックで動く恐れがあるので余裕を見てある。 */
export const DEFAULT_PREROLL_SECONDS = 0.5;
/** 後ろの余裕（秒）。実測では 0 でも同じだったが、48kHz でない素材と速さの丸めを試していない。 */
export const DEFAULT_TAIL_SECONDS = 0.05;
/**
 * 畳む幅（秒）。**測った釣り合いから取った。**
 * 起こす時間は `1 秒あたり 9〜11ms ＋ 1 区間あたり 8ms`（6 通りを最小二乗で当てた）なので、
 * 隙間 G の 2 本を畳むと 9〜11×G を払って 8 を省く。釣り合うのは **G ＝ 0.7〜0.9 秒**（3 回走らせた幅）。
 */
export const DEFAULT_MERGE_GAP_SECONDS = 1;

/**
 * 1 本の音が素材のどこを読むか。読むところが無ければ null。
 *
 * ループは**折り返しの先まで数える**。`windowSounds` の `loopedOffset` は
 * `[sourceIn, assetDuration)` の中をぐるぐる読むので、鳴らす長さが折り返しの
 * 周期に届いていればその区間ぜんたいが要る。届いていなければ読むのは頭だけ。
 *
 * ただし**ループで `sourceIn` が素材の端に寄っている形は、素材ぜんたいを返す。**
 * 本体の `place()` は `loopStart = min(sourceIn, assetDuration - 0.05)` なので、
 * `sourceIn` が終わり際だと**折り返し先が `sourceIn` より手前へ動く**。
 * そこを詰めて数えると、起こしていない所を鳴らすことになる。
 * （得をしにくい形を安全側に倒す。ループの素材は短いのが普通なので実害は小さい。）
 */
export function readRangeOf(sound: Sound): SourceRange | null {
  const assetDuration = Math.max(0, sound.assetDuration);
  if (!(assetDuration > 0)) return null;
  const wall = Math.max(0, sound.to - sound.from);
  if (!(wall > 0)) return null;
  const played = wall * sound.speed;
  const start = Math.max(0, Math.min(sound.sourceIn, assetDuration));

  if (sound.loop) {
    // 本体の loopStart が sourceIn より手前へ動く形。数えるのをやめて丸ごと。
    if (sound.sourceIn > assetDuration - 0.05) return { from: 0, to: assetDuration };
    const span = Math.max(0.1, assetDuration - sound.sourceIn);
    const to = played >= span ? assetDuration : Math.min(assetDuration, start + played);
    return to > start ? { from: start, to } : null;
  }

  if (start >= assetDuration) return null;
  const to = Math.min(assetDuration, start + played);
  return to > start ? { from: start, to } : null;
}

/** 区間を畳む。助走と後ろの余裕を付け、素材の端で切り、隙間が `gap` 以下なら 1 本にする。 */
export function mergeRanges(
  ranges: SourceRange[],
  assetDuration: number,
  { prerollSeconds = 0, tailSeconds = 0, mergeGapSeconds = 0 }: DecodePlanOptions = {},
): SourceRange[] {
  const preroll = Math.max(0, prerollSeconds);
  const tail = Math.max(0, tailSeconds);
  const gap = Math.max(0, mergeGapSeconds);
  const padded = ranges
    .map((r) => ({
      from: Math.max(0, Math.min(r.from, r.to) - preroll),
      to: Math.min(assetDuration, Math.max(r.from, r.to) + tail),
    }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const out: SourceRange[] = [];
  for (const r of padded) {
    const last = out[out.length - 1];
    // 重なっていても隣り合っていても、隙間が `gap` 以下なら 1 本にする。
    if (last && r.from - last.to <= gap + 1e-9) {
      if (r.to > last.to) last.to = r.to;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/**
 * 素材ごとの「起こす区間」を組む。
 *
 * **数えるのは `soundsOf` が返した音だけ。** 本体の `renderAudioMix` は
 * 消した（muted）クリップの素材まで起こしてから置く段で落とすので、
 * 消しても起こすバイトが減らない（`summarizeAudioCost` がそこを数えている）。
 * 範囲を渡す形にするなら**そこも直る**ので、ここは鳴る音だけを数える。
 * その得は `summarizeRangeCost` の `mutedAssets` に出る。
 */
export function planAssetDecodes(
  sequence: LabAudioSequence,
  {
    prerollSeconds = DEFAULT_PREROLL_SECONDS,
    tailSeconds = DEFAULT_TAIL_SECONDS,
    mergeGapSeconds = DEFAULT_MERGE_GAP_SECONDS,
  }: DecodePlanOptions = {},
): AssetDecodePlan[] {
  if (!(prerollSeconds >= 0)) throw new Error(`prerollSeconds は 0 以上です（${prerollSeconds}）`);
  if (!(tailSeconds >= 0)) throw new Error(`tailSeconds は 0 以上です（${tailSeconds}）`);
  if (!(mergeGapSeconds >= 0)) throw new Error(`mergeGapSeconds は 0 以上です（${mergeGapSeconds}）`);
  const byAsset = new Map<string, { assetDuration: number; reads: SourceRange[] }>();
  for (const sound of soundsOf(sequence)) {
    const range = readRangeOf(sound);
    if (!range) continue;
    const hit = byAsset.get(sound.mediaId);
    if (hit) {
      // 同じ素材を違う尺で持つクリップは本来無いが、渡されたら長いほうに合わせる。
      hit.assetDuration = Math.max(hit.assetDuration, sound.assetDuration);
      hit.reads.push(range);
    } else {
      byAsset.set(sound.mediaId, { assetDuration: sound.assetDuration, reads: [range] });
    }
  }

  const out: AssetDecodePlan[] = [];
  for (const [mediaId, { assetDuration, reads }] of byAsset) {
    const ranges = mergeRanges(reads, assetDuration, { prerollSeconds, tailSeconds, mergeGapSeconds });
    const seconds = ranges.reduce((n, r) => n + (r.to - r.from), 0);
    out.push({
      mediaId,
      assetDuration,
      reads,
      ranges,
      seconds,
      whole: ranges.length === 1 && ranges[0].from <= 1e-9 && ranges[0].to >= assetDuration - 1e-9,
    });
  }
  // 素材の並び順は入力の順（Map の挿入順）。畳む前後で順が動くと読みにくい。
  return out;
}

/** 起こした区間 1 本。`buffer` は呼ぶ側（ブラウザ）が持つので、ここでは境目だけ。 */
export interface DecodedPart {
  mediaId: string;
  /** 起こしたものの先頭が、素材内の何秒か。**デコーダは要求より手前から出す**ので実測値を入れる。 */
  from: number;
  to: number;
  /** 素材の尺。「端まで届いている区間」を知るために要る（下の `offsetInParts` の注）。 */
  assetDuration: number;
}

/**
 * 素材内の絶対秒で書かれた置き方を、**起こした区間の座標へ移す**。
 *
 * 載らなかったら null。**黙って 0 にしない**のが要点で、0 にすると
 * 「別の場所が鳴る」になり、区間の作り方を間違えても波を見るまで気づけない
 * （0 は無音ではなく素材の頭なので、耳でも指紋でも「鳴っている」に見える）。
 *
 * ループは断る。`loopEnd` は起こしたものの末尾になってしまうので、
 * 素材の端までを 1 本で持っていない区間では**折り返し先が変わる**。
 * 断られた側は丸ごと起こす道へ落とす、が呼ぶ側の作り。
 *
 * **素材の端を越えて読む置き方は、区間が端まで届いていれば載せる。**
 * `sourceIn + 尺 × 速さ` が素材より後ろへ出るクリップは本体でも
 * そこから先が無音になるだけで、`readRangeOf` は端で切ってある。
 * 端で切った区間に対して「はみ出たぶんが入っていない」と断ると、
 * **本体では鳴っているクリップを丸ごと落とす**ことになる。
 */
export function offsetInParts(
  parts: DecodedPart[],
  mediaId: string,
  placement: Pick<Placement, 'offset' | 'seconds' | 'speed' | 'loop'>,
): { part: DecodedPart; offset: number } | null {
  const needFrom = placement.offset;
  const needTo = placement.offset + placement.seconds * placement.speed;
  for (const part of parts) {
    if (part.mediaId !== mediaId) continue;
    if (needFrom < part.from - 1e-9) continue;
    const reachesAssetEnd = part.to >= part.assetDuration - 1e-9;
    if (needTo > part.to + 1e-9 && !reachesAssetEnd) continue;
    if (placement.loop) return null;
    return { part, offset: needFrom - part.from };
  }
  return null;
}

/**
 * 組んだ区間を、そのまま「起こしたもの」として並べる（検算用）。
 *
 * 本物のデコーダは要求より手前から出すので、実測では境目がここより広くなる。
 * **狭いほうで検算しておけば、広がった側で落ちることはない。**
 */
export function partsOf(plans: AssetDecodePlan[]): DecodedPart[] {
  const out: DecodedPart[] = [];
  for (const plan of plans) {
    for (const range of plan.ranges) {
      out.push({ mediaId: plan.mediaId, from: range.from, to: range.to, assetDuration: plan.assetDuration });
    }
  }
  return out;
}

export interface RangeCostStats {
  /** 丸ごと起こしたときの秒とバイト（いまの本体）。 */
  wholeSeconds: number;
  wholeBytes: number;
  /** 範囲だけ起こしたときの秒とバイト。 */
  rangeSeconds: number;
  rangeBytes: number;
  /** 起こす区間の本数（頭出しの回数）。 */
  parts: number;
  /** 実際に読む秒（助走も余裕も畳みも入れる前）。起こす秒との差が「余分」。 */
  readSeconds: number;
  /** 素材の数と、そのうち「丸ごと起こすのと変わらなくなった」数。 */
  assets: number;
  wholeAssets: number;
  /** 消したクリップだけが使っていて、範囲の形なら 1 バイトも起こさずに済む素材の数。 */
  mutedAssets: number;
  /** 丸ごと ÷ 範囲（何分の 1 になるか）。 */
  ratio: number;
}

/**
 * 「丸ごと起こす」と「範囲だけ起こす」を**時計を使わずに**並べる。
 *
 * 丸ごとの側は `summarizeAudioCost` と同じ数え方（48kHz 2ch として数える。
 * 起こした素材が何 Hz でも最後はミックスの形に化けるので、**上振れ側の見積もり**）。
 */
export function summarizeRangeCost(sequence: LabAudioSequence, options: DecodePlanOptions = {}): RangeCostStats {
  const plans = planAssetDecodes(sequence, options);

  // 丸ごとの側は、本体と同じく**消したクリップの素材も数える**（起こしてから落とすので）。
  const wholeAssets = new Map<string, number>();
  for (const clip of sequence.clips) {
    if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
    if (!wholeAssets.has(clip.mediaId)) wholeAssets.set(clip.mediaId, clip.assetDuration);
  }
  const wholeSeconds = [...wholeAssets.values()].reduce((a, b) => a + b, 0);
  const rangeSeconds = plans.reduce((a, p) => a + p.seconds, 0);
  const readSeconds = plans.reduce((a, p) => a + p.reads.reduce((n, r) => n + (r.to - r.from), 0), 0);

  const wholeBytes = Math.ceil(wholeSeconds * SAMPLE_RATE) * CHANNELS * BYTES_PER_SAMPLE;
  const rangeBytes = plans.reduce(
    (a, p) => a + p.ranges.reduce((n, r) => n + Math.ceil((r.to - r.from) * SAMPLE_RATE) * CHANNELS * BYTES_PER_SAMPLE, 0),
    0,
  );

  return {
    wholeSeconds,
    wholeBytes,
    rangeSeconds,
    rangeBytes,
    parts: plans.reduce((a, p) => a + p.ranges.length, 0),
    readSeconds,
    assets: wholeAssets.size,
    wholeAssets: plans.filter((p) => p.whole).length,
    mutedAssets: wholeAssets.size - plans.length,
    ratio: rangeBytes > 0 ? wholeBytes / rangeBytes : 0,
  };
}

/**
 * **ジェットカットしたあとの形**のタイムライン。範囲だけ起こす形を潰すための素材。
 *
 * `splitAudioSequence` は素材の中を順に隙間なく使うので、区間を畳むと 1 本になり、
 * 「範囲だけ起こす」がいちばん得をする形しか作れない。実際に本体が作るのはその逆で、
 * **無音カットは 1 本の長い素材から短い山を大量に拾う**（`auto-cut` の出力がそれ）。
 * 区間が散れば散るほど、のりしろの取り分と頭出しの回数が増える。
 *
 * `keepRatio` が残す割合、`takeSeconds` が 1 山の長さ。
 * 隙間は残す割合から決まる（残す 0.5 なら山と同じ長さの隙間）。
 */
export function jetCutSequence({
  mediaId = 'asset',
  assetSeconds = 600,
  takeSeconds = 2,
  keepRatio = 0.5,
  fade = 0.1,
  volume = 0.8,
  speed = 1,
  mutedMediaId,
}: {
  mediaId?: string;
  assetSeconds?: number;
  takeSeconds?: number;
  keepRatio?: number;
  fade?: number;
  volume?: number;
  speed?: number;
  /** 「消したクリップだけが使っている素材」を 1 つ足す（丸ごとの側だけが起こす形）。 */
  mutedMediaId?: string;
} = {}): LabAudioSequence {
  if (!(takeSeconds > 0)) throw new Error(`takeSeconds は正の数です（${takeSeconds}）`);
  if (!(keepRatio > 0 && keepRatio <= 1)) throw new Error(`keepRatio は 0 より大きく 1 以下です（${keepRatio}）`);
  if (!(speed > 0)) throw new Error(`speed は正の数です（${speed}）`);
  const stride = takeSeconds / keepRatio;
  const clips: LabAudioClip[] = [];
  let at = 0;
  for (let i = 0; ; i += 1) {
    const sourceIn = i * stride;
    if (sourceIn + takeSeconds * speed > assetSeconds) break;
    clips.push({
      id: `take-${i}`,
      mediaId,
      kind: 'video',
      start: at,
      duration: takeSeconds,
      sourceIn,
      assetDuration: assetSeconds,
      speed,
      volume,
      fadeIn: fade,
      fadeOut: fade,
    });
    at += takeSeconds;
  }
  if (mutedMediaId) {
    clips.push({
      id: 'muted',
      mediaId: mutedMediaId,
      kind: 'audio',
      start: 0,
      duration: Math.max(takeSeconds, at),
      sourceIn: 0,
      assetDuration: assetSeconds,
      volume: 1,
      muted: true,
    });
  }
  return { clips, duration: at };
}
