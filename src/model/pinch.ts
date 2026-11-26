/** ピンチで変えられる大きさの範囲（プレビューのホイールと同じ）。 */
export const PINCH_MIN_SCALE = 0.1;
export const PINCH_MAX_SCALE = 6;

/** つまんだ指の間隔の比で、大きさを決める（つまみ始めの大きさ × 今の間隔 ÷ 始めの間隔）。 */
export function pinchScale(originScale: number, startDist: number, dist: number): number {
  if (!(startDist > 0) || !(dist > 0)) return originScale;
  return Math.max(PINCH_MIN_SCALE, Math.min(PINCH_MAX_SCALE, originScale * (dist / startDist)));
}
