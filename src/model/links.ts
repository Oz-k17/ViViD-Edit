/**
 * 映像と音のつなぎ（Premiere のリンクと同じ考え方）。
 *
 * 動画を置くと、映像は映像レーン、音は音声レーンに、同じ `linkId` を持つ 2 本で並ぶ。
 * 映像の側は音を鳴らさず（muted）、音は音声レーンの側だけが鳴らす。
 *
 * つないだ 2 本を「一緒に動かす」のは、操作ごとに書き分けるのではなく、**どの操作のあとにも
 * `reconcileLinks` で揃え直す**形にしてある。移動・トリム・スリップ・スライド・ロール・
 * リップル・分割・削除・上書きの削り取りなど、片方だけが変わったら、もう片方を合わせる:
 *
 * - 片方の時間（位置・長さ・イン点・速度・フェード）が変わった → もう片方を同じにする
 * - 片方が割れた → もう片方も同じ所で割り、割れた同士を新しくつなぐ
 * - 片方が消された → もう片方も消す。ただし上書きで削り取られた・レーンごと消えた場合は、つなぎだけ外す
 *
 * すべて「新しい Sequence を返す純粋関数」。
 */

import { placeClips } from './editOps';
import { uid } from './factory';
import { addTrack, carve, clipsOnTrack, tracksOf } from './ops';
import { clipEnd, type Clip, type Sequence } from './types';

const EPS = 0.0005;

/** 揃える値。素材の同じ所を同じ時刻に鳴らす・映すのに要るもの。 */
const SYNCED = ['start', 'duration', 'sourceIn', 'speed', 'fadeIn', 'fadeOut'] as const;

function sameTiming(a: Clip, b: Clip): boolean {
  return SYNCED.every((key) => Math.abs((a[key] as number) - (b[key] as number)) < EPS);
}

function timingOf(clip: Clip): Pick<Clip, (typeof SYNCED)[number]> {
  return {
    start: clip.start,
    duration: clip.duration,
    sourceIn: clip.sourceIn,
    speed: clip.speed,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
  };
}

const isPicture = (clip: Clip) => clip.kind === 'video';
const isSound = (clip: Clip) => clip.kind === 'audio';

/** つないである相手。無ければ undefined。 */
export function partnerOf(sequence: Sequence, clip: Clip): Clip | undefined {
  if (!clip.linkId) return undefined;
  return sequence.clips.find((c) => c.id !== clip.id && c.linkId === clip.linkId);
}

/** 指定したクリップに、つないである相手を足した id の一覧。 */
export function withPartners(sequence: Sequence, ids: string[]): string[] {
  const links = new Set(sequence.clips.filter((c) => ids.includes(c.id) && c.linkId).map((c) => c.linkId));
  if (links.size === 0) return ids;
  const out = new Set(ids);
  for (const clip of sequence.clips) if (clip.linkId && links.has(clip.linkId)) out.add(clip.id);
  return [...out];
}

/** 映像クリップから、つなぐ音のクリップを作る（まだ並べない）。 */
export function soundFor(picture: Clip, trackId: string, linkId: string): Clip {
  return {
    ...structuredClone(picture),
    id: uid('cl'),
    trackId,
    kind: 'audio',
    // 映像の側にあった音の設定は、音の側へ持っていく。
    muted: picture.muted,
    volume: picture.volume,
    transitionIn: { type: 'none', duration: 0.5 },
    effects: [],
    linkId,
  };
}

/**
 * [from, to) が空いている音声レーン。無ければ足す。
 * 既にある音（BGM など）を上書きして消さないため、埋まっているレーンには置かない。
 */
function freeSoundTrack(sequence: Sequence, from: number, to: number): { sequence: Sequence; trackId: string } {
  const tracks = tracksOf(sequence, 'audio');
  const free = tracks.find((track) =>
    clipsOnTrack(sequence, track.id).every((c) => clipEnd(c) <= from + EPS || c.start >= to - EPS),
  );
  if (free) return { sequence, trackId: free.id };
  const next = addTrack(sequence, 'audio', `A${tracks.length + 1}`);
  return { sequence: next, trackId: tracksOf(next, 'audio')[tracks.length].id };
}

/**
 * 並べ終えた映像クリップ（`ids`）に、音のクリップをつないで音声レーンへ置く。
 * `hasSound` が false を返す素材（音の無い動画）には作らない。
 */
