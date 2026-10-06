/**
 * コマを「くらべられる小さな形」に直す。
 *
 * ここには**判断を置かない**。どの量がカットを見分けるかは probe で測ってから決めるので、
 * この段では素直に「測れるもの」だけを並べてある。
 *
 * 入口は `ImageData` と同じ形（RGBA の並び）にしてある。本物の動画では
 * デコードしたコマを小さな canvas へ描いて `getImageData()` を取る、という経路になるが、
 * **ここから先は canvas も DOM も要らない**ので Node のまま測れる。
 */

/** `ImageData` と同じ形。canvas を持ち込まないために最小限だけを要求する。 */
export interface FrameLike {
  width: number;
  height: number;
  /** RGBA が 1 画素 4 バイトで並んだもの。 */
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * 解析に使う格子の大きさ。
 *
 * 小さくするのは速さのためだけではない。**手ぶれや粒ノイズを先に均して落とす**ためで、
 * 元の大きさのまま引き算すると、1 画素ずれただけで輪郭が丸ごと差として出る。
 * 16:9 に合わせて 32×18。縦型素材でも同じ数の升目になるよう、縦横は別々に潰す。
 */
export const GRID_W = 32;
export const GRID_H = 18;

/** 明るさのヒストグラムの段数。 */
export const LUMA_BINS = 32;
/** 色のヒストグラムは RGB を 4 段ずつ。64 個の箱になる。 */
export const RGB_BINS = 4;

export interface FrameStat {
  /** 素材の頭からの秒数。 */
  time: number;
  /** 縮小した明るさ（0〜1）。長さは GRID_W * GRID_H。 */
  grid: Float64Array;
  /** 画面ぜんたいの明るさ（0〜1）。 */
  meanLuma: number;
  /** 明るさのヒストグラム（合計 1）。 */
  lumaHist: Float64Array;
  /** 色のヒストグラム（合計 1）。 */
  rgbHist: Float64Array;
}

/** Rec.709 の明るさ。人の目の感じ方に寄せた重みで、映像の側の慣例に合わせる。 */
function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * コマ 1 枚を測る。
 *
 * 縮小は「いちばん近い画素を拾う」ではなく**升目の中を平均する**。
 * 拾う形だと、拾った 1 点がノイズだったときにその升目が丸ごと嘘になる。
 */
export function summarizeFrame(frame: FrameLike, time: number): FrameStat {
  const { width, height, data } = frame;
  if (width <= 0 || height <= 0) {
    return {
      time,
      grid: new Float64Array(GRID_W * GRID_H),
      meanLuma: 0,
      lumaHist: new Float64Array(LUMA_BINS),
      rgbHist: new Float64Array(RGB_BINS ** 3),
    };
  }

  const grid = new Float64Array(GRID_W * GRID_H);
  const counts = new Float64Array(GRID_W * GRID_H);
  const lumaHist = new Float64Array(LUMA_BINS);
  const rgbHist = new Float64Array(RGB_BINS ** 3);
  let sum = 0;

  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / height));
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const l = luma(r, g, b);

      const gx = Math.min(GRID_W - 1, Math.floor((x * GRID_W) / width));
      const cell = gy * GRID_W + gx;
      grid[cell] += l;
      counts[cell] += 1;
      sum += l;

      lumaHist[Math.min(LUMA_BINS - 1, Math.floor(l * LUMA_BINS))] += 1;
      const ri = Math.min(RGB_BINS - 1, (r * RGB_BINS) >> 8);
      const gi = Math.min(RGB_BINS - 1, (g * RGB_BINS) >> 8);
      const bi = Math.min(RGB_BINS - 1, (b * RGB_BINS) >> 8);
      rgbHist[(ri * RGB_BINS + gi) * RGB_BINS + bi] += 1;
    }
  }

  for (let i = 0; i < grid.length; i += 1) if (counts[i] > 0) grid[i] /= counts[i];
  const pixels = width * height;
  for (let i = 0; i < lumaHist.length; i += 1) lumaHist[i] /= pixels;
  for (let i = 0; i < rgbHist.length; i += 1) rgbHist[i] /= pixels;

  return { time, grid, meanLuma: sum / pixels, lumaHist, rgbHist };
}

/** 素材ぜんたいを測る。 */
export function summarizeFrames(frames: FrameLike[], times: ArrayLike<number>): FrameStat[] {
  const out: FrameStat[] = [];
  for (let i = 0; i < frames.length; i += 1) out.push(summarizeFrame(frames[i], times[i] ?? i));
  return out;
}

/** 升目ごとの明るさの差（平均絶対差、0〜1）。「画面のどれだけが塗り変わったか」に近い。 */
export function gridDistance(a: FrameStat, b: FrameStat): number {
  let sum = 0;
  for (let i = 0; i < a.grid.length; i += 1) sum += Math.abs(a.grid[i] - b.grid[i]);
  return sum / a.grid.length;
}

/** 升目のうち、はっきり変わったものの割合（0〜1）。 */
export function changedCellRatio(a: FrameStat, b: FrameStat, cellThreshold = 0.08): number {
  let n = 0;
  for (let i = 0; i < a.grid.length; i += 1) if (Math.abs(a.grid[i] - b.grid[i]) >= cellThreshold) n += 1;
  return n / a.grid.length;
}

/** 画面ぜんたいの明るさの差（0〜1）。いちばん素朴な量。 */
export function meanLumaDistance(a: FrameStat, b: FrameStat): number {
  return Math.abs(a.meanLuma - b.meanLuma);
}

/** ヒストグラムどうしの隔たり（L1 の半分。0 で同じ、1 で重なりなし）。 */
function histDistance(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / 2;
}

/** 明るさの分布の隔たり。**画面の中で物が動いても分布は動かない**ので、パンに強いはず。 */
export function lumaHistDistance(a: FrameStat, b: FrameStat): number {
  return histDistance(a.lumaHist, b.lumaHist);
}

/** 色の分布の隔たり。 */
export function rgbHistDistance(a: FrameStat, b: FrameStat): number {
  return histDistance(a.rgbHist, b.rgbHist);
}

/**
 * 明るさの分布と色の分布の、**大きいほう**。
 *
 * 2 つを足したり掛けたりせず大きいほうを取っているのは、片方が 0 の場合があるため。
 * 明るさを変えずに色だけ変わるカットでは `lumaHist` が原理的に 0 しか返せず、
 * 逆に黒へ落ちるフェードでは `rgbHist` の山が黒の縁からずれる（渡りの途中で最大になる）。
 * **どちらも「見えないときは 0 に近い」側の外し方**なので、大きいほうを取れば拾える。
 *
 * 足し算や平均にしないのは、**見えているほうの値を見えないほうが薄めてしまう**から。
 * 大きいほうを取る形なら、誤検出の上限も 2 つの上限の大きいほうを超えない
 * （12 本の実測で 0.035 と 0.033）ので、線の余裕を減らさずに取りこぼしだけを減らせる。
 */
export function combinedHistDistance(a: FrameStat, b: FrameStat): number {
  return Math.max(lumaHistDistance(a, b), rgbHistDistance(a, b));
}

/** 測れる量の一覧。probe と selftest から同じものを引くために置いてある。 */
export const DISTANCES: Record<string, (a: FrameStat, b: FrameStat) => number> = {
  meanLuma: meanLumaDistance,
  grid: gridDistance,
  changed: changedCellRatio,
  lumaHist: lumaHistDistance,
  rgbHist: rgbHistDistance,
  combined: combinedHistDistance,
};
