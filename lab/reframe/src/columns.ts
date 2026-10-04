/**
 * コマを「**横の位置ごとの中身**」に直す。
 *
 * 自動リフレームが決めるのは**横のどこを切るか**だけなので、
 * 縦の情報は最初に畳んでしまってよい。コマ 1 枚が 32 個の列になるので、
 * 13 秒 × 15fps でも 6240 個の数で済む。
 *
 * ここには**判断を置かない**（`scene-cut/src/frames.ts` と同じ方針）。
 * どの手なら被写体を指せるかは probe で測ってから決めるので、
 * この段では「測れるもの」だけを並べる。
 *
 * 入口は `ImageData` と同じ形にしてあるので、**canvas も DOM も要らない**。
 */

/** `ImageData` と同じ形。canvas を持ち込まないために最小限だけを要求する。 */
export interface FrameLike {
  width: number;
  height: number;
  /** RGBA が 1 画素 4 バイトで並んだもの。 */
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * 列の数。`scene-cut` の格子（32×18）の横と同じにしてある。
 *
 * 細かくすれば位置は精しくなるが、**手ぶれと粒ノイズがそのぶん強く出る**。
 * 32 列なら 1 列が画面の 3.1% で、切り出す窓の幅（9:16 なら 31.6%）の 10 分の 1。
 * 枠を 3% 刻みで置ければ人の目には連続に見えるので、ここを細かくする理由が無い。
 */
export const COLUMNS = 32;

export interface ColumnStat {
  /** 素材の頭からの秒数。 */
  time: number;
  /** 列ごとの平均 RGB（0〜1）。長さは COLUMNS * 3。 */
  rgb: Float64Array;
  /** 列ごとの明るさ（0〜1）。長さは COLUMNS。 */
  luma: Float64Array;
}

/** Rec.709 の明るさ。`scene-cut` と揃えてある。 */
function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * **列へ畳むときに、縦のどこを見るか**（画面の高さに対する割合）。
 *
 * 既定は全部（0〜1）。絞れるようにしてあるのは**焼き込みの字幕**のため——
 * 短尺の動画では上下に字幕が焼かれていて、**1.5 秒ごとに書き換わる**。
 * 字幕は画面の一部しか占めないのに、列の色を動かすので
 * 「そこに何かある」側の手がそれを拾ってしまう（測った数字は README に）。
 */
export interface RowBand {
  /** 見はじめる高さ（0 = 上端）。 */
  from: number;
  /** 見おわる高さ（1 = 下端）。 */
  to: number;
}

export const FULL_BAND: RowBand = { from: 0, to: 1 };

/**
 * コマ 1 枚を列へ畳む。
 *
 * 縮小は「いちばん近い画素を拾う」ではなく**列の中を平均する**。
 * 拾う形だと、拾った 1 点がノイズだったときにその列が丸ごと嘘になる。
 */
export function summarizeColumns(frame: FrameLike, time: number, band: RowBand = FULL_BAND): ColumnStat {
  const { width, height, data } = frame;
  const rgb = new Float64Array(COLUMNS * 3);
  const lum = new Float64Array(COLUMNS);
  if (width <= 0 || height <= 0) return { time, rgb, luma: lum };

  // 帯が潰れている（from >= to）ときは、黙って全部を見ずに 1 行だけ残す。
  // 0 行で割ると列が丸ごと 0 になり、「真っ黒なコマ」と見分けが付かなくなる。
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(band.from * height)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(band.to * height)));

  const counts = new Float64Array(COLUMNS);
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = Math.min(COLUMNS - 1, Math.floor((x * COLUMNS) / width));
      const p = (y * width + x) * 4;
      rgb[c * 3] += data[p];
      rgb[c * 3 + 1] += data[p + 1];
      rgb[c * 3 + 2] += data[p + 2];
      lum[c] += luma(data[p], data[p + 1], data[p + 2]);
      counts[c] += 1;
    }
  }
  for (let c = 0; c < COLUMNS; c += 1) {
    if (counts[c] === 0) continue;
    for (let i = 0; i < 3; i += 1) rgb[c * 3 + i] /= counts[c] * 255;
    lum[c] /= counts[c];
  }
  return { time, rgb, luma: lum };
}

