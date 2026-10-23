/**
 * クリップをまとめる（ネスト）と、切ったクリップを繋ぐ。
 *
 * まとめたクリップ（kind 'nest'）は、中身を小さなシーケンスとして `nested` に持つ。
 * タイムラインには 1 本に見え、ダブルクリックで中に入って編集する（`nestPath` は store が持つ）。
 *
 * 再生・描画・書き出しは、まとめたクリップを知らない。使う前に `flattenNests` で展開して、
 * ふつうのクリップの並びにしてから渡す（描く順は、まとめたクリップのあったトラックの位置に入る）。
 *
 * すべて「新しい Sequence を返す純粋関数」。
 */

import { uid } from './factory';
import { clipsOnTrack } from './ops';
import { clipEnd, type Clip, type Sequence, type Track } from './types';

const EPS = 0.0005;

/** 中身の長さ（いちばん後ろで終わるクリップの終わり）。 */
export function nestedLength(clip: Clip): number {
  return clip.nested ? clip.nested.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0) : 0;
}

/**
 * 選んだクリップを 1 本にまとめる。映像と音をつないであれば、相手も一緒に入れる（片方だけ入れると、つなぎが切れる）。
 * まとめたクリップは、選んだ中でいちばん下の映像トラックに置く。中身のトラックは、使っていたものだけを持っていく。
 * 映像が 1 本も無いときや、選んだのが 1 本だけのときは、まとめない（同じ Sequence を返す）。
 */
export function nestClips(
  sequence: Sequence,
  picked: string[],
  name = 'まとめたクリップ',
  /** まとめたクリップの id。先に決めておけば、呼んだ側がすぐに選べる。 */
  presetId?: string,
): { sequence: Sequence; id: string | null } {
  const links = new Set(sequence.clips.filter((c) => picked.includes(c.id) && c.linkId).map((c) => c.linkId));
  const ids = new Set(sequence.clips.filter((c) => picked.includes(c.id) || (c.linkId && links.has(c.linkId))).map((c) => c.id));
  const members = sequence.clips.filter((c) => ids.has(c.id));
  if (members.length < 2) return { sequence, id: null };

  const trackOrder = sequence.tracks.map((t) => t.id);
  const home = sequence.tracks.find((t) => t.kind === 'video' && members.some((c) => c.trackId === t.id));
  if (!home) return { sequence, id: null };

  const from = Math.min(...members.map((c) => c.start));
  const to = Math.max(...members.map(clipEnd));
  const used = new Set(members.map((c) => c.trackId));
  const nested: Sequence = {
    ...sequence,
    tracks: sequence.tracks.filter((t) => used.has(t.id)).map((t) => ({ ...t })),
    clips: members
      .map((c) => ({ ...c, start: c.start - from }))
      .sort((a, b) => trackOrder.indexOf(a.trackId) - trackOrder.indexOf(b.trackId) || a.start - b.start),
  };
  const id = presetId ?? uid('cl');
  const nest: Clip = {
    id,
    trackId: home.id,
    kind: 'nest',
    mediaId: null,
    start: from,
    duration: to - from,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    muted: false,
    loop: false,
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotate: 0,
    fit: 'cover',
    bgBlur: { enabled: false, strength: 0.05, zoom: 1.15 },
    crop: { enabled: false, sx: 0, sy: 0, sw: 1, sh: 1, dx: 0, dy: 0, dw: 1, dh: 1 },
    effects: [],
    fadeIn: 0,
    fadeOut: 0,
    transitionIn: { type: 'none', duration: 0.5 },
    text: null,
    nested,
    name,
  };
  const clips = [...sequence.clips.filter((c) => !ids.has(c.id)), nest];
  // 中へ移したことで空になったトラックは片付ける（3 分割で足した V3 など。1 本にまとめたのに、空の段が並んで見えないように）。
  // ただし、映像・音声それぞれ 2 本までは残す（素材を置く先として、いつもあるものとして扱われている）。
  let tracks = sequence.tracks;
  for (const track of [...sequence.tracks].reverse()) {
    if (track.id === home.id || !used.has(track.id) || track.kind === 'text') continue;
    if (clips.some((c) => c.trackId === track.id)) continue;
    if (tracks.filter((t) => t.kind === track.kind).length <= 2) continue;
    tracks = tracks.filter((t) => t.id !== track.id);
  }
  return { sequence: { ...sequence, tracks, clips }, id };
}

