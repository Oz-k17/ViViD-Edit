/**
 * 本物の動画から、シーン検出が食べられる形（`FrameLike` の列）を取り出す。
 *
 * ここには**判断を置かない**。`frames.ts` と同じ立場の部品で、
 * 違うのは「ブラウザでしか動かない」ことだけ（WebCodecs と canvas に触る）。
 * 判定の側（`frames.ts` / `scene.ts`）はここに依存していないので、
 * コマンドラインの測定はこれまでどおりブラウザ無しで回る。
 *
 * ## なぜ「素材のコマの速さ」で読まないのか（2026-09-22・2 回目に測って決めた）
 *
 * 素直に作ると「動画のコマを全部渡す」になる。ところが**既定のつまみは
 * 15fps の素材で決めてある**ので、30fps や 60fps の動画をそのまま渡すと意味が変わる。
 * 同じ素材をコマの速さだけ変えて測ると、こうなる（`combined` の最大・`LAB_FPS`）:
 *
 * | 素材 | 10fps | 15fps | 30fps | 60fps |
 * | --- | --- | --- | --- | --- |
 * | `cuts-plain`（瞬間のカット） | 0.976 | 0.976 | 0.976 | 0.976 |
 * | `dissolve`（1 秒かけて渡る） | 0.303 | 0.243 | **0.149** | **0.086** |
 *
 * **瞬間の切り替わりは速さで 1 ミリも動かず、渡りだけが薄まる。** 渡りは
 * 「1 秒かけて起きること」なので、コマを細かく刻むほど 1 コマぶんの差が小さくなる。
 * 実際 60fps で測るとディゾルブは既定の線 0.10 を割り、**丸ごと見逃す**
 * （見つけた率 91.8% → 93.9% だが、その中でディゾルブだけが 1 本 → 0 本）。
 *
 * **距離を「秒あたり」に直す手は使えない。** 割り算で直すと、今度は
 * 速さで動かないほう（瞬間のカット）が速さに比例して動きだす。
 * 2 つの量が逆向きなので、**割り算では両方を同時に固定できない。**
 * 固定できるのは測る速さのほうだけなので、ここで `ANALYSIS_FPS` へ揃えてから渡す。
 *
 * 素材がそれより遅いときは素材の速さに合わせる（無い所を水増ししても、
 * 同じコマが並んで周りの中央値だけが下がり、その場と比べる線が甘くなる）。
 */

import type { FrameLike } from './frames.ts';

/**
 * 解析するコマの速さ（fps）。
 *
 * 既定のつまみを決めた素材（`lab/fixtures/scenes.mjs` の `SCENE_FPS`）と同じ値。
 * **ここを動かすと `straddleFrames` と `localWindow` の意味する秒数が変わる**ので、
 * 片方だけ動かさないこと。上の表がその実測。
 */
export const ANALYSIS_FPS = 15;

/**
 * 解析に使うコマの長辺（画素）。
 *
 * 素材（16:9 で 128×72、9:16 で 72×128）と揃えてある。ここを大きくしても、
 * `frames.ts` が 32×18 の格子とヒストグラムへ潰すので分布はほとんど変わらず、
 * デコードと `getImageData` の時間だけが伸びる。
 */
export const ANALYSIS_LONG_SIDE = 128;

/**
 * 読むコマ数の上限。
 *
 * 15fps なので 3000 コマ＝200 秒。1 コマ 128×72 の RGBA で 36KB あり、
 * 上限まで読むと 110MB になる。**尺の長い動画で黙って固まるより、
 * 途中で切って「切った」と言うほうがよい**ので、打ち切ったことを返り値に残す。
 */
export const MAX_ANALYSIS_FRAMES = 3000;

export interface DecodeOptions {
  /** 解析するコマの速さ。素材がこれより遅ければ素材に合わせる。 */
  fps: number;
  /** 解析するコマの長辺（画素）。 */
  longSide: number;
  /** 読むコマ数の上限。 */
  maxFrames: number;
  /**
   * 読む範囲（素材の頭からの秒）。省くと素材ぜんぶ。
   *
   * **本体で足した口**（ラボには無い）。本体のクリップは素材の一部しか使わないので、
   * ぜんぶ読むと、使わない所のデコードに時間を取られるうえ、
   * 長尺では `maxFrames` で打ち切られて**使う所が読まれない**。
   * 返す `times` は範囲の内側の秒で、**素材の頭からの秒のまま**（ずらさない）。
   */
  from?: number;
  to?: number;
  /** 進み具合（0〜1）。長い動画では数秒かかるので、黙って待たせない。 */
  onProgress?: (ratio: number) => void;
}

export const DEFAULT_DECODE: DecodeOptions = {
  fps: ANALYSIS_FPS,
  longSide: ANALYSIS_LONG_SIDE,
  maxFrames: MAX_ANALYSIS_FRAMES,
};

