/**
 * クリップのコピー・貼り付け・複製。
 *
 * コピーしたものは「いちばん早い頭を 0 秒にそろえたクリップの束」として持つ。
 * 貼るときに id とつなぎ（linkId）を振り直すので、同じ束を何度貼っても互いに混ざらない。
 * つないだ映像と音は、片方だけ選んでいても 2 本そろえて運ぶ。
 *
 * すべて「新しい Sequence を返す純粋関数」。
 */

import { placeClips } from './editOps';
import { uid } from './factory';
import { withPartners } from './links';
import { tracksOf } from './ops';
import { clipEnd, type Clip, type Sequence, type TrackKind } from './types';

/** コピーしたクリップの束。`start` は束の頭からの秒。 */
export interface ClipBundle {
  clips: Clip[];
  /** 元のトラックの種類（貼る先に同じトラックが無いとき、同じ種類のトラックを探すのに使う）。 */
  trackKinds: Record<string, TrackKind>;
  /** 束の長さ（秒）。 */
  duration: number;
}

/** 選んだクリップ（と、つないである相手）を束にする。選んだものが無ければ null。 */
export function copyClips(sequence: Sequence, ids: string[]): ClipBundle | null {
  const all = new Set(withPartners(sequence, ids));
  const picked = sequence.clips.filter((c) => all.has(c.id));
  if (picked.length === 0) return null;
  const base = Math.min(...picked.map((c) => c.start));
  const trackKinds: Record<string, TrackKind> = {};
  for (const clip of picked) {
    const track = sequence.tracks.find((t) => t.id === clip.trackId);
    if (track) trackKinds[clip.trackId] = track.kind;
  }
  const clips = picked
    .map((c) => ({ ...structuredClone(c), start: c.start - base }))
    .sort((a, b) => a.start - b.start);
  return { clips, trackKinds, duration: Math.max(...clips.map(clipEnd)) };
}

/** まとめたクリップの中身まで、id とつなぎを振り直す（同じ id が 2 か所にあると、選択や編集が混ざる）。 */
function renew(clip: Clip, links: Map<string, string>): Clip {
  const next: Clip = { ...structuredClone(clip), id: uid('cl') };
  if (clip.linkId) {
    if (!links.has(clip.linkId)) links.set(clip.linkId, uid('lk'));
    next.linkId = links.get(clip.linkId);
  }
  if (next.nested) {
    const inner = new Map<string, string>();
    next.nested = { ...next.nested, clips: next.nested.clips.map((c) => renew(c, inner)) };
  }
  return next;
}

/** 貼る先のトラック。元のトラックがあればそこ、無ければ同じ種類のいちばん手前。どちらも無ければ null。 */
function targetTrack(sequence: Sequence, bundle: ClipBundle, trackId: string): string | null {
  if (sequence.tracks.some((t) => t.id === trackId)) return trackId;
  const kind = bundle.trackKinds[trackId];
  return (kind && tracksOf(sequence, kind)[0]?.id) || null;
}

/**
 * 束を `at` 秒から貼る。`insert` なら後ろを送って差し込み、そうでなければ上書き。
 * 貼ったクリップの id も返す（貼ったものを選んでおくため）。
 */
export function pasteClips(
  sequence: Sequence,
  bundle: ClipBundle,
  at: number,
  insert: boolean,
): { sequence: Sequence; ids: string[] } {
  const links = new Map<string, string>();
  const fresh: Clip[] = [];
  for (const clip of bundle.clips) {
    const trackId = targetTrack(sequence, bundle, clip.trackId);
    if (!trackId) continue;
    fresh.push({ ...renew(clip, links), trackId, start: Math.max(0, at) + clip.start });
  }
  if (fresh.length === 0) return { sequence, ids: [] };
  // 相手を置けなかった（貼る先に音声トラックが無いなど）つなぎは、外しておく。
  const counts = new Map<string, number>();
  for (const clip of fresh) if (clip.linkId) counts.set(clip.linkId, (counts.get(clip.linkId) ?? 0) + 1);
  const clips = fresh.map((clip) => {
    if (!clip.linkId || (counts.get(clip.linkId) ?? 0) > 1) return clip;
    const { linkId: _linkId, ...rest } = clip;
    return rest;
  });
  return { sequence: placeClips(sequence, clips, insert), ids: clips.map((c) => c.id) };
}

/**
 * 選んだクリップを、そのすぐ後ろへ複製する。後ろのクリップは送る（何も上書きしない）。
 */
export function duplicateClips(sequence: Sequence, ids: string[]): { sequence: Sequence; ids: string[] } {
  const bundle = copyClips(sequence, ids);
  if (!bundle) return { sequence, ids: [] };
  const all = new Set(withPartners(sequence, ids));
  const end = Math.max(...sequence.clips.filter((c) => all.has(c.id)).map(clipEnd));
  return pasteClips(sequence, bundle, end, true);
}