/** まとめたクリップの中身を、時刻を合わせて元のシーケンスへ出す（トラックは同じ id のものへ。無ければ足す）。 */
export function unnestClip(sequence: Sequence, id: string): Sequence {
  const nest = sequence.clips.find((c) => c.id === id && c.kind === 'nest');
  if (!nest?.nested) return sequence;
  const tracks: Track[] = [...sequence.tracks];
  for (const track of nest.nested.tracks) {
    if (!tracks.some((t) => t.id === track.id)) tracks.push({ ...track });
  }
  const placed = placedClips(nest, (c) => c.trackId, (c) => c.id, (c) => c.linkId);
  return { ...sequence, tracks, clips: [...sequence.clips.filter((c) => c.id !== id), ...placed] };
}

/**
 * まとめたクリップの中身を、外のタイムラインの時刻へ置き直した並び。
 * まとめたクリップの長さで切り詰める（左右を詰めてあれば、中身もその範囲だけ）。
 */
function placedClips(
  nest: Clip,
  trackOf: (c: Clip) => string,
  idOf: (c: Clip) => string,
  linkOf: (c: Clip) => string | undefined,
): Clip[] {
  const inner = nest.nested;
  if (!inner) return [];
  const from = nest.start;
  const to = clipEnd(nest);
  const out: Clip[] = [];
  for (const c of inner.clips) {
    let start = nest.start + (c.start - nest.sourceIn);
    let duration = c.duration;
    let sourceIn = c.sourceIn;
    const hasSource = c.kind === 'video' || c.kind === 'audio';
    if (start < from - EPS) {
      const cut = from - start;
      duration -= cut;
      if (hasSource) sourceIn += cut * (c.speed || 1);
      start = from;
    }
    if (start + duration > to + EPS) duration = to - start;
    if (duration <= EPS) continue;
    const link = linkOf(c);
    const placed: Clip = { ...c, id: idOf(c), trackId: trackOf(c), start, duration, sourceIn };
    if (link) placed.linkId = link;
    else delete placed.linkId;
    out.push(placed);
  }
  return out;
}

const flatCache = new WeakMap<Sequence, Sequence>();

/**
 * まとめたクリップを展開した、ふつうのクリップだけのシーケンス。再生・描画・書き出しはこれを使う。
 * 中のトラックは、まとめたクリップのあったトラックのすぐ後ろ（＝その上の重なり）に入れる。
 * まとめたクリップが無ければ、同じものを返す（作り直さない）。
 */
export function flattenNests(sequence: Sequence): Sequence {
  if (!sequence.clips.some((c) => c.kind === 'nest')) return sequence;
  const cached = flatCache.get(sequence);
  if (cached) return cached;

  const tracks: Track[] = [];
  const clips: Clip[] = [];
  for (const track of sequence.tracks) {
    tracks.push(track);
    for (const clip of clipsOnTrack(sequence, track.id)) {
      if (clip.kind !== 'nest') {
        clips.push(clip);
        continue;
      }
      if (!clip.nested) continue;
      const inner = flattenNests(clip.nested);
      const virtual = new Map<string, string>();
      for (const innerTrack of inner.tracks) {
        const id = `${clip.id}/${innerTrack.id}`;
        virtual.set(innerTrack.id, id);
        tracks.push({
          ...innerTrack,
          id,
          // 外のトラックを隠す・消音すると、中身も同じに。
          hidden: innerTrack.hidden || track.hidden,
          muted: innerTrack.muted || track.muted,
        });
      }
      clips.push(
        ...placedClips(
          { ...clip, nested: inner },
          (c) => virtual.get(c.trackId) ?? c.trackId,
          (c) => `${clip.id}/${c.id}`,
          (c) => (c.linkId ? `${clip.id}/${c.linkId}` : undefined),
        ),
      );
    }
  }
  const flat = { ...sequence, tracks, clips };
  flatCache.set(sequence, flat);
  return flat;
}