export function attachSound(sequence: Sequence, ids: string[], hasSound: (mediaId: string | null) => boolean): Sequence {
  const pictures = sequence.clips.filter((c) => ids.includes(c.id) && isPicture(c) && !c.linkId && hasSound(c.mediaId));
  if (pictures.length === 0) return sequence;
  // まとめて置いたものは、同じ音声レーンへ続けて置く（ばらばらのレーンに散らばると追いにくい）。
  const from = Math.min(...pictures.map((c) => c.start));
  const to = Math.max(...pictures.map(clipEnd));
  const { sequence: withTrack, trackId } = freeSoundTrack(sequence, from, to);

  const linked = new Map<string, string>();
  const sounds: Clip[] = [];
  for (const picture of pictures) {
    const linkId = uid('lk');
    linked.set(picture.id, linkId);
    sounds.push(soundFor(picture, trackId, linkId));
  }
  const clips = withTrack.clips.map((c) => (linked.has(c.id) ? { ...c, linkId: linked.get(c.id), muted: true } : c));
  return { ...withTrack, clips: [...clips, ...sounds] };
}

/**
 * クリップを並べ（`insert` なら挿入、そうでなければ上書き）、動画には音をつないで音声レーンへ置く。
 * 上書きで削られた既存のつなぎを先に揃えてから、空いている音声レーンを探す
 *（先に探すと、削られる前の古い音が邪魔をして、別のレーンへ逃げてしまう）。
 */
export function placeWithSound(
  sequence: Sequence,
  clips: Clip[],
  insert: boolean,
  hasSound: (mediaId: string | null) => boolean,
): Sequence {
  const placed = reconcileLinks(sequence, placeClips(sequence, clips, insert));
  return attachSound(
    placed,
    clips.map((c) => c.id),
    hasSound,
  );
}

/**
 * 置いてある動画クリップの音を、音声レーンへ分けてつなぐ（つなぎの無い古いクリップ用）。
 */
export function separateSound(sequence: Sequence, id: string): Sequence {
  return attachSound(sequence, [id], () => true);
}

/** つなぎを外す。映像と音は、それぞれ普通のクリップとして残る（音は音声レーンの側が鳴らし続ける）。 */
export function unlinkClips(sequence: Sequence, ids: string[]): Sequence {
  const targets = new Set(withPartners(sequence, ids));
  if (![...targets].some((id) => sequence.clips.find((c) => c.id === id)?.linkId)) return sequence;
  return {
    ...sequence,
    clips: sequence.clips.map((c) => {
      if (!targets.has(c.id) || !c.linkId) return c;
      const { linkId: _linkId, ...rest } = c;
      return rest;
    }),
  };
}

function dropLink(clip: Clip, unmute = false): Clip {
  const { linkId: _linkId, ...rest } = clip;
  return unmute && isPicture(clip) ? { ...rest, muted: false } : rest;
}

/**
 * 片方だけ変わったつなぎを揃え直す。`prev` は操作の前、`next` は操作の後。
 * 揃え直したせいで別のつなぎが削られることがあるので、落ち着くまで数回まわす。
 */
export function reconcileLinks(prev: Sequence, next: Sequence): Sequence {
  if (!next.clips.some((c) => c.linkId) && !prev.clips.some((c) => c.linkId)) return next;
  let current = next;
  for (let round = 0; round < 4; round += 1) {
    const settled = reconcileOnce(prev, current);
    if (settled === current) return current;
    current = settled;
  }
  return current;
}

