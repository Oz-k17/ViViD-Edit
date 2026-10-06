/**
 * 選んだ秒のコマを、**素材の大きさのまま**取り出して絵のファイルにする。
 *
 * ここには判断を置かない。`scene-cut/src/decode.ts` と同じ立場の部品で、
 * 違うのは「測るために読む」のではなく「**出すために読む**」ことだけ。
 *
 * ## なぜ読み込みをもう一度やるのか（この画面を作って初めて出てきた話）
 *
 * 判定のための読み込み（`decode.ts`）は、コマを**長辺 128 画素へ縮めて**読む。
 * 分布しか見ないので、それで足りるし、そのほうが速いからだ。
 * ところが表紙は**人が見る絵**なので、128 画素では使い物にならない。
 * つまり「測るコマ」と「書き出すコマ」は、そもそも別物だった。
 *
 * 全コマを大きいまま持つ手は取らない。13 秒・195 コマを 1920×1080 の RGBA で持つと
 * 1.6GB になる。**選んだ数枚だけを、選んでから読み直す**ほうが素直で、
 * 3 枚なら 3 回のシークで済む（リミッタを長尺へ当てるときと同じで、
 * 要るのは「全部を持たない形」のほう）。
 *
 * ## 秒はずれないのか
 *
 * ずれない。`decode.ts` は `i / fps` の秒を読み、`canvasesAtTimestamps` は
 * **その秒かその手前のコマ**を返す。ここでも同じ秒を同じ関数へ渡すので、
 * 返ってくるのは同じ素材のコマになる。ここが食い違うと
 * 「選んだ絵」と「出てきた絵」が別物になるので、`uitest.mjs` で
 * 書き出した絵と測ったコマの分布を突き合わせて確かめている。
 */

import type { FrameLike } from './frames.ts';

/**
 * 書き出す絵の長辺の上限（画素）。
 *
 * 表紙の置き場（配信サイトの一覧）が求めるのはせいぜい 1280×720 なので、
 * 4K 素材をそのまま出しても行き先が無い。**上限が無いと、
 * 選んだ枚数ぶんだけ素材の解像度で RGBA を持つ**ことになるのが本当の理由で、
 * 4K なら 1 枚 33MB。素材がこれより小さければ拡大はしない（無い細かさは作れない）。
 */
export const EXPORT_LONG_SIDE = 1920;

export interface ExportedFrame extends FrameLike {
  time: number;
  /** 素材そのものの大きさ（上限で縮めたかどうかを読むため）。 */
  sourceWidth: number;
  sourceHeight: number;
}

/** 長辺を上限まで縮めた大きさ。**素材より大きくはしない。** */
export function exportSize(
  width: number,
  height: number,
  longSide: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 秒の列を渡して、その秒のコマを素材の大きさで取り出す。
 *
 * 秒は**昇順で渡すこと**。`canvasesAtTimestamps` は前へ戻らない作りなので、
 * 順番が入れ替わっていると取れないコマが出る。選んだ候補は時間順に返るので、
 * ふつうに渡せばそうなっているが、呼ぶ側の都合で並べ替えたときのために並べ直す。
 */
export async function decodeFramesAt(
  file: Blob,
  times: number[],
  { longSide = EXPORT_LONG_SIDE }: { longSide?: number } = {},
): Promise<(ExportedFrame | null)[]> {
  if (!times.length) return [];
  const { BlobSource, CanvasSink, Input, MATROSKA, MP4, QTFF, WEBM } = await import('mediabunny');

  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, MATROSKA, WEBM] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('この素材に映像トラックがありません');

    const sourceWidth = track.displayWidth;
    const sourceHeight = track.displayHeight;
    const size = exportSize(sourceWidth, sourceHeight, longSide);

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('キャンバスを初期化できませんでした');

    // 渡された順を覚えたまま昇順で読む（返すのは渡された順）。
    const order = times.map((time, i) => ({ time, i })).sort((a, b) => a.time - b.time);
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: 'fill' });
    const out: (ExportedFrame | null)[] = times.map(() => null);
    let k = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(order.map((o) => o.time))) {
      const slot = order[k];
      k += 1;
      if (!wrapped || !slot) continue;
      ctx.drawImage(wrapped.canvas as CanvasImageSource, 0, 0, size.width, size.height);
      const image = ctx.getImageData(0, 0, size.width, size.height);
      out[slot.i] = {
        time: slot.time,
        width: image.width,
        height: image.height,
        data: image.data,
        sourceWidth,
        sourceHeight,
      };
    }
    // 返ってこなかった秒は**黙って詰めない**。渡した秒と同じ長さのまま、
    // 取れなかった所を `null` で返す。詰めて返すと、呼ぶ側が i 番目を i 番目の候補だと
    // 思って割り当てるので、**1 枚欠けただけで以降が丸ごと 1 つずれる**
    // （絵は出るし大きさも合うので、ずれたことは数字のどこにも出ない）。
    return out;
  } finally {
    // 開いたら必ず閉じる（同時に持てるデコーダの数は端末ごとに決まっている）。
    input.dispose();
  }
}

