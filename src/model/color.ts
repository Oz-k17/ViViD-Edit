/**
 * 色調整（カラーグレーディング）: 色温度・露出・コントラスト・彩度・3 つのホイール（暗部・中間・明部）・
 * トーンカーブ・読み込んだ LUT（.cube）・ワンタッチのプリセット。
 *
 * 項目の組み方は openreel-video（MIT, Augustus Otu and Contributors）の Color Grading
 * （Lift / Gamma / Gain のホイール・カーブ・LUT・プリセット）に倣った。
 *
 * ## 全部を 1 枚の 3D LUT に焼く
 *
 * 描く側（`engine/colorPass.ts`）は「色 → 色」の対応表（3D LUT）を 1 回引くだけにしてある。
 * 項目がいくつあっても、読み込んだ LUT があっても、1 コマにかかる手間は同じ。
 * 表を作るのはここ（`bakeLut`）で、設定が変わったときだけ作り直す。
 *
 * ここは画面にも WebGL にも依らない（`npm run test:model` で 1 色ずつ確かめられる）。
 */

/** 色の輪（ホイール）。向き（色相）と強さ、明るさ。 */
export interface ColorWheel {
  /** 色相（度）。0 = 赤、120 = 緑、240 = 青。 */
  hue: number;
  /** 色の強さ 0〜1。 */
  amount: number;
  /** 明るさ -1〜1。 */
  luma: number;
}

export interface CubeLut {
  name: string;
  /** 1 辺の格子の数（17・33・65 など）。 */
  size: number;
  /** r が最も速く変わる順に、r,g,b を 0〜1 で並べたもの（.cube の並びのまま）。 */
  data: number[];
}

export interface ColorGrade {
  /** 選んだプリセットの名前（表示だけに使う）。 */
  preset?: string | null;
  /** 露出 -1〜1（±2 段）。 */
  exposure?: number;
  /** コントラスト -1〜1。 */
  contrast?: number;
  /** 彩度 -1〜1（-1 で白黒）。 */
  saturation?: number;
  /** 色温度 -1〜1（青 ↔ 黄）。 */
  temperature?: number;
  /** 色かぶり -1〜1（緑 ↔ マゼンタ）。 */
  tint?: number;
  /** 暗部・中間・明部のホイール。 */
  lift?: ColorWheel;
  gamma?: ColorWheel;
  gain?: ColorWheel;
  /** トーンカーブの途中の点（0〜1 の x,y）。両端 (0,0)・(1,1) は持たない。 */
  curve?: [number, number][];
  /** 読み込んだ LUT と、その効かせ具合（0〜1）。 */
  lut?: CubeLut | null;
  lutMix?: number;
}

export type Rgb = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 何も変えない設定か（描く側はこのとき色の手間を丸ごと飛ばす）。 */
export function isNeutralGrade(grade: ColorGrade | null | undefined): boolean {
  if (!grade) return true;
  const wheelOff = (w?: ColorWheel) => !w || (num(w.amount) === 0 && num(w.luma) === 0);
  return (
    num(grade.exposure) === 0 &&
    num(grade.contrast) === 0 &&
    num(grade.saturation) === 0 &&
    num(grade.temperature) === 0 &&
    num(grade.tint) === 0 &&
    wheelOff(grade.lift) &&
    wheelOff(grade.gamma) &&
    wheelOff(grade.gain) &&
    (!grade.curve || grade.curve.length === 0 || grade.curve.every(([x, y]) => Math.abs(x - y) < 1e-6)) &&
    (!grade.lut || num(grade.lutMix ?? 1) === 0)
  );
}

/** ホイールの向きを、平均 0 の色のずれに直す（灰色を中心に、その色のほうへ寄せる量）。 */
export function wheelOffset(wheel: ColorWheel | undefined): Rgb {
  if (!wheel) return [0, 0, 0];
  const h = (((num(wheel.hue) % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b]: Rgb =
    h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const mean = (r + g + b) / 3;
  const a = clamp01(num(wheel.amount));
  const l = num(wheel.luma);
  return [(r - mean) * a + l, (g - mean) * a + l, (b - mean) * a + l];
}

/**
 * トーンカーブ（単調な 3 次補間。点を越えて行き過ぎないので、色が反転しない）。
 * 点は x の順に並べ直し、両端 (0,0)・(1,1) を足して引く。
 */
export function makeCurve(points: readonly [number, number][] | undefined): (x: number) => number {
  if (!points || points.length === 0) return (x) => x;
  const pts = [[0, 0], ...points.map(([x, y]) => [clamp01(x), clamp01(y)]), [1, 1]].sort((a, b) => a[0] - b[0]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = xs.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i += 1) d.push(xs[i + 1] - xs[i] > 0 ? (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) : 0);
  // Fritsch–Carlson の傾き。
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i += 1) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    const v = clamp01(x);
    let i = 0;
    while (i < n - 2 && v > xs[i + 1]) i += 1;
    const h = xs[i + 1] - xs[i];
    if (h <= 0) return ys[i];
    const t = (v - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return clamp01(
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1],
    );
  };
}