/** 素材ぜんたいを列へ畳む。 */
export function summarizeAllColumns(
  frames: FrameLike[],
  times: ArrayLike<number>,
  band: RowBand = FULL_BAND,
): ColumnStat[] {
  const out: ColumnStat[] = [];
  for (let i = 0; i < frames.length; i += 1) out.push(summarizeColumns(frames[i], times[i] ?? i, band));
  return out;
}

/** 列の番号を画面の横位置（0〜1）へ直す。列の**真ん中**を返す。 */
export function columnCenter(c: number): number {
  return (c + 0.5) / COLUMNS;
}

/* --------------------------------------------------------------------------
 * ここから下は「列の並びから、被写体らしさの重みを作る」手の候補。
 * どれを使うかは probe で測ってから決める（＝この時点では横並び）。
 * ------------------------------------------------------------------------ */

/** 列ごとの重み。長さは COLUMNS で、大きいほど「そこに被写体が居そう」。 */
export type Weights = Float64Array;

/** 前のコマとの差（明るさ）。いちばん素朴な「動いた所」。 */
export function diffLuma(cols: ColumnStat[], i: number): Weights {
  const w = new Float64Array(COLUMNS);
  if (i === 0) return w;
  for (let c = 0; c < COLUMNS; c += 1) w[c] = Math.abs(cols[i].luma[c] - cols[i - 1].luma[c]);
  return w;
}

/** 前のコマとの差（色ぜんぶ）。色だけが変わる動きを拾えるはず。 */
export function diffRgb(cols: ColumnStat[], i: number): Weights {
  const w = new Float64Array(COLUMNS);
  if (i === 0) return w;
  const a = cols[i].rgb;
  const b = cols[i - 1].rgb;
  for (let c = 0; c < COLUMNS; c += 1) {
    w[c] = (Math.abs(a[c * 3] - b[c * 3]) + Math.abs(a[c * 3 + 1] - b[c * 3 + 1]) + Math.abs(a[c * 3 + 2] - b[c * 3 + 2])) / 3;
  }
  return w;
}

/**
 * **カメラの横ずれを打ち消してから**引き算する。
 *
 * パンしていると画面じゅうが動くので、素直な引き算では被写体の所だけが立つ理由が無い。
 * 前のコマを何列かずらして重ねてみて、いちばん合う位置を選んでから引く。
 * ずらしは整数の列単位（1 列 = 画面の 3.1%）で、**画面 1 枚 / 秒 のパンは 15fps なら 2.1 列**。
 */
export function diffShifted(cols: ColumnStat[], i: number, maxShift = 6): Weights {
  const w = new Float64Array(COLUMNS);
  if (i === 0) return w;
  const a = cols[i].luma;
  const b = cols[i - 1].luma;
  let bestShift = 0;
  let bestCost = Infinity;
  for (let s = -maxShift; s <= maxShift; s += 1) {
    let cost = 0;
    let n = 0;
    for (let c = 0; c < COLUMNS; c += 1) {
      const j = c - s;
      if (j < 0 || j >= COLUMNS) continue;
      cost += Math.abs(a[c] - b[j]);
      n += 1;
    }
    // 重なりが狭いほど合計は小さくなるので、1 列あたりへ直してから比べる。
    if (n === 0) continue;
    cost /= n;
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = s;
    }
  }
  for (let c = 0; c < COLUMNS; c += 1) {
    const j = Math.min(COLUMNS - 1, Math.max(0, c - bestShift));
    w[c] = Math.abs(a[c] - b[j]);
  }
  return w;
}

