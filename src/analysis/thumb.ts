/**
 * コマ 1 枚を「表紙に使えるか」の向きから測る。
 *
 * シーン検出の `frames.ts` と同じで、**ここには判断を置かない**。
 * どの量がボケや黒つぶれを見分けるかは probe で測ってから決めるので、
 * この段では素直に「測れるもの」だけを並べてある。
 *
 * 入口は `ImageData` と同じ形（RGBA の並び）。canvas も DOM も要らないので、
 * Node のまま測れる。
 */

/** `ImageData` と同じ形。canvas を持ち込まないために最小限だけを要求する。 */
export interface FrameLike {
  width: number;
  height: number;
  /** RGBA が 1 画素 4 バイトで並んだもの。 */
  data: Uint8ClampedArray | Uint8Array;
}

/** 黒つぶれ・白飛びと見なす明るさ（0〜1）。8bit で言えば下 5 段・上 5 段ぶん。 */
export const CLIP_LOW = 0.02;
export const CLIP_HIGH = 0.98;

/**
 * 細かさを升目ごとに数えるときの格子。
 *
 * シーン検出（32×18）より粗い 8×8 にしてあるのは、見たいものが違うため。
 * あちらは「画面のどこが塗り変わったか」で、こちらは
 * **「細かい所が画面の一部にしか無いのか、ぜんたいに散っているのか」**。
 * 升目が細かすぎると、升目 1 つが輪郭 1 本で埋まって散らばり方が見えなくなる。
 */
export const DETAIL_W = 8;
export const DETAIL_H = 8;

export interface ThumbStat {
  /** 素材の頭からの秒数。 */
  time: number;
  /** 画面ぜんたいの明るさ（0〜1）。 */
  meanLuma: number;
  /** 明るさのばらつき（標準偏差、0〜1）。低いと「のっぺり」。 */
  contrast: number;
  /** 黒つぶれ・白飛びした画素の割合（0〜1）。 */
  clipped: number;
  /** 隣り合う画素の差の平均（0〜1）。いちばん素朴な「細かさ」。 */
  grad: number;
  /** 2×2 に均してから測った細かさ。粒ノイズは半分に、輪郭はそのまま残る。 */
  gradDown: number;
  /** 粒ノイズの見積り（標準偏差、0〜1）。中央値で取るので輪郭に引きずられにくい。 */
  noise: number;
  /** 粒の見積りぶんを引いた細かさ。 */
  gradNet: number;
  /** 細かさを明暗の幅で割ったもの。暗い素材でも比べられるはず。 */
  gradNorm: number;
  /** 粒を引いた細かさを明暗の幅で割ったもの。 */
  gradNetNorm: number;
  /** 均してから測った細かさ ÷ そのままの細かさ。**細かい側が先に消える**ので、ボケると上がる。 */
  scaleRatio: number;
  /** 升目のうち、細かさが立っているものの割合（0〜1）。 */
  detail: number;
  /**
   * 升目ごとの細かさ（`DETAIL_W × DETAIL_H`）。
   *
   * 画面ぜんたいの平均だけだと、**いつも鮮明な一部**（焼き込みの文字帯）が
   * 中身のボケを覆い隠す。升目ごとに持っておけば、呼ぶ側が
   * 「どの升目で比べるか」を選べる。
   */
  cells: Float64Array;
  /** 色の豊かさ（Hasler–Süsstrunk、0〜1 くらい）。 */
  colorfulness: number;
}

/** Rec.709 の明るさ。シーン検出と同じ重みを使う。 */
function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 中央値。並べ替えるので、渡した配列は壊れる。 */
function median(values: Float64Array, count: number): number {
  if (count <= 0) return 0;
  const view = values.subarray(0, count);
  view.sort();
  const half = count >> 1;
  return count % 2 ? view[half] : (view[half - 1] + view[half]) / 2;
}

