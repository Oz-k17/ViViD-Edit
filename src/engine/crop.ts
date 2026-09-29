/**
 * 切り抜き枠の当たり判定と、掴んで動かしたときの計算。
 *
 * すべて「シーケンス座標の矩形」だけで考える。0〜1 の割合のまま計算すると
 * 縦横で 1 の意味する長さが違うので、比率固定・スナップ・最小サイズのどれもが
 * 素材の縦横比ごとに歪む。矩形で計算し、最後に割合へ戻す。
 *
 * 描画にも React にも依存しないので、そのまま数値だけで確かめられる。
 */

import type { Rect } from './renderer';

/** つまみ。四隅と、辺の中央。 */
export const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type CropHandle = (typeof CROP_HANDLES)[number];

/**
 * 出力側の枠に出すつまみは四隅だけにしてある。
 * 辺のつまみを付けると縦横比が変わり、切り抜いた絵が伸びてしまうため。
 */
export const CROP_CORNERS = ['nw', 'ne', 'se', 'sw'] as const;

/** 切り抜き枠の最小の大きさ（シーケンス座標）。潰れて掴めなくなるのを防ぐ。 */
export const MIN_CROP_PX = 24;

const has = (handle: CropHandle, side: string) => handle.includes(side);

export function rectFrom(left: number, top: number, right: number, bottom: number): Rect {
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    w: Math.abs(right - left),
    h: Math.abs(bottom - top),
  };
}

/** 選んでいる範囲（0〜1）→ 画面上の矩形。 */
export function selectionRect(source: Rect, crop: { sx: number; sy: number; sw: number; sh: number }): Rect {
  return {
    x: source.x + crop.sx * source.w,
    y: source.y + crop.sy * source.h,
    w: crop.sw * source.w,
    h: crop.sh * source.h,
  };
}

/** 画面上の矩形 → 選んでいる範囲（0〜1）。 */
export function selectionFromRect(source: Rect, rect: Rect) {
  return {
    sx: (rect.x - source.x) / source.w,
    sy: (rect.y - source.y) / source.h,
    sw: rect.w / source.w,
    sh: rect.h / source.h,
  };
}

/** つまみの当たり判定に使う一辺の長さ。指でも掴める大きさにしてある。 */
export function handleSize(sequenceWidth: number): number {
  return Math.max(24, sequenceWidth / 13);
}

/**
 * その枠に合わせたつまみの大きさ。
 *
 * つまみを 8 つとも大きいままにすると、**小さい枠では中身がつまみで埋まる**。
 * そうなると内側を掴めず、動かしたいだけなのに必ず大きさが変わってしまう。
 * 枠の 1/3 を超えないところで止めて、真ん中は必ず掴めるようにする。
 */
export function handleSizeFor(sequenceWidth: number, rect: Rect): number {
  return Math.max(12, Math.min(handleSize(sequenceWidth), rect.w / 3, rect.h / 3));
}

/** つまみを置く点（枠の角と辺の中央）。 */
export function handlePoint(rect: Rect, handle: CropHandle): { x: number; y: number } {
  const x = has(handle, 'w') ? rect.x : has(handle, 'e') ? rect.x + rect.w : rect.x + rect.w / 2;
  const y = has(handle, 'n') ? rect.y : has(handle, 's') ? rect.y + rect.h : rect.y + rect.h / 2;
  return { x, y };
}

/** つまみの矩形。 */
export function handleRect(sequenceWidth: number, rect: Rect, handle: CropHandle): Rect {
  const s = handleSizeFor(sequenceWidth, rect);
  const { x, y } = handlePoint(rect, handle);
  return { x: x - s / 2, y: y - s / 2, w: s, h: s };
}

/**
 * 比率を保ったまま、枠を「動かした側」へ伸ばす。
 * 角のつまみは反対の角を固定し、辺のつまみは反対の辺を固定してもう一方の軸は中心を保つ。
 */
function applyRatio(rect: Rect, handle: CropHandle, origin: Rect, ratio: number): Rect {
  const corner = (has(handle, 'n') || has(handle, 's')) && (has(handle, 'e') || has(handle, 'w'));

  if (corner) {
    // ドラッグした量を包む最小の矩形にする（どちらの軸で引いても素直に付いてくる）。
    const w = Math.max(rect.w, rect.h * ratio);
    const h = w / ratio;
    const left = has(handle, 'w') ? origin.x + origin.w - w : origin.x;
    const top = has(handle, 'n') ? origin.y + origin.h - h : origin.y;
    return { x: left, y: top, w, h };
  }

  if (has(handle, 'n') || has(handle, 's')) {
    const h = rect.h;
    const w = h * ratio;
    const top = has(handle, 'n') ? origin.y + origin.h - h : origin.y;
    return { x: origin.x + origin.w / 2 - w / 2, y: top, w, h };
  }

  const w = rect.w;
  const h = w / ratio;
  const left = has(handle, 'w') ? origin.x + origin.w - w : origin.x;
  return { x: left, y: origin.y + origin.h / 2 - h / 2, w, h };
}