/** ネストの道筋（外から順に、まとめたクリップの id）をたどった中身。たどれなければ null。 */
export function sequenceAt(root: Sequence, path: string[]): Sequence | null {
  let current: Sequence = root;
  for (const id of path) {
    const nest = current.clips.find((c) => c.id === id && c.kind === 'nest');
    if (!nest?.nested) return null;
    current = nest.nested;
  }
  return current;
}

/** 道筋の先の中身を `fn` で書き換えた、外側のシーケンス。たどれなければ元のまま。 */
export function updateAt(root: Sequence, path: string[], fn: (inner: Sequence) => Sequence): Sequence {
  if (path.length === 0) return fn(root);
  const [head, ...rest] = path;
  const nest = root.clips.find((c) => c.id === head && c.kind === 'nest');
  if (!nest?.nested) return root;
  const nested = updateAt(nest.nested, rest, fn);
  if (nested === nest.nested) return root;
  // 中身の長さが変わったら、まとめたクリップもそれに合わせる（中で伸ばしたのに、外で切れて見えないように）。
  // ただし外で終わりを詰めてあったら、その長さは保つ（中身が短くなったときだけ縮める）。
  const lengthOf = (seq: Sequence) => seq.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  const before = lengthOf(nest.nested) - nest.sourceIn;
  const after = Math.max(0.1, lengthOf(nested) - nest.sourceIn);
  const followed = Math.abs(nest.duration - before) < 0.02;
  const duration = followed ? after : Math.min(nest.duration, after);
  return {
    ...root,
    clips: root.clips.map((c) => (c.id === head ? { ...c, nested, duration } : c)),
  };
}

/** 2 本が「切ったものを繋ぐ」で 1 本に戻せるか（同じ素材・同じ種類・隣り合う・素材の時間も続いている）。 */
export function canJoin(a: Clip, b: Clip): boolean {
  if (a.kind !== b.kind || a.trackId !== b.trackId || a.kind === 'text' || a.kind === 'nest') return false;
  if (a.mediaId !== b.mediaId || !a.mediaId) return false;
  if (Math.abs(clipEnd(a) - b.start) > 0.02) return false;
  if (a.kind === 'image') return true;
  if (Math.abs((a.speed || 1) - (b.speed || 1)) > EPS) return false;
  // 切った所で、素材の時間がつながっていること（間を消したものを繋ぐと、話が飛ぶ）。
  return Math.abs(a.sourceIn + a.duration * (a.speed || 1) - b.sourceIn) < 0.05;
}

/**
 * 選んだクリップのうち、隣り合って続いているものを 1 本に繋ぐ（分割を元に戻す）。
 * 映像と音をつないであれば、相手どうしも一緒に繋ぐ。繋げるものが無ければ同じ Sequence を返す。
 */
export function joinClips(sequence: Sequence, picked: string[]): Sequence {
  const links = new Set(sequence.clips.filter((c) => picked.includes(c.id) && c.linkId).map((c) => c.linkId));
  const ids = new Set(sequence.clips.filter((c) => picked.includes(c.id) || (c.linkId && links.has(c.linkId))).map((c) => c.id));
  const removed = new Set<string>();
  const changed = new Map<string, Clip>();
  for (const track of sequence.tracks) {
    const run = clipsOnTrack(sequence, track.id).filter((c) => ids.has(c.id));
    let head = null as Clip | null;
    for (const clip of run) {
      if (head && canJoin(head, clip)) {
        // 前の 1 本を伸ばして、後ろの 1 本を消す。終わりのフェードは後ろのものを引き継ぐ。
        head = { ...head, duration: clipEnd(clip) - head.start, fadeOut: clip.fadeOut };
        changed.set(head.id, head);
        removed.add(clip.id);
      } else {
        head = clip;
      }
    }
  }
  if (removed.size === 0) return sequence;
  return {
    ...sequence,
    clips: sequence.clips.filter((c) => !removed.has(c.id)).map((c) => changed.get(c.id) ?? c),
  };
}