function reconcileOnce(prev: Sequence, next: Sequence): Sequence {
  const prevById = new Map(prev.clips.map((c) => [c.id, c]));
  const groups = new Map<string, Clip[]>();
  for (const clip of next.clips) {
    if (!clip.linkId) continue;
    const list = groups.get(clip.linkId);
    if (list) list.push(clip);
    else groups.set(clip.linkId, [clip]);
  }
  if (groups.size === 0) return next;

  /** 書き換えたクリップ（id → 新しい値）。null は消す。 */
  const changes = new Map<string, Clip | null>();
  /** 新しく生まれたクリップ（割った相手の片割れ）。 */
  const born: Clip[] = [];
  const trackIds = new Set(next.tracks.map((t) => t.id));

  for (const [linkId, members] of groups) {
    const pictures = members.filter(isPicture).sort((a, b) => a.start - b.start);
    const sounds = members.filter(isSound).sort((a, b) => a.start - b.start);

    // 片方しか残っていない。
    if (pictures.length === 0 || sounds.length === 0) {
      const lost = prev.clips.find((c) => c.linkId === linkId && !members.some((m) => m.id === c.id));
      for (const clip of members) {
        if (!lost || !trackIds.has(lost.trackId)) {
          // 相手のレーンごと消えた: つなぎを外し、映像の音を戻す（音を失わないように）。
          changes.set(clip.id, dropLink(clip, true));
          continue;
        }
        const overwritten = next.clips.some(
          (c) => c.trackId === lost.trackId && c.linkId !== linkId && c.start < clipEnd(lost) - EPS && clipEnd(c) > lost.start + EPS,
        );
        // 上書きで削り取られた: 置き換えたのは自分なので、残った側はそのまま（つなぎだけ外す）。
        // そうでなければ、相手は消された: 一緒に消す。
        changes.set(clip.id, overwritten ? dropLink(clip) : null);
      }
      continue;
    }

    if (pictures.length === 1 && sounds.length === 1) {
      const [picture] = pictures;
      const [sound] = sounds;
      if (sameTiming(picture, sound)) continue;
      const before = { picture: prevById.get(picture.id), sound: prevById.get(sound.id) };
      const pictureMoved = !before.picture || !sameTiming(before.picture, picture);
      const soundMoved = !before.sound || !sameTiming(before.sound, sound);
      // 動いた方に合わせる。両方動いた（＝食い違った）ときは映像に合わせる。
      if (soundMoved && !pictureMoved) changes.set(picture.id, { ...picture, ...timingOf(sound) });
      else changes.set(sound.id, { ...sound, ...timingOf(picture) });
      continue;
    }

    // 割れた側に合わせる。割れた片割れ同士を、新しいつなぎで 1 組ずつ結ぶ。
    if (pictures.length === sounds.length) {
      pictures.forEach((picture, i) => {
        const link = i === 0 ? linkId : uid('lk');
        changes.set(picture.id, { ...picture, linkId: link });
        changes.set(sounds[i].id, { ...sounds[i], ...timingOf(picture), linkId: link });
      });
      continue;
    }
    const [many, single] = pictures.length > 1 && sounds.length === 1 ? [pictures, sounds[0]] : sounds.length > 1 && pictures.length === 1 ? [sounds, pictures[0]] : [null, null];
    if (!many || !single) {
      // 数が合わない割れ方（両方が別々の所で割れた）は、揃えようがない。つなぎを外す。
      for (const clip of members) changes.set(clip.id, dropLink(clip));
      continue;
    }
    many.forEach((piece, i) => {
      const link = i === 0 ? linkId : uid('lk');
      changes.set(piece.id, { ...piece, linkId: link });
      const twin: Clip = { ...structuredClone(single), ...timingOf(piece), linkId: link };
      if (i === 0) changes.set(single.id, twin);
      else born.push({ ...twin, id: uid('cl'), transitionIn: { type: 'none', duration: 0.5 } });
    });
  }

  if (changes.size === 0 && born.length === 0) return next;

  // 動かした・生まれたクリップの下にあった別のクリップは、上書きと同じに削り取る
  //（動かした同士は削り合わない。リップルで一緒にずれたものを、互いに削ってしまうため）。
  const moved: Clip[] = [...born];
  const movedIds = new Set(born.map((c) => c.id));
  for (const [id, clip] of changes) {
    if (!clip) continue;
    const before = next.clips.find((c) => c.id === id);
    if (before && sameTiming(before, clip) && before.trackId === clip.trackId) continue;
    moved.push(clip);
    movedIds.add(id);
  }
  let others = next.clips
    .filter((c) => changes.get(c.id) !== null)
    .map((c) => (changes.has(c.id) && !movedIds.has(c.id) ? (changes.get(c.id) as Clip) : c))
    .filter((c) => !movedIds.has(c.id));
  for (const clip of moved) others = carve(others, clip.trackId, clip.start, clipEnd(clip), clip.id);
  return { ...next, clips: [...others, ...moved] };
}
