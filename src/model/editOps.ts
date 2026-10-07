/**
 * 編集操作の追加分（filmcraft-cop の edit 代数を参考にしたもの）。
 *
 * `ops.ts` の操作は「上書き」が基本（置いた所を削り取る）。ここにあるのは、
 * 尺を保ったまま・または後続を詰めながら編集するための操作:
 * 挿入 / 範囲の取り除き（lift・extract）/ 隙間詰め / リップルトリム / ロール / スリップ / スライド。
 *
 * すべて「新しい Sequence を返す純粋関数」。動かせない（余裕が無い）ときは同じ Sequence を返す。
 * 素材の長さはモデルが持っていないので、必要な操作は `sourceLength`（秒）を引数で受ける。
 */
import { carve, clipsOnTrack, splitOne } from './ops';
import { clipEnd, type Clip, type Sequence } from './types';

const EPS = 0.0005;
/** クリップが縮められる下限（`trimClip` と同じ）。 */
export const MIN_CLIP = 0.1;

const hasSource = (clip: Clip) => clip.kind === 'video' || clip.kind === 'audio';
const speedOf = (clip: Clip) => clip.speed || 1;

/** 素材内で使える範囲の上限（秒）。分からなければ無限大。 */
function sourceLimit(sourceLength: number | undefined): number {
  return sourceLength !== undefined && sourceLength > 0 ? sourceLength : Number.POSITIVE_INFINITY;
}

/** 同じトラックの、`from` 以降に始まるクリップを `delta` だけ動かす。 */
function shiftTrackFrom(clips: Clip[], trackId: string, from: number, delta: number, exceptId?: string): Clip[] {
  return clips.map((c) =>
    c.trackId === trackId && c.id !== exceptId && c.start >= from - EPS
      ? { ...c, start: Math.max(0, c.start + delta) }
      : c,
  );
}

/**
 * 挿入。置く位置にあるクリップは割って、それ以降を `clip.duration` ぶん後ろへ送る。
 * 上書き（`placeClip`）と違い、既存の素材は 1 コマも失われない。
 */
export function insertClip(sequence: Sequence, clip: Clip): Sequence {
  const at = clip.start;
  let clips: Clip[] = [];
  for (const c of sequence.clips) {
    const crosses = c.trackId === clip.trackId && c.start < at - EPS && clipEnd(c) > at + EPS;
    if (crosses) clips.push(...splitOne(c, at));
    else clips.push(c);
  }
  clips = shiftTrackFrom(clips, clip.trackId, at, clip.duration);
  return { ...sequence, clips: [...clips.filter((c) => c.id !== clip.id), clip] };
}

/** 範囲 [from, to) を空ける（隙間が残る）。 */
export function liftRange(sequence: Sequence, trackIds: string[], from: number, to: number): Sequence {
  if (to - from < EPS) return sequence;
  let clips = sequence.clips;
  for (const trackId of trackIds) clips = carve(clips, trackId, from, to, '');
  return { ...sequence, clips };
}

/** 範囲 [from, to) を取り除き、後ろを詰める（隙間は残らない）。 */
export function extractRange(sequence: Sequence, trackIds: string[], from: number, to: number): Sequence {
  if (to - from < EPS) return sequence;
  let clips = sequence.clips;
  for (const trackId of trackIds) {
    clips = carve(clips, trackId, from, to, '');
    clips = shiftTrackFrom(clips, trackId, to, -(to - from));
  }
  return { ...sequence, clips };
}

/** 指定時刻にある隙間を詰める。時刻がクリップの上なら何もしない。 */
export function closeGap(sequence: Sequence, trackId: string, time: number): Sequence {
  const clips = clipsOnTrack(sequence, trackId);
  if (clips.some((c) => time >= c.start - EPS && time < clipEnd(c) - EPS)) return sequence;
  const before = [...clips].reverse().find((c) => clipEnd(c) <= time + EPS);
  const after = clips.find((c) => c.start >= time - EPS);
  if (!after) return sequence;
  const gapStart = before ? clipEnd(before) : 0;
  const gap = after.start - gapStart;
  if (gap < EPS) return sequence;
  return { ...sequence, clips: shiftTrackFrom(sequence.clips, trackId, after.start, -gap) };
}

/**
 * リップルトリム。端を動かしたぶんだけ、同じトラックの後続も一緒に動く。
 * `delta` は秒。left は右へ（縮める）が正、right は右へ（伸ばす）が正。
 * 戻り値は動かした実際の量も含めて Sequence だけ。限度を超える指定は限度まで丸める。
 */
export function rippleTrim(
  sequence: Sequence,
  id: string,
  side: 'left' | 'right',
  delta: number,
  sourceLength?: number,
): Sequence {
  const clip = sequence.clips.find((c) => c.id === id);
  if (!clip) return sequence;
  const speed = speedOf(clip);
  const limit = sourceLimit(sourceLength);

  if (side === 'right') {
    const longest = hasSource(clip) ? (limit - clip.sourceIn) / speed : Number.POSITIVE_INFINITY;
    const next = Math.min(longest, Math.max(MIN_CLIP, clip.duration + delta));
    const change = next - clip.duration;
    if (Math.abs(change) < EPS) return sequence;
    const end = clipEnd(clip);
    const clips = shiftTrackFrom(sequence.clips, clip.trackId, end - EPS, change, clip.id).map((c) =>
      c.id === id ? { ...c, duration: next } : c,
    );
    return { ...sequence, clips };
  }

  // left: 開始位置は動かさず、素材のイン点と尺を変える。後続は尺の変化ぶん動く。
  const earliest = hasSource(clip) ? -clip.sourceIn / speed : Number.NEGATIVE_INFINITY;
  const d = Math.max(earliest, Math.min(clip.duration - MIN_CLIP, delta));
  if (Math.abs(d) < EPS) return sequence;
  const end = clipEnd(clip);
  const clips = shiftTrackFrom(sequence.clips, clip.trackId, end - EPS, -d, clip.id).map((c) =>
    c.id === id
      ? { ...c, duration: c.duration - d, sourceIn: hasSource(c) ? c.sourceIn + d * speed : c.sourceIn }
      : c,
  );
  return { ...sequence, clips };
}