/**
 * **素材ぜんたいの背景**と比べる。列ごとに時間の中央値を取って背景とみなし、そこからの隔たりを見る。
 *
 * 動きが止まっても消えないのが引き算との違い。代わりに**カメラが動くと背景が作れない**。
 */
export function backgroundOdds(cols: ColumnStat[]): (i: number) => Weights {
  const bg = new Float64Array(COLUMNS * 3);
  const buf = new Float64Array(cols.length);
  for (let c = 0; c < COLUMNS; c += 1) {
    for (let k = 0; k < 3; k += 1) {
      for (let i = 0; i < cols.length; i += 1) buf[i] = cols[i].rgb[c * 3 + k];
      const sorted = Array.prototype.slice.call(buf).sort((x: number, y: number) => x - y);
      bg[c * 3 + k] = sorted[sorted.length >> 1];
    }
  }
  return (i: number) => {
    const w = new Float64Array(COLUMNS);
    const a = cols[i].rgb;
    for (let c = 0; c < COLUMNS; c += 1) {
      w[c] =
        (Math.abs(a[c * 3] - bg[c * 3]) + Math.abs(a[c * 3 + 1] - bg[c * 3 + 1]) + Math.abs(a[c * 3 + 2] - bg[c * 3 + 2])) / 3;
    }
    return w;
  };
}

/**
 * **そのコマの中で浮いている列**を探す。列の色を、コマの中の列の中央値と比べる。
 *
 * 時間をまたがないので、止まっていてもカメラが動いても効く。
 * 代わりに**背景そのものが横で変わる素材**（空と地面が横に分かれている絵など）では嘘をつく。
 */
export function spatialOdds(cols: ColumnStat[], i: number): Weights {
  const w = new Float64Array(COLUMNS);
  const a = cols[i].rgb;
  const mid = new Float64Array(3);
  const buf: number[] = [];
  for (let k = 0; k < 3; k += 1) {
    buf.length = 0;
    for (let c = 0; c < COLUMNS; c += 1) buf.push(a[c * 3 + k]);
    buf.sort((x, y) => x - y);
    mid[k] = buf[buf.length >> 1];
  }
  for (let c = 0; c < COLUMNS; c += 1) {
    w[c] = (Math.abs(a[c * 3] - mid[0]) + Math.abs(a[c * 3 + 1] - mid[1]) + Math.abs(a[c * 3 + 2] - mid[2])) / 3;
  }
  return w;
}

/* --------------------------------------------------------------------------
 * 重みを「1 つの位置」へ読む手。ここも候補を並べるだけで、選ぶのは probe。
 * ------------------------------------------------------------------------ */

/** 重みぜんたいの重心。相手が 1 つなら素直だが、**2 つあると間を指す**はず。 */
export function readCentroid(w: Weights): number {
  let sum = 0;
  let acc = 0;
  for (let c = 0; c < COLUMNS; c += 1) {
    sum += w[c];
    acc += w[c] * columnCenter(c);
  }
  return sum > 0 ? acc / sum : NaN;
}

/**
 * いちばん強い列のまわりだけの重心。
 *
 * 素の argmax にしないのは、**1 列（3.1%）刻みでしか答えられない**のと、
 * 同じ強さの列が並んだときに端へ寄るため。`span` は被写体の半分の幅に合わせる
 * （横切る被写体は rx = 0.2 ＝ 6.4 列なので、既定の 5 はその内側）。
 */
export function readPeak(w: Weights, span = 5): number {
  let peak = -1;
  let best = 0;
  for (let c = 0; c < COLUMNS; c += 1) {
    if (w[c] > best) {
      best = w[c];
      peak = c;
    }
  }
  if (peak < 0) return NaN;
  let sum = 0;
  let acc = 0;
  for (let c = Math.max(0, peak - span); c <= Math.min(COLUMNS - 1, peak + span); c += 1) {
    sum += w[c];
    acc += w[c] * columnCenter(c);
  }
  return sum > 0 ? acc / sum : columnCenter(peak);
}

