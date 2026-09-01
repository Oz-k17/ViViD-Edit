/**
 * タイムライン操作。すべて「新しい Sequence を返す」純粋関数にしてあるので、
 * 履歴（元に戻す / やり直す）にそのまま載る。
 */

import { baseClip, uid } from './factory';
import { clipEnd, type Clip, type Sequence, type Track, type TrackKind } from './types';

const EPS = 0.0005;

export function tracksOf(sequence: Sequence, kind: TrackKind): Track[] {
  return sequence.tracks.filter((t) => t.kind === kind);
}

export function trackById(sequence: Sequence, id: string): Track | undefined {
  return sequence.tracks.find((t) => t.id === id);
}

export function clipsOnTrack(sequence: Sequence, trackId: string): Clip[] {
  return sequence.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function clipById(sequence: Sequence, id: string): Clip | undefined {
  return sequence.clips.find((c) => c.id === id);
}

export function sequenceDuration(sequence: Sequence): number {
  return sequence.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

/** そのトラックで指定時刻に乗っているクリップ。 */
export function clipAtTime(sequence: Sequence, trackId: string, time: number): Clip | null {
  return (
    sequence.clips.find((c) => c.trackId === trackId && time >= c.start - EPS && time < clipEnd(c) - EPS) ?? null
  );
}

/** 同じトラックで、指定クリップの直前に隙間なく接しているクリップ。 */
export function previousAdjacent(sequence: Sequence, clip: Clip): Clip | null {
  return sequence.clips.find((c) => c.trackId === clip.trackId && Math.abs(clipEnd(c) - clip.start) < 0.02) ?? null;
}

function splitOne(clip: Clip, time: number): Clip[] {
  const left: Clip = { ...structuredClone(clip), duration: time - clip.start, fadeOut: 0 };
  const right: Clip = {
    ...structuredClone(clip),
    id: uid('cl'),
    start: time,
    duration: clipEnd(clip) - time,
    sourceIn: clip.sourceIn + (time - clip.start) * (clip.speed || 1),
    fadeIn: 0,
    transitionIn: { type: 'none', duration: 0.5 },
  };
  return [left, right];
}

/**
 * 指定範囲に重なる既存クリップを削り取る（Premiere の上書き配置と同じ挙動）。
 * 完全に飲み込まれたものは消え、内側に穴が開く場合は 2 つに割れる。
 */
function carve(clips: Clip[], trackId: string, from: number, to: number, exceptId: string): Clip[] {
  const out: Clip[] = [];
  for (const clip of clips) {
    if (clip.trackId !== trackId || clip.id === exceptId) {
      out.push(clip);
      continue;
    }
    const start = clip.start;
    const end = clipEnd(clip);
    if (end <= from + EPS || start >= to - EPS) {
      out.push(clip);
      continue;
    }
    if (start >= from - EPS && end <= to + EPS) continue; // 丸ごと飲み込まれる
    if (start < from - EPS && end > to + EPS) {
      const [left, right] = splitOne(clip, from);
      out.push({ ...left, duration: from - start });
      const tail = splitOne(right, to)[1];
      out.push(tail);
      continue;
    }
    if (start < from - EPS) {
      out.push({ ...clip, duration: from - start });
    } else {
      const delta = to - start;
      out.push({
        ...clip,
        start: to,
        duration: end - to,
        sourceIn: clip.sourceIn + delta * (clip.speed || 1),
      });
    }
  }
  return out;
}

/** クリップを配置する（既にあるものは上書き）。 */
export function placeClip(sequence: Sequence, clip: Clip): Sequence {
  const carved = carve(sequence.clips, clip.trackId, clip.start, clipEnd(clip), clip.id);
  return { ...sequence, clips: [...carved.filter((c) => c.id !== clip.id), clip] };
}

/** 選択中のクリップをまとめて時間 / トラック方向へ動かす。 */
export function moveClips(
  sequence: Sequence,
  ids: string[],
  deltaTime: number,
  deltaTrack: number,
): Sequence {
  const moving = sequence.clips.filter((c) => ids.includes(c.id));
  if (moving.length === 0) return sequence;

  const kindTracks = (kind: TrackKind) => tracksOf(sequence, kind);
  const earliest = Math.min(...moving.map((c) => c.start));
  const shift = Math.max(deltaTime, -earliest);

  const moved: Clip[] = moving.map((clip) => {
    const track = trackById(sequence, clip.trackId);
    if (!track) return clip;
    const siblings = kindTracks(track.kind);
    const index = siblings.findIndex((t) => t.id === track.id);
    const nextIndex = Math.max(0, Math.min(siblings.length - 1, index + deltaTrack));
    return { ...clip, start: Math.max(0, clip.start + shift), trackId: siblings[nextIndex].id };
  });

  let clips = sequence.clips.filter((c) => !ids.includes(c.id));
  for (const clip of moved) {
    clips = carve(clips, clip.trackId, clip.start, clipEnd(clip), clip.id);
  }
  return { ...sequence, clips: [...clips, ...moved] };
}

/** 端をドラッグしてトリムする。left は素材のイン点、right は尺を変える。 */
export function trimClip(sequence: Sequence, id: string, side: 'left' | 'right', deltaSeconds: number): Sequence {
  const clip = clipById(sequence, id);
  if (!clip) return sequence;
  const speed = clip.speed || 1;
  const minimum = 0.1;

  let next: Clip;
  if (side === 'left') {
    const limit = clip.kind === 'text' || clip.kind === 'image' ? Number.NEGATIVE_INFINITY : -clip.sourceIn / speed;
    const delta = Math.max(Math.max(limit, -clip.start), Math.min(clip.duration - minimum, deltaSeconds));
    next = {
      ...clip,
      start: clip.start + delta,
      duration: clip.duration - delta,
      sourceIn: clip.kind === 'text' || clip.kind === 'image' ? clip.sourceIn : clip.sourceIn + delta * speed,
    };
  } else {
    next = { ...clip, duration: Math.max(minimum, clip.duration + deltaSeconds) };
  }

  const carved = carve(sequence.clips, next.trackId, next.start, clipEnd(next), next.id);
  return { ...sequence, clips: carved.map((c) => (c.id === id ? next : c)) };
}

/** 再生ヘッド位置で分割。ids を渡すとその中だけ、渡さなければ全トラックで割る。 */
export function splitAt(sequence: Sequence, time: number, ids?: string[]): Sequence {
  const clips: Clip[] = [];
  let changed = false;
  for (const clip of sequence.clips) {
    const inside = time > clip.start + 0.05 && time < clipEnd(clip) - 0.05;
    const targeted = !ids || ids.length === 0 || ids.includes(clip.id);
    if (inside && targeted) {
      clips.push(...splitOne(clip, time));
      changed = true;
    } else {
      clips.push(clip);
    }
  }
  return changed ? { ...sequence, clips } : sequence;
}

/** 削除。ripple = true なら同じトラックの後続を詰める。 */
export function removeClips(sequence: Sequence, ids: string[], ripple: boolean): Sequence {
  const targets = sequence.clips.filter((c) => ids.includes(c.id));
  if (targets.length === 0) return sequence;
  let clips = sequence.clips.filter((c) => !ids.includes(c.id));

  if (ripple) {
    // 後ろから詰めていくと、複数削除でもズレない。
    const ordered = [...targets].sort((a, b) => b.start - a.start);
    for (const gone of ordered) {
      clips = clips.map((c) =>
        c.trackId === gone.trackId && c.start >= clipEnd(gone) - EPS
          ? { ...c, start: Math.max(0, c.start - gone.duration) }
          : c,
      );
    }
  }
  return { ...sequence, clips };
}

/** 吸着候補（0・再生ヘッド・全クリップの端）。 */
export function snapCandidates(sequence: Sequence, playhead: number, excludeIds: string[]): number[] {
  const points = [0, playhead];
  for (const clip of sequence.clips) {
    if (excludeIds.includes(clip.id)) continue;
    points.push(clip.start, clipEnd(clip));
  }
  return points;
}

export function snapTime(value: number, candidates: number[], threshold: number): number {
  let best = value;
  let bestDistance = threshold;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export function addTrack(sequence: Sequence, kind: TrackKind, name: string): Sequence {
  const track: Track = { id: uid('tr'), kind, name, muted: false, hidden: false, locked: false };
  return { ...sequence, tracks: [...sequence.tracks, track] };
}

export function removeTrack(sequence: Sequence, trackId: string): Sequence {
  return {
    ...sequence,
    tracks: sequence.tracks.filter((t) => t.id !== trackId),
    clips: sequence.clips.filter((c) => c.trackId !== trackId),
  };
}

export { baseClip };