/** 読み込んだ LUT を 1 色に引く（3 次元の直線補間）。 */
export function sampleCube(lut: CubeLut, [r, g, b]: Rgb): Rgb {
  const s = lut.size;
  const at = (v: number) => clamp01(v) * (s - 1);
  const fr = at(r);
  const fg = at(g);
  const fb = at(b);
  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(s - 1, r0 + 1);
  const g1 = Math.min(s - 1, g0 + 1);
  const b1 = Math.min(s - 1, b0 + 1);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const px = (ri: number, gi: number, bi: number, c: number) => lut.data[(ri + gi * s + bi * s * s) * 3 + c] ?? 0;
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const c00 = px(r0, g0, b0, c) * (1 - dr) + px(r1, g0, b0, c) * dr;
    const c10 = px(r0, g1, b0, c) * (1 - dr) + px(r1, g1, b0, c) * dr;
    const c01 = px(r0, g0, b1, c) * (1 - dr) + px(r1, g0, b1, c) * dr;
    const c11 = px(r0, g1, b1, c) * (1 - dr) + px(r1, g1, b1, c) * dr;
    out[c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
  }
  return out;
}

const luma = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * 1 色を変える。順番は「LUT → 露出 → 色温度・色かぶり → ホイール → コントラスト → カーブ → 彩度」。
 * LUT を先に掛けるのは、多くの LUT が「撮ったままの色」を前提に作られているため。
 */
export function gradeColor(grade: ColorGrade, input: Rgb, curve = makeCurve(grade.curve)): Rgb {
  let c: Rgb = [input[0], input[1], input[2]];
  if (grade.lut && grade.lut.size >= 2) {
    const mix = clamp01(grade.lutMix ?? 1);
    const l = sampleCube(grade.lut, c);
    c = [c[0] + (l[0] - c[0]) * mix, c[1] + (l[1] - c[1]) * mix, c[2] + (l[2] - c[2]) * mix];
  }
  const ev = Math.pow(2, num(grade.exposure) * 2);
  const t = num(grade.temperature);
  const tint = num(grade.tint);
  c = [c[0] * ev * (1 + 0.18 * t) * (1 + 0.06 * tint), c[1] * ev * (1 - 0.12 * tint), c[2] * ev * (1 - 0.18 * t) * (1 + 0.06 * tint)];

  const lift = wheelOffset(grade.lift);
  const gamma = wheelOffset(grade.gamma);
  const gain = wheelOffset(grade.gain);
  for (let i = 0; i < 3; i += 1) {
    let v = clamp01(c[i]);
    v = v * (1 + gain[i] * 0.6); // 明部: 掛けて伸ばす
    v = v + lift[i] * 0.25 * (1 - v); // 暗部: 黒の側だけ持ち上げる・沈める
    v = Math.pow(clamp01(v), 1 / Math.max(0.2, 1 + gamma[i] * 0.8)); // 中間: 両端を動かさずに曲げる
    c[i] = v;
  }

  const k = 1 + num(grade.contrast);
  c = c.map((v) => curve(clamp01((v - 0.5) * k + 0.5))) as Rgb;

  const s = 1 + num(grade.saturation);
  const y = luma(c);
  return c.map((v) => clamp01(y + (v - y) * s)) as Rgb;
}

/** 焼く表の 1 辺。33 は多くの LUT と同じで、色の段差が見えない細かさ。 */
export const BAKE_SIZE = 33;

/**
 * 設定を 1 枚の 3D LUT に焼く。並びは .cube と同じ（r が最も速い）で、0〜255 に丸めて返す
 * （WebGL の 8 ビットの絵にそのまま載せる）。
 */
export function bakeLut(grade: ColorGrade, size = BAKE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * size * 3);
  const curve = makeCurve(grade.curve);
  let o = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const c = gradeColor(grade, [r / (size - 1), g / (size - 1), b / (size - 1)], curve);
        out[o++] = Math.round(c[0] * 255);
        out[o++] = Math.round(c[1] * 255);
        out[o++] = Math.round(c[2] * 255);
      }
    }
  }
  return out;
}