/** 空のコマ（大きさが 0）のときに返す値。0 を並べると「真っ黒で平坦」と同じ顔になるので、注記しておく。 */
function emptyStat(time: number): ThumbStat {
  return {
    time,
    meanLuma: 0,
    contrast: 0,
    clipped: 1,
    grad: 0,
    gradDown: 0,
    noise: 0,
    gradNet: 0,
    gradNorm: 0,
    gradNetNorm: 0,
    scaleRatio: 1,
    detail: 0,
    cells: new Float64Array(DETAIL_W * DETAIL_H),
    colorfulness: 0,
  };
}

/**
 * コマ 1 枚を測る。
 *
 * 粒ノイズの見積りに**中央値**を使っているのは、平均だと輪郭に引きずられるため。
 * 2 階差分（`L[x-1] - 2L[x] + L[x+1]`）は、なめらかな所では 0 のまわりに散り、
 * 輪郭の上でだけ大きく跳ねる。画面の多くはなめらかなので、中央値を取れば
 * **跳ねた所を無視して粒の大きさだけが残る**。
 * 白色雑音に対する 2 階差分の分散は σ²×6 なので、そのぶん割り戻す
 * （0.6745 は標準正規の中央絶対偏差）。
 */
export function summarizeThumb(frame: FrameLike, time: number): ThumbStat {
  const { width, height, data } = frame;
  if (width <= 0 || height <= 0) return emptyStat(time);

  const pixels = width * height;
  const lum = new Float64Array(pixels);
  let sum = 0;
  let sumSq = 0;
  let clipped = 0;
  let sumRg = 0;
  let sumYb = 0;
  let sumRgSq = 0;
  let sumYbSq = 0;

  for (let i = 0; i < pixels; i += 1) {
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const l = luma(r, g, b);
    lum[i] = l;
    sum += l;
    sumSq += l * l;
    if (l <= CLIP_LOW || l >= CLIP_HIGH) clipped += 1;

    // 色の豊かさ（Hasler–Süsstrunk）。赤緑と黄青の 2 軸の散らばりで測る。
    const rg = (r - g) / 255;
    const yb = (0.5 * (r + g) - b) / 255;
    sumRg += rg;
    sumYb += yb;
    sumRgSq += rg * rg;
    sumYbSq += yb * yb;
  }

  const meanLuma = sum / pixels;
  const contrast = Math.sqrt(Math.max(0, sumSq / pixels - meanLuma * meanLuma));

  const meanRg = sumRg / pixels;
  const meanYb = sumYb / pixels;
  const varRg = Math.max(0, sumRgSq / pixels - meanRg * meanRg);
  const varYb = Math.max(0, sumYbSq / pixels - meanYb * meanYb);
  const colorfulness = Math.sqrt(varRg + varYb) + 0.3 * Math.sqrt(meanRg * meanRg + meanYb * meanYb);

  // --- 細かさ（隣り合う画素の差） ---
  let gradSum = 0;
  let gradCount = 0;
  const detailCells = new Float64Array(DETAIL_W * DETAIL_H);
  const detailCounts = new Float64Array(DETAIL_W * DETAIL_H);
  for (let y = 0; y < height; y += 1) {
    const cy = Math.min(DETAIL_H - 1, Math.floor((y * DETAIL_H) / height));
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let d = 0;
      let n = 0;
      if (x + 1 < width) {
        d += Math.abs(lum[i + 1] - lum[i]);
        n += 1;
      }
      if (y + 1 < height) {
        d += Math.abs(lum[i + width] - lum[i]);
        n += 1;
      }
      if (n === 0) continue;
      const v = d / n;
      gradSum += v;
      gradCount += 1;
      const cx = Math.min(DETAIL_W - 1, Math.floor((x * DETAIL_W) / width));
      const cell = cy * DETAIL_W + cx;
      detailCells[cell] += v;
      detailCounts[cell] += 1;
    }
  }
  const grad = gradCount > 0 ? gradSum / gradCount : 0;

  // --- 2×2 に均してから測った細かさ ---
  //
  // 粒は隣どうし無相関なので、4 画素を均すと半分になる。輪郭は均しても残る。
  // **同じ量を 2 つの粗さで測って並べる**ことで、細かさの中身を分ける手がかりにする。
  const dw = Math.max(1, width >> 1);
  const dh = Math.max(1, height >> 1);
  const down = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      let acc = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const sx = x0 + dx;
          const sy = y0 + dy;
          if (sx >= width || sy >= height) continue;
          acc += lum[sy * width + sx];
          n += 1;
        }
      }
      down[y * dw + x] = n > 0 ? acc / n : 0;
    }
  }
  let downSum = 0;
  let downCount = 0;
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const i = y * dw + x;
      let d = 0;
      let n = 0;
      if (x + 1 < dw) {
        d += Math.abs(down[i + 1] - down[i]);
        n += 1;
      }
      if (y + 1 < dh) {
        d += Math.abs(down[i + dw] - down[i]);
        n += 1;
      }
      if (n === 0) continue;
      downSum += d / n;
      downCount += 1;
    }
  }
  const gradDown = downCount > 0 ? downSum / downCount : 0;

  // --- 粒ノイズの見積り（2 階差分の中央値） ---
  let noise = 0;
  if (width >= 3) {
    const seconds = new Float64Array((width - 2) * height);
    let k = 0;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 1; x < width - 1; x += 1) {
        seconds[k] = Math.abs(lum[row + x - 1] - 2 * lum[row + x] + lum[row + x + 1]);
        k += 1;
      }
    }
    noise = median(seconds, k) / (0.6745 * Math.sqrt(6));
  }

  // 白色雑音が隣どうしの差に足す量は平均 2σ/√π。そのぶんを引いて「粒でない細かさ」を見る。
  const noiseGrad = noise * 2 * Math.sqrt(1 / Math.PI);
  const gradNet = Math.max(0, grad - noiseGrad);

  // 升目ごとの細かさ。線は「粒の見積りの 2 倍」に取る（粒しか無い升目を数えないため）。
  const detailLine = Math.max(0.01, noiseGrad * 2);
  let lively = 0;
  const cells = new Float64Array(detailCells.length);
  for (let i = 0; i < detailCells.length; i += 1) {
    cells[i] = detailCounts[i] > 0 ? detailCells[i] / detailCounts[i] : 0;
    if (cells[i] >= detailLine) lively += 1;
  }

  const eps = 1e-6;
  return {
    time,
    meanLuma,
    contrast,
    clipped: clipped / pixels,
    grad,
    gradDown,
    noise,
    gradNet,
    gradNorm: grad / (contrast + eps),
    gradNetNorm: gradNet / (contrast + eps),
    scaleRatio: gradDown / (grad + eps),
    detail: lively / detailCells.length,
    cells,
    colorfulness,
  };
}

/** 素材ぜんたいを測る。 */
export function summarizeThumbs(frames: FrameLike[], times: ArrayLike<number>): ThumbStat[] {
  const out: ThumbStat[] = [];
  for (let i = 0; i < frames.length; i += 1) out.push(summarizeThumb(frames[i], times[i] ?? i));
  return out;
}

/** 測れる量の一覧。probe と selftest から同じものを引くために置いてある。 */
export const THUMB_METRICS: Record<string, (s: ThumbStat) => number> = {
  meanLuma: (s) => s.meanLuma,
  contrast: (s) => s.contrast,
  clipped: (s) => s.clipped,
  grad: (s) => s.grad,
  gradDown: (s) => s.gradDown,
  noise: (s) => s.noise,
  gradNet: (s) => s.gradNet,
  gradNorm: (s) => s.gradNorm,
  gradNetNorm: (s) => s.gradNetNorm,
  scaleRatio: (s) => s.scaleRatio,
  detail: (s) => s.detail,
  colorfulness: (s) => s.colorfulness,
};