/**
 * 書き出せる形式。**中身は `npm run lab:thumb:format` で測って決めた**（2026-09-23・3 回目）。
 *
 * ここに 9/23（2 回目）までは「表紙は文字や線が乗る前提なので、非可逆では出さない」と
 * 書いてあった。**測ったら、そうではなかった。** 焼き込みの文字帯を持つ素材
 * （`whip-captions`・画面の 26%）で帯の中と外を分けて測ると、品質 0.85 以上では
 * **帯の中のほうが帯の外より誤差が小さい**（0.90 で 0.36 対 0.58 / 255）。
 * 平らな板に硬い縁という形は 8×8 の升目とよく噛み合うので、非可逆が苦手な相手ではない。
 * 帯が外より荒れるのは品質 0.70 以下だけで、そこはもう誰も使わない領域だった。
 *
 * 既定を PNG のままにしてあるのは**文字のためではなく、置き先が決まっていないから**。
 * 可逆なら、書き出した絵を測り直したときに選んだときの点とそのまま比べられる。
 * 置き先（配信サイトの一覧）が決まれば JPEG へ寄せてよい——そのための札がこれ。
 */
export const EXPORT_FORMATS = {
  png: { type: 'image/png', ext: 'png', lossy: false, label: 'PNG（可逆・大きい）' },
  jpeg: { type: 'image/jpeg', ext: 'jpg', lossy: true, label: 'JPEG（非可逆・1 割の大きさ）' },
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;

/** 既定の形式。上の注のとおり、置き先が決まっていないので可逆のまま。 */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'png';

/**
 * JPEG の既定の品質。測って決めた（`format-probe.mjs`）。
 *
 * 実寸（1920×1080）で **PNG の 9〜13%**（103〜129KB 対 852〜1476KB）まで落ちて、
 * 明るさの食い違いは **0.53〜0.59 / 255 ＝ 0.2%**。ここから品質を上げても、
 * 大きさだけが増えて誤差はほとんど動かない（0.95 で 1.6 倍・誤差は 0.07 しか縮まない）。
 */
export const DEFAULT_JPEG_QUALITY = 0.9;

/**
 * JPEG の品質の上限。**1.0 を選ばせない。**
 *
 * 測ると 1.0 は 0.95 の **3〜4 倍**の大きさになるのに、誤差は 0.1 / 255 しか縮まない。
 * しかも**細かさへの粗はそこでいちばん大きい**（足す量 +0.00036。0.90 では +0.0001 前後）。
 * 量子化が粗を丸めてくれなくなるぶん、画素ごとの丸め誤差がそのまま残るためで、
 * **「いちばん高い品質がいちばん元に近い」が、この量では成り立たない。**
 * 上限を 0.95 に置いて、押せない所へ寄せてある。
 */
export const JPEG_QUALITY_MAX = 0.95;
export const JPEG_QUALITY_MIN = 0.5;

/** 品質を使える範囲へ収める。**範囲の外を黙って通さない**（上の注の 1.0 がそれ）。 */
export function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return DEFAULT_JPEG_QUALITY;
  return Math.min(JPEG_QUALITY_MAX, Math.max(JPEG_QUALITY_MIN, quality));
}

/**
 * コマ 1 枚を絵のファイルにする。
 *
 * **非可逆は細かさを削らない。足す。** これも測って分かったことで、
 * JPEG を通した絵の細かさ（`grad`）は元のコマより必ず大きくなる（素材 4 本・品質 7 通りで
 * 例外なし）。表紙を選ぶ根拠が書き出しで消える心配をしていたが、向きは逆だった。
 * 足す量は**絶対値でほぼ一定**（品質 1.0 でどの素材も +0.00036）なので、
 * 元が滑らかな素材ほど比が大きく出る——**比だけを見ると素材の話を形式の話と読み違える。**
 */
export async function frameToImage(
  frame: FrameLike,
  { format = DEFAULT_EXPORT_FORMAT, quality = DEFAULT_JPEG_QUALITY }: { format?: ExportFormat; quality?: number } = {},
): Promise<Blob> {
  const spec = EXPORT_FORMATS[format] ?? EXPORT_FORMATS[DEFAULT_EXPORT_FORMAT];
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`${spec.ext} で書き出せませんでした`))),
      spec.type,
      // PNG に品質を渡しても無視されるが、**渡さない**ほうがよい。
      // 渡すと「PNG にも品質のつまみがある」と読まれる。
      spec.lossy ? clampQuality(quality) : undefined,
    );
  });
}

/** コマ 1 枚を PNG にする（`frameToImage` の既定そのもの）。 */
export async function frameToPng(frame: FrameLike): Promise<Blob> {
  return frameToImage(frame, { format: 'png' });
}

// 保存は本体の `saveBlob`（`src/engine/exporter.ts`）を使う。ラボにあった同名の関数は持ってこなかった
// （書き出しの保存が 2 通りになると、片方だけ端末の癖に対応して片方が壊れる）。

/**
 * 書き出す絵の名前。**秒を名前に入れる**。
 *
 * 3 枚まとめて落とすと、名前が同じだと `(1)` `(2)` が付いて
 * どれがどの秒か分からなくなる。素材の名前も残しておけば、
 * 別の素材の候補と同じフォルダへ落としても混ざらない。
 *
 * 拡張子は**形式から引く**。ここを固定で `.png` と書いておくと、
 * JPEG の中身に `.png` の名前が付いて落ちる——開けはするが、
 * 受け取る側が拡張子で弾く所（配信サイトの一覧）では黙って蹴られる。
 */
export function exportName(source: string, time: number, format: ExportFormat = DEFAULT_EXPORT_FORMAT): string {
  const base = source.replace(/\.[^.]+$/, '').replace(/[^\w\-一-龠ぁ-んァ-ヶ]+/g, '_') || 'thumb';
  const spec = EXPORT_FORMATS[format] ?? EXPORT_FORMATS[DEFAULT_EXPORT_FORMAT];
  return `${base}_${time.toFixed(2).replace('.', 'p')}s.${spec.ext}`;
}