/** 素材の外へはみ出さないところまで縮める。比率を指定したときは形を保ったまま縮める。 */
function clampInside(rect: Rect, bounds: Rect, ratio: number | null, anchor: { x: number; y: number }): Rect {
  if (ratio === null) {
    // 辺ごとに切り詰める。枠ごと押し戻すと、動かしていない側まで動いてしまう。
    const left = Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.w);
    const top = Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.h);
    const right = Math.max(Math.min(rect.x + rect.w, bounds.x + bounds.w), bounds.x);
    const bottom = Math.max(Math.min(rect.y + rect.h, bounds.y + bounds.h), bounds.y);
    return rectFrom(left, top, right, bottom);
  }

  // 固定した点（＝動かしていない側）を軸に、収まるまで一様に縮める。
  let scale = 1;
  if (rect.x < bounds.x) scale = Math.min(scale, (anchor.x - bounds.x) / Math.max(1e-6, anchor.x - rect.x));
  if (rect.y < bounds.y) scale = Math.min(scale, (anchor.y - bounds.y) / Math.max(1e-6, anchor.y - rect.y));
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const boundsRight = bounds.x + bounds.w;
  const boundsBottom = bounds.y + bounds.h;
  if (right > boundsRight) scale = Math.min(scale, (boundsRight - anchor.x) / Math.max(1e-6, right - anchor.x));
  if (bottom > boundsBottom) scale = Math.min(scale, (boundsBottom - anchor.y) / Math.max(1e-6, bottom - anchor.y));
  if (scale >= 1) return rect;

  const w = rect.w * scale;
  const h = rect.h * scale;
  return {
    x: anchor.x + (rect.x - anchor.x) * scale,
    y: anchor.y + (rect.y - anchor.y) * scale,
    w,
    h,
  };
}

/** つまみを掴んで動かしたあとの枠。 */
export function resizeCropRect(
  origin: Rect,
  handle: CropHandle,
  point: { x: number; y: number },
  bounds: Rect,
  ratio: number | null,
): Rect {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;
  if (has(handle, 'w')) left = point.x;
  if (has(handle, 'e')) right = point.x;
  if (has(handle, 'n')) top = point.y;
  if (has(handle, 's')) bottom = point.y;

  let rect = rectFrom(left, top, right, bottom);
  if (ratio !== null) rect = applyRatio(rect, handle, origin, ratio);

  // 動かしていない側の角（＝縮めるときの軸）。
  const anchor = {
    x: has(handle, 'w') ? origin.x + origin.w : origin.x,
    y: has(handle, 'n') ? origin.y + origin.h : origin.y,
  };
  return clampInside(rect, bounds, ratio, anchor);
}

/** 押した点から引いて作る枠。 */
export function drawCropRect(
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  bounds: Rect,
  ratio: number | null,
): Rect {
  let rect = rectFrom(anchor.x, anchor.y, point.x, point.y);
  if (ratio !== null) {
    const w = Math.max(rect.w, rect.h * ratio);
    const h = w / ratio;
    rect = {
      x: point.x < anchor.x ? anchor.x - w : anchor.x,
      y: point.y < anchor.y ? anchor.y - h : anchor.y,
      w,
      h,
    };
  }
  return clampInside(rect, bounds, ratio, anchor);
}

/** 大きさを変えずに動かす。素材の外へは出さない。 */
export function moveCropRect(origin: Rect, dx: number, dy: number, bounds: Rect): Rect {
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.w - origin.w, origin.x + dx)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.h - origin.h, origin.y + dy)),
    w: origin.w,
    h: origin.h,
  };
}

/**
 * 素材の端と中心へ吸着させる。
 * 「ぴったり端まで」「ちょうど半分」が手だけで出せないと、
 * 結局あとから数値で直すことになるため。
 */
export function snapCropRect(rect: Rect, bounds: Rect, tolerance: number): Rect {
  const snap = (value: number, targets: number[]) => {
    for (const target of targets) if (Math.abs(value - target) <= tolerance) return target;
    return value;
  };
  const xs = [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w];
  const ys = [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h];
  const left = snap(rect.x, xs);
  const top = snap(rect.y, ys);
  const right = snap(rect.x + rect.w, xs);
  const bottom = snap(rect.y + rect.h, ys);
  return rectFrom(left, top, right, bottom);
}

/** 潰れた枠を掴める大きさへ戻す。 */
export function ensureMinimum(rect: Rect, bounds: Rect, ratio: number | null): Rect {
  const minW = Math.min(MIN_CROP_PX, bounds.w);
  const minH = Math.min(MIN_CROP_PX, bounds.h);
  if (rect.w >= minW && rect.h >= minH) return rect;
  const w = ratio === null ? Math.max(rect.w, minW) : Math.max(rect.w, minW, minH * ratio);
  const h = ratio === null ? Math.max(rect.h, minH) : w / ratio;
  return clampInside({ x: rect.x, y: rect.y, w, h }, bounds, ratio, { x: rect.x, y: rect.y });
}

/** その比率で素材に収まる、いちばん大きい枠（中央寄せ）。 */
export function largestRectForRatio(bounds: Rect, ratio: number): Rect {
  const w = Math.min(bounds.w, bounds.h * ratio);
  const h = w / ratio;
  return { x: bounds.x + (bounds.w - w) / 2, y: bounds.y + (bounds.h - h) / 2, w, h };
}