/**
 * 重みが**どれくらい尖っているか**（いちばん強い列 − 真ん中の列）。
 *
 * 「被写体が見えているか」を決めるのに要る。平らな重み（粒ノイズだけ、真っ暗、
 * 画面ぜんたいが一様に動いた）は、重心を取れば必ず答えを返すが**中身は無い**。
 * 強さを見ずに重心だけを使うと、**何も居ないところで枠が泳ぐ。**
 */
export function contrast(w: Weights): number {
  let max = 0;
  const buf: number[] = [];
  for (let c = 0; c < COLUMNS; c += 1) {
    if (w[c] > max) max = w[c];
    buf.push(w[c]);
  }
  buf.sort((a, b) => a - b);
  return max - buf[buf.length >> 1];
}

/* --------------------------------------------------------------------------
 * ここから下は**縦の軸**（2026-10-04）。
 *
 * 最初から縦（9:16）で撮った素材から 1:1 を切るときに余るのは**縦**なので、
 * 「幅 31.6% の窓を横のどこに置くか」と同じ問いが、軸を替えてもう 1 本出てくる。
 * 枠を決める側（`planFromRaw`）は軸を知らない——入口は「0〜1 の位置の列」1 本だけ——
 * なので、**畳む向きだけを足せば同じ道具がそのまま乗る。**
 *
 * ただし**向きを入れ替えただけの鏡像ではない**（測った結果は README に）:
 *   - 背景の階調は**縦に付いている**（空と地面）。横へ畳むと階調は平らになるが、
 *     縦へ畳むと階調そのものが「浮いている帯」として立つ。
 *   - 焼き込みの字幕は**上下にある**。横の軸では「見ない帯」として外へ追い出せるが、
 *     縦の軸では**測っている軸の上に載っている**ので、追い出す先が無い。
 * ------------------------------------------------------------------------ */

/** 畳む向き。`u` は横の位置（列）、`v` は縦の位置（行）。 */
export type Axis = 'u' | 'v';

/**
 * コマ 1 枚を**行**へ畳む。返す形は `summarizeColumns` と同じなので、
 * 重みを作る手（`spatialOdds` など）も読む手（`readPeak` など）もそのまま使える。
 *
 * `band` は**横のどこを見るか**（列へ畳むときの `RowBand` と垂直の関係）。
 * 既定が全部なのは、横に字幕が焼かれている形がまず無いから。
 */
export function summarizeRows(frame: FrameLike, time: number, band: RowBand = FULL_BAND): ColumnStat {
  const { width, height, data } = frame;
  const rgb = new Float64Array(COLUMNS * 3);
  const lum = new Float64Array(COLUMNS);
  if (width <= 0 || height <= 0) return { time, rgb, luma: lum };

  // 潰れた帯の扱いは列と同じ（0 列で割ると「真っ黒なコマ」と区別が付かなくなる）。
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(band.from * width)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(band.to * width)));

  const counts = new Float64Array(COLUMNS);
  for (let y = 0; y < height; y += 1) {
    const r = Math.min(COLUMNS - 1, Math.floor((y * COLUMNS) / height));
    for (let x = x0; x < x1; x += 1) {
      const p = (y * width + x) * 4;
      rgb[r * 3] += data[p];
      rgb[r * 3 + 1] += data[p + 1];
      rgb[r * 3 + 2] += data[p + 2];
      lum[r] += luma(data[p], data[p + 1], data[p + 2]);
      counts[r] += 1;
    }
  }
  for (let r = 0; r < COLUMNS; r += 1) {
    if (counts[r] === 0) continue;
    for (let i = 0; i < 3; i += 1) rgb[r * 3 + i] /= counts[r] * 255;
    lum[r] /= counts[r];
  }
  return { time, rgb, luma: lum };
}

