/**
 * 解析の結果（シーンの切れ目・リフレームの区間）を、タイムラインの編集に直す。
 *
 * 解析（`src/analysis/`）は**素材の頭からの秒**で答える。タイムラインのクリップは
 * 素材の途中だけを使い、速さも変えられる。**2 つの時計を行き来するのがここの仕事**で、
 * 取り違えると切れ目が静かに別の所へ寄る（絵は出るので、ずれたことに気づきにくい）。
 *
 * 画面にも DOM にも依存していないので、Node から検算できる。
 */

import { splitAt } from './ops';
import type { Clip, Crop, Sequence } from './types';
import type { CenterSegment } from '../analysis/segments';

/** クリップの終わり（タイムラインの秒）。 */
const endOf = (clip: Clip) => clip.start + clip.duration;

/** 素材の頭からの秒 → タイムラインの秒。 */
export function sourceToTimeline(clip: Clip, sourceTime: number): number {
  return clip.start + (sourceTime - clip.sourceIn) / (clip.speed || 1);
}

/** タイムラインの秒 → 素材の頭からの秒。 */
export function timelineToSource(clip: Clip, timelineTime: number): number {
  return clip.sourceIn + (timelineTime - clip.start) * (clip.speed || 1);
}

/** このクリップが使っている、素材の中の範囲（秒）。解析の読む範囲に渡す。 */
export function usedSourceRange(clip: Clip): { from: number; to: number } {
  return { from: clip.sourceIn, to: timelineToSource(clip, endOf(clip)) };
}

export interface SplitResult {
  sequence: Sequence;
  /** 割ったあとの、時間順のクリップの id（最初が元のクリップ）。 */
  pieceIds: string[];
}

/** 割れる範囲の余白。端から近すぎる所で割ると、極端に短いクリップができる。 */
const EDGE = 0.1;

/**
 * 1 本のクリップを、タイムラインの秒の列で割る。
 *
 * `splitAt` は「その時刻にあるクリップを割って、右側に新しい id を振る」ので、
 * 割るたびに右側を追いかけて、次の時刻はそちらを割る。
 * 端に近すぎる秒（`EDGE` 未満）と、重複した秒は飛ばす。
 */
export function splitClipAtTimes(sequence: Sequence, clipId: string, times: number[]): SplitResult {
  const original = sequence.clips.find((c) => c.id === clipId);
  if (!original) return { sequence, pieceIds: [] };

  const sorted = [...times].sort((a, b) => a - b);
  let seq = sequence;
  let current = clipId;
  const pieceIds = [clipId];
  let last = original.start;

  for (const t of sorted) {
    const clip = seq.clips.find((c) => c.id === current);
    if (!clip) break;
    if (t - last < EDGE || endOf(clip) - t < EDGE) continue;

    const before = new Set(seq.clips.map((c) => c.id));
    const next = splitAt(seq, t, [current]);
    if (next === seq) continue;
    const right = next.clips.find(
      (c) => !before.has(c.id) && c.trackId === clip.trackId && Math.abs(c.start - t) < 1e-6,
    );
    if (!right) continue;
    seq = next;
    current = right.id;
    pieceIds.push(right.id);
    last = t;
  }
  return { sequence: seq, pieceIds };
}

/**
 * シーンの切れ目（素材の頭からの秒）で、クリップを場面ごとに割る。
 * クリップが使っていない範囲の切れ目は無視する。
 */
export function splitAtSceneBoundaries(sequence: Sequence, clipId: string, sourceTimes: number[]): SplitResult {
  const clip = sequence.clips.find((c) => c.id === clipId);
  if (!clip) return { sequence, pieceIds: [] };
  const times = sourceTimes
    .map((t) => sourceToTimeline(clip, t))
    .filter((t) => t > clip.start && t < endOf(clip));
  return splitClipAtTimes(sequence, clipId, times);
}

/** リフレームの窓。軸が `x` なら窓は横幅、`y` なら縦幅（どちらも素材に対する割合）。 */
export interface ReframeWindow {
  axis: 'x' | 'y';
  size: number;
}

/**
 * 素材の縦横比とシーケンスの縦横比から、リフレームの窓を決める。
 * ほぼ同じ縦横比なら切り出す余りが無いので `null`。
 */
export function reframeWindow(media: { width: number; height: number }, sequenceAspect: number): ReframeWindow | null {
  if (!(media.width > 0) || !(media.height > 0) || !(sequenceAspect > 0)) return null;
  const aspect = media.width / media.height;
  if (Math.abs(aspect - sequenceAspect) / sequenceAspect < 0.02) return null;
  return aspect > sequenceAspect
    ? { axis: 'x', size: sequenceAspect / aspect }
    : { axis: 'y', size: aspect / sequenceAspect };
}

/** 窓の中心から、切り出す範囲（素材の 0〜1）を決める。素材の外へはみ出させない。 */
export function reframeCrop(window: ReframeWindow, center: number): Crop {
  const start = Math.min(Math.max(center - window.size / 2, 0), 1 - window.size);
  const base = { enabled: true, dx: 0, dy: 0, dw: 1, dh: 1 };
  return window.axis === 'x'
    ? { ...base, sx: start, sy: 0, sw: window.size, sh: 1 }
    : { ...base, sx: 0, sy: start, sw: 1, sh: window.size };
}

export interface ReframeResult {
  sequence: Sequence;
  /** 区間の数（＝割った後のクリップ数）。 */
  segments: number;
}

/**
 * 区間の並びを、クリップの割り方とクロップに直す。
 *
 * 区間の頭（最初を除く）で割り、各クリップに区間の中心のクロップを置く。
 * 切り出し先は常にシーケンス全面（`dx=0, dw=1` など）。窓の縦横比がシーケンスと同じなので、
 * 絵は伸びも縮みもしない。
 */
export function applyReframeSegments(
  sequence: Sequence,
  clipId: string,
  segments: CenterSegment[],
  window: ReframeWindow,
): ReframeResult {
  const clip = sequence.clips.find((c) => c.id === clipId);
  if (!clip || segments.length === 0) return { sequence, segments: 0 };

  const used = usedSourceRange(clip);
  // 最初の区間は、クリップの頭から。以降は区間の頭で割る。
  const inside = segments.filter((s) => s.to > used.from && s.from < used.to);
  if (inside.length === 0) return { sequence, segments: 0 };

  const boundaries = inside.slice(1).map((s) => sourceToTimeline(clip, s.from));
  const { sequence: split, pieceIds } = splitClipAtTimes(sequence, clipId, boundaries);

  // 割れなかった境目（端に近すぎるなど）があると、区間とクリップの数がずれる。
  // 時刻で突き合わせる（添字で組むと、1 つ飛ばしただけで以降が全部ずれる）。
  const crops = new Map<string, Crop>();
  for (const id of pieceIds) {
    const piece = split.clips.find((c) => c.id === id);
    if (!piece) continue;
    const mid = timelineToSource(piece, piece.start + piece.duration / 2);
    // 区間の頭を過ぎた中で最後のもの。最初のコマの時刻はクリップの頭より少し後ろなので、
    // 頭より前に落ちた中点は最初の区間へ寄せる（`find` で探すと、見つからずに最後の区間へ飛ぶ）。
    let seg = inside[0];
    for (const s of inside) if (s.from <= mid) seg = s;
    crops.set(id, reframeCrop(window, seg.center));
  }

  return {
    sequence: { ...split, clips: split.clips.map((c) => (crops.has(c.id) ? { ...c, crop: crops.get(c.id) as Crop } : c)) },
    segments: pieceIds.length,
  };
}