export interface DecodedClip {
  frames: FrameLike[];
  /** コマの時刻（秒）。`summarizeFrames` へそのまま渡せる。 */
  times: Float64Array;
  width: number;
  height: number;
  /** 素材のコマの速さ（測った値）。 */
  sourceFps: number;
  /** 実際に読んだ速さ。`min(fps, sourceFps)`。 */
  fps: number;
  /** 素材の尺（秒）。 */
  duration: number;
  /** 上限で打ち切ったか。 */
  truncated: boolean;
  /** コマが返ってこなかった回数（返らなかった所は 1 つ前のコマで埋めてある）。 */
  missing: number;
}

/**
 * 解析に使うコマの大きさを決める。**長辺を揃える**（幅を揃えるのではない）。
 *
 * 幅で揃えると、縦型（9:16）では 128×228 になって横型の 2.4 倍のコマになる。
 * 見ているのは分布なので大きさで結果は変わらないが、**時間だけが黙って伸びる。**
 */
export function analysisSize(
  displayWidth: number,
  displayHeight: number,
  longSide: number,
): { width: number; height: number } {
  if (!(displayWidth > 0) || !(displayHeight > 0)) return { width: longSide, height: longSide };
  const scale = longSide / Math.max(displayWidth, displayHeight);
  // 1 画素未満に潰れると canvas が作れない。潰れる向きは 1 で止める。
  return {
    width: Math.max(1, Math.round(displayWidth * scale)),
    height: Math.max(1, Math.round(displayHeight * scale)),
  };
}

/**
 * どの秒のコマを読むかを並べる。**コマの頭ではなく、真ん中を読む。**
 *
 * ## なぜ真ん中なのか（2026-09-25・2 回目に踏んで直した）
 *
 * `canvasesAtTimestamps` は「その時刻か、その手前のコマ」を返す。
 * 頭（`i / fps`）で読むと、**素材のコマの頭とこちらの時刻が同じ所に重なる**ので、
 * 少しでも手前へずれた瞬間に 1 つ前のコマが返る。
 *
 * そして**ずれる**。読む速さが素材より速いときは素材の速さに合わせる（下の `analysisFps`）が、
 * その素材の速さは**頭の 50 コマから見積もった値**で、ぴったりではない。
 * 15fps の素材が 15.0015fps と出ると、`i / 15.0015` は毎回コマの頭のわずか手前に落ちて、
 * **列ぜんたいが 1 コマ前へずれる。** 1 コマ（15fps で 67ms）ぶん遅れて測ることになり、
 * 自動リフレームの `subject-decoy` では入れた率が 97.5% → 92.6% と落ちた。
 *
 * 真ん中（`(i + 0.5) / fps`）で読めば、見積もりが**半コマぶん外れるまで**同じコマが返る。
 * ぴったりの速さで読むときに選ばれるコマは頭で読むのと 1 枚も変わらない
 * （0.5/fps はそのコマの中なので）ので、**直しても選び方は動かず、強さだけが増える。**
 *
 * 数は `round` で決める（`ceil` ではない）。真ん中を読むので、
 * **最後の半コマだけが残っているときに 1 枚足すと尺をはみ出す**。
 * これで「尺ちょうどには絵が無い」も自然に満たされる（最後は必ず尺の内側）。
 */
export function sampleTimes(duration: number, fps: number, maxFrames: number): Float64Array {
  if (!(duration > 0) || !(fps > 0) || !(maxFrames > 0)) return new Float64Array(0);
  const count = Math.min(maxFrames, Math.max(1, Math.round(duration * fps)));
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) out[i] = Math.min((i + 0.5) / fps, duration * (1 - 1e-9));
  return out;
}

/**
 * 読めたコマに貼る**時刻の札**を決める。
 *
 * **「いつ読むか」と「読めたコマがいつのものか」は別**（2026-09-25・2 回目）。
 * 読む時刻はコマの真ん中に置いてあるので、そのまま札にすると
 * **半コマぶん未来の札を貼ったコマ**になる。素材のコマは瞬間を写したものなので、
 * 札はそのコマ自身の時刻（`wrapped.timestamp`）でなければならない。
 *
 * ただし**前へ戻らせない**。同じコマが 2 回返ることがある
 * （速さの見積もりが素材より速いときや、コマが返らずに前のコマで埋めたとき）ので、
 * 札をそのまま並べると時刻が**止まる・戻る**。時刻の列は
 * 「その場と比べる窓」や「1 秒あたりの泳ぎ」の分母に使われるので、
 * ここが単調でないと、そこから先が静かにおかしくなる。
 *
 * 進めないときは**読もうとした時刻**を貼る。返るコマの時刻は必ず読む時刻以下で、
 * 読む時刻のほうは必ず増えていくので、これで必ず進む。
 */