/** 素材ぜんたいを行へ畳む。 */
export function summarizeAllRows(
  frames: FrameLike[],
  times: ArrayLike<number>,
  band: RowBand = FULL_BAND,
): ColumnStat[] {
  const out: ColumnStat[] = [];
  for (let i = 0; i < frames.length; i += 1) out.push(summarizeRows(frames[i], times[i] ?? i, band));
  return out;
}

/** 向きで選んで畳む。呼ぶ側が `if` を書かずに済むように 1 つにしてある。 */
export function summarizeAllSlices(
  frames: FrameLike[],
  times: ArrayLike<number>,
  axis: Axis,
  band: RowBand = FULL_BAND,
): ColumnStat[] {
  return axis === 'v' ? summarizeAllRows(frames, times, band) : summarizeAllColumns(frames, times, band);
}

/**
 * **軸の上で、探してよい範囲の外を重みから締め出す**（2026-10-04）。
 *
 * 焼き込みの字幕は上下にあるので、縦の軸では**測っている軸の上に載る**。
 * 横の軸のように「見ない帯」として畳む前に落とすことができない
 * （畳む向きが同じなので、落としても帯がそのまま残る）。なので畳んだあとに締め出す。
 *
 * **0 にするのであって、小さい値を入れるのではない。** `readPeak` は山のまわりだけを
 * 重心で読むので、山の隣に残骸があると答えがそちらへ引かれる。
 */
export function keepBand(w: Weights, band: RowBand): Weights {
  const out = new Float64Array(w);
  for (let c = 0; c < COLUMNS; c += 1) {
    const u = columnCenter(c);
    if (u < band.from || u > band.to) out[c] = 0;
  }
  return out;
}

/**
 * **まっすぐな階調を外してから**、浮いている帯を探す（2026-10-04）。
 *
 * `spatialOdds` は帯の色を**コマの中の中央値**と比べる。横の軸ではそれでよかったが、
 * 縦の軸では背景そのものが上から下へ階調を持っている（空と地面）ので、
 * **いちばん浮いて見えるのは被写体ではなく階調の端**になる。
 * 実際 `vsubject-static` では重みが上 0.06 から下 0.26 まで一本調子に上がり、
 * 山は必ずいちばん下の帯を指す（2026-10-04 に測った）。
 *
 * なので、帯の番号に対して**最小二乗で直線を当て、その残りだけを見る。**
 * 階調は直線で表せるぶんが消え、被写体のような**一か所の盛り上がり**だけが残る。
 *
 * 直線にしてあるのは、曲げるほど被写体そのものを呑み込むから——
 * 被写体は帯の 4 割を占めることもあるので、**曲げられる自由度を増やすと
 * 「背景を外す」ではなく「被写体を外す」になる。**
 */
export function trendOdds(cols: ColumnStat[], i: number): Weights {
  const w = new Float64Array(COLUMNS);
  const a = cols[i].rgb;
  // 帯の番号を -1〜1 に取る（係数の桁をそろえるため。答えは割り算で消えるので中身は変わらない）。
  let sxx = 0;
  for (let c = 0; c < COLUMNS; c += 1) {
    const x = (2 * c) / (COLUMNS - 1) - 1;
    sxx += x * x;
  }
  for (let k = 0; k < 3; k += 1) {
    let sy = 0;
    let sxy = 0;
    for (let c = 0; c < COLUMNS; c += 1) {
      const x = (2 * c) / (COLUMNS - 1) - 1;
      sy += a[c * 3 + k];
      sxy += x * a[c * 3 + k];
    }
    const mean = sy / COLUMNS;
    const slope = sxx > 0 ? sxy / sxx : 0;
    for (let c = 0; c < COLUMNS; c += 1) {
      const x = (2 * c) / (COLUMNS - 1) - 1;
      w[c] += Math.abs(a[c * 3 + k] - (mean + slope * x)) / 3;
    }
  }
  return w;
}