/** 焼いた表の見分け（同じ設定なら作り直さない）。LUT の中身は名前と大きさで代える。 */
export function gradeKey(grade: ColorGrade): string {
  const { lut, ...rest } = grade;
  return JSON.stringify(rest) + (lut ? `|lut:${lut.name}:${lut.size}:${lut.data.length}:${lut.data[7] ?? 0}` : '');
}

/**
 * .cube（Adobe / Resolve の 3D LUT）を読む。1D の LUT と、範囲（DOMAIN_MIN/MAX）が 0〜1 でないものは
 * 読み違えるので断る。読めなければ理由を投げる。
 */
export function parseCube(text: string, name = 'LUT'): CubeLut {
  let size = 0;
  let title = name;
  const data: number[] = [];
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'TITLE') {
      title = line.slice(5).trim().replace(/^"|"$/g, '') || name;
    } else if (key === 'LUT_3D_SIZE') {
      size = Number(parts[1]);
    } else if (key === 'LUT_1D_SIZE') {
      throw new Error('1D の LUT には対応していません（3D の .cube を選んでください）');
    } else if (key === 'DOMAIN_MIN') {
      min = parts.slice(1, 4).map(Number);
    } else if (key === 'DOMAIN_MAX') {
      max = parts.slice(1, 4).map(Number);
    } else if (/^[-+.\d]/.test(key)) {
      const v = parts.slice(0, 3).map(Number);
      if (v.length === 3 && v.every(Number.isFinite)) data.push(v[0], v[1], v[2]);
    }
  }
  if (!(size >= 2 && size <= 129)) throw new Error('LUT_3D_SIZE が見つからないか、大きさが読めません');
  if (min.some((v) => v !== 0) || max.some((v) => v !== 1)) throw new Error('範囲が 0〜1 でない LUT には対応していません');
  if (data.length !== size * size * size * 3) throw new Error(`色の数が合いません（${size}³ = ${size ** 3} 色のはずが ${data.length / 3} 色）`);
  return { name: title, size, data: data.map((v) => Math.round(clamp01(v) * 10000) / 10000) };
}

/**
 * 大きな LUT（65³ など）を 33³ に縮める。保存する JSON と元に戻す履歴が、クリップ 1 本で
 * 数 MB に膨らまないように（33³ は多くの LUT と同じ細かさで、見た目の差は出ない）。
 */
export function shrinkCube(lut: CubeLut, size = BAKE_SIZE): CubeLut {
  if (lut.size <= size) return lut;
  const data: number[] = [];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const c = sampleCube(lut, [r / (size - 1), g / (size - 1), b / (size - 1)]);
        data.push(...c.map((v) => Math.round(v * 10000) / 10000));
      }
    }
  }
  return { name: lut.name, size, data };
}

/** ワンタッチのプリセット。どれも上の項目の組み合わせなので、選んだあとに微調整できる。 */
export const COLOR_PRESETS: { key: string; label: string; grade: ColorGrade }[] = [
  { key: 'bright', label: '明るく自然に', grade: { exposure: 0.12, contrast: -0.05, saturation: 0.1, gamma: { hue: 30, amount: 0.05, luma: 0.08 } } },
  { key: 'warm', label: 'あたたかい', grade: { temperature: 0.35, saturation: 0.08, gain: { hue: 35, amount: 0.2, luma: 0 } } },
  { key: 'cool', label: 'クール', grade: { temperature: -0.35, contrast: 0.08, lift: { hue: 210, amount: 0.3, luma: 0 } } },
  {
    key: 'tealOrange',
    label: 'ティール＆オレンジ',
    grade: { contrast: 0.12, saturation: 0.1, lift: { hue: 190, amount: 0.55, luma: 0 }, gain: { hue: 30, amount: 0.35, luma: 0 } },
  },
  {
    key: 'film',
    label: 'レトロフィルム',
    grade: { contrast: 0.08, saturation: -0.15, lift: { hue: 200, amount: 0.15, luma: 0.25 }, gain: { hue: 45, amount: 0.15, luma: -0.05 }, curve: [[0.25, 0.22], [0.75, 0.8]] },
  },
  { key: 'muted', label: 'くすみカラー', grade: { contrast: -0.12, saturation: -0.35, lift: { hue: 30, amount: 0.1, luma: 0.2 }, temperature: 0.08 } },
  { key: 'vivid', label: 'くっきり鮮やか', grade: { contrast: 0.15, saturation: 0.35, curve: [[0.25, 0.2], [0.75, 0.82]] } },
  { key: 'mono', label: '白黒（硬め）', grade: { saturation: -1, contrast: 0.2, curve: [[0.3, 0.25], [0.7, 0.76]] } },
];
