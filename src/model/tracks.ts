/**
 * タイムラインの段（トラック）を足す・消す。
 *
 * 段は、映像・テロップ・音の 3 種類。足した映像の段は、いちばん上に重なる（並びの最後が上に描かれる）。
 * 名前は種類ごとの連番（V3・T2・A3…）。途中を消していても、いちばん大きい番号の次にする（同じ名前が 2 つにならないように）。
 * 消せるのは、クリップが 1 つも無い段だけ（中身ごと消すと、気づかずに編集を失うため）。種類ごとに最後の 1 段は残す。
 */

import { uid } from './factory';
import type { Sequence, Track, TrackKind } from './types';

const PREFIX: Record<TrackKind, string> = { video: 'V', text: 'T', audio: 'A' };

/** 種類ごとの次の名前（V1・V2 があれば V3）。 */
export function newTrackName(tracks: Track[], kind: TrackKind): string {
  const prefix = PREFIX[kind];
  let max = 0;
  for (const t of tracks) {
    if (t.kind !== kind) continue;
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(t.name);
    max = Math.max(max, m ? Number(m[1]) : 0);
  }
  return `${prefix}${Math.max(max, tracks.filter((t) => t.kind === kind).length) + 1}`;
}

/** 段を 1 つ足す。足した段の id も返す。 */
export function appendTrack(sequence: Sequence, kind: TrackKind): { sequence: Sequence; trackId: string } {
  const track: Track = { id: uid('tr'), kind, name: newTrackName(sequence.tracks, kind), muted: false, hidden: false, locked: false };
  return { sequence: { ...sequence, tracks: [...sequence.tracks, track] }, trackId: track.id };
}

/** この段を消せるか（空で、同じ種類の段がほかにもある）。消せない理由も返す。 */
export function trackRemovable(sequence: Sequence, trackId: string): { ok: boolean; reason?: string } {
  const track = sequence.tracks.find((t) => t.id === trackId);
  if (!track) return { ok: false, reason: '段が見つかりません' };
  if (sequence.clips.some((c) => c.trackId === trackId)) return { ok: false, reason: 'クリップがある段は消せません（先にクリップを動かすか消してください）' };
  if (sequence.tracks.filter((t) => t.kind === track.kind).length <= 1) return { ok: false, reason: 'この種類の段は、最後の 1 つなので消せません' };
  return { ok: true };
}

/** 空の段を消す（消せないときは、そのまま返す）。 */
export function removeEmptyTrack(sequence: Sequence, trackId: string): Sequence {
  if (!trackRemovable(sequence, trackId).ok) return sequence;
  return { ...sequence, tracks: sequence.tracks.filter((t) => t.id !== trackId) };
}