export function frameTimes(requested: ArrayLike<number>, stamps: ArrayLike<number | null>): Float64Array {
  const out = new Float64Array(stamps.length);
  for (let i = 0; i < stamps.length; i += 1) {
    const stamp = stamps[i];
    const fallback = requested[i] ?? (i > 0 ? out[i - 1] : 0);
    const usable = typeof stamp === 'number' && Number.isFinite(stamp) && (i === 0 || stamp > out[i - 1]);
    out[i] = usable ? (stamp as number) : fallback;
  }
  return out;
}

/**
 * 素材の速さと、こちらの希望から、実際に読む速さを決める。
 *
 * **希望より遅い素材を水増ししない。** 10fps の動画を 15fps で読むと
 * 同じ絵が 2 枚並ぶコマができ、そこだけ距離 0 になる。距離 0 が混ざると
 * 周りの中央値が下がって、**その場と比べる線（`localRatio`）が甘くなる。**
 */
export function analysisFps(sourceFps: number, wanted: number): number {
  if (!(sourceFps > 0)) return wanted;
  return Math.min(wanted, sourceFps);
}

/**
 * 動画ファイル 1 本を、解析できるコマの列にする。
 *
 * mediabunny（WebCodecs）でデコードし、縮めた canvas から `getImageData()` を取る。
 * 読める入れ物は本体（`src/engine/formats.ts`）と同じ 4 つに絞ってある。
 * ここだけは本体と揃えないと、「本体では開けるのにラボでは開けない」が起きる。
 */
export async function decodeVideoFrames(
  file: Blob,
  options: Partial<DecodeOptions> = {},
): Promise<DecodedClip> {
  const o = { ...DEFAULT_DECODE, ...options };
  const { BlobSource, CanvasSink, Input, MATROSKA, MP4, QTFF, WEBM } = await import('mediabunny');

  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, MATROSKA, WEBM] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('この素材に映像トラックがありません');
    if (!(await track.canDecode())) throw new Error('この形式の映像は、このブラウザではデコードできません');

    const duration = await track.computeDuration();
    // 速さは頭のほうの数十コマから見積もる。全部読むと、読むかどうかを決めるために
    // 全部読むことになってしまう。
    const stats = await track.computePacketStats(50);
    const sourceFps = stats.averagePacketRate;
    const fps = analysisFps(sourceFps, o.fps);
    const size = analysisSize(track.displayWidth, track.displayHeight, o.longSide);
    const rangeFrom = Math.min(Math.max(0, o.from ?? 0), duration);
    const rangeTo = Math.min(duration, Math.max(rangeFrom, o.to ?? duration));
    const span = rangeTo - rangeFrom;
    const times = sampleTimes(span, fps, o.maxFrames).map((t) => t + rangeFrom);

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    // `willReadFrequently` を立てているのは、1 コマごとに `getImageData` を呼ぶため。
    // 立てないと GPU 側へ置かれ、読み戻すたびに同期を取ることになる。
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('キャンバスを初期化できませんでした');

    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: 'fill' });
    const frames: FrameLike[] = [];
    // 札の決め方は `frameTimes` に置いてある（そちらの注を参照）。
    const stamps: (number | null)[] = [];
    let missing = 0;
    let index = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (wrapped) {
        ctx.drawImage(wrapped.canvas as CanvasImageSource, 0, 0, size.width, size.height);
        const image = ctx.getImageData(0, 0, size.width, size.height);
        frames.push({ width: image.width, height: image.height, data: image.data });
        stamps.push(wrapped.timestamp);
      } else {
        // 返らなかった所は**前のコマで埋める**。詰めて並べると時刻とコマがずれ、
        // 見つけた秒が静かに前へ寄る。先頭で返らなかったときだけ真っ黒を置く。
        missing += 1;
        frames.push(frames[frames.length - 1] ?? blankFrame(size.width, size.height));
        stamps.push(null);
      }
      index += 1;
      if (o.onProgress && index % 15 === 0) o.onProgress(index / Math.max(1, times.length));
    }
    o.onProgress?.(1);

    return {
      frames,
      // 返ってきたコマが足りないことがある（尺の見積もりが甘い入れ物では起きる）。
      // 時刻の列は**実際に並んだコマの数**だけ持つ。ここを合わせないと
      // `summarizeFrames` が時刻を 0 で埋め、最後の場面が素材の頭へ飛ぶ。
      times: frameTimes(times, stamps),
      width: size.width,
      height: size.height,
      sourceFps,
      fps,
      duration,
      truncated: times.length >= o.maxFrames && span * fps > o.maxFrames,
      missing,
    };
  } finally {
    // デコーダは端末ごとに同時に持てる数が決まっている。開いたら必ず閉じる
    // （本体の `offline-export.ts` が踏んだ穴と同じ）。
    input.dispose();
  }
}

function blankFrame(width: number, height: number): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}