/**
 * ロール。隣り合う 2 クリップの境目だけを動かす（全体の尺は変わらない）。
 * `delta` は秒（右が正）。左の素材が足りない / 右のイン点が負になる / 最短を割る分は丸める。
 */
export function rollEdit(
  sequence: Sequence,
  leftId: string,
  rightId: string,
  delta: number,
  leftSourceLength?: number,
): Sequence {
  const left = sequence.clips.find((c) => c.id === leftId);
  const right = sequence.clips.find((c) => c.id === rightId);
  if (!left || !right || left.trackId !== right.trackId) return sequence;
  if (Math.abs(clipEnd(left) - right.start) > 0.02) return sequence; // 隣り合っていない

  const leftSpeed = speedOf(left);
  const rightSpeed = speedOf(right);
  const leftRoom = hasSource(left) ? (sourceLimit(leftSourceLength) - left.sourceIn) / leftSpeed - left.duration : Number.POSITIVE_INFINITY;
  const rightRoom = hasSource(right) ? right.sourceIn / rightSpeed : Number.POSITIVE_INFINITY;

  const max = Math.min(leftRoom, right.duration - MIN_CLIP);
  const min = -Math.min(rightRoom, left.duration - MIN_CLIP);
  const d = Math.max(min, Math.min(max, delta));
  if (Math.abs(d) < EPS) return sequence;

  return {
    ...sequence,
    clips: sequence.clips.map((c) => {
      if (c.id === leftId) return { ...c, duration: c.duration + d };
      if (c.id === rightId) {
        return {
          ...c,
          start: c.start + d,
          duration: c.duration - d,
          sourceIn: hasSource(c) ? c.sourceIn + d * rightSpeed : c.sourceIn,
        };
      }
      return c;
    }),
  };
}

/**
 * スリップ。クリップの位置と尺は変えず、素材のどこを使うかだけをずらす。
 * `delta` は素材内の秒（正で先の場面へ）。素材の頭・終わりを越える分は丸める。
 */
export function slipClip(sequence: Sequence, id: string, delta: number, sourceLength?: number): Sequence {
  const clip = sequence.clips.find((c) => c.id === id);
  if (!clip || !hasSource(clip)) return sequence;
  const used = clip.duration * speedOf(clip);
  const max = Math.max(0, sourceLimit(sourceLength) - used);
  const next = Math.max(0, Math.min(max, clip.sourceIn + delta));
  if (Math.abs(next - clip.sourceIn) < EPS) return sequence;
  return { ...sequence, clips: sequence.clips.map((c) => (c.id === id ? { ...c, sourceIn: next } : c)) };
}

/**
 * スライド。クリップの中身は変えず、位置だけを動かして、前後のクリップが伸び縮みして埋める。
 * `delta` は秒（右が正）。前のクリップが無い・後ろが無い側は、そのまま動かせる範囲で動く。
 * 前の素材の余り / 後ろの素材の頭の余りと最短尺で丸める。
 */
export function slideClip(
  sequence: Sequence,
  id: string,
  delta: number,
  lengths: { previous?: number } = {},
): Sequence {
  const clip = sequence.clips.find((c) => c.id === id);
  if (!clip) return sequence;
  const siblings = clipsOnTrack(sequence, clip.trackId);
  const prev = siblings.find((c) => Math.abs(clipEnd(c) - clip.start) <= 0.02) ?? null;
  const next = siblings.find((c) => Math.abs(c.start - clipEnd(clip)) <= 0.02) ?? null;
  if (!prev && !next) return sequence;

  let max = Number.POSITIVE_INFINITY; // 右へ動かせる限度
  let min = Number.NEGATIVE_INFINITY; // 左へ動かせる限度（負の値）
  if (prev) {
    const room = hasSource(prev) ? (sourceLimit(lengths.previous) - prev.sourceIn) / speedOf(prev) - prev.duration : Number.POSITIVE_INFINITY;
    max = Math.min(max, room);
    min = Math.max(min, -(prev.duration - MIN_CLIP));
  } else {
    min = Math.max(min, -clip.start);
  }
  if (next) {
    max = Math.min(max, next.duration - MIN_CLIP);
    if (hasSource(next)) min = Math.max(min, -next.sourceIn / speedOf(next));
  }
  const d = Math.max(min, Math.min(max, delta));
  if (Math.abs(d) < EPS) return sequence;

  return {
    ...sequence,
    clips: sequence.clips.map((c) => {
      if (c.id === id) return { ...c, start: c.start + d };
      if (prev && c.id === prev.id) return { ...c, duration: c.duration + d };
      if (next && c.id === next.id) {
        return {
          ...c,
          start: c.start + d,
          duration: c.duration - d,
          sourceIn: hasSource(c) ? c.sourceIn + d * speedOf(c) : c.sourceIn,
        };
      }
      return c;
    }),
  };
}
