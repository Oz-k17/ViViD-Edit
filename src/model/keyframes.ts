/**
 * キーフレーム: クリップの大きさ・位置・濃さ・回転を、時間とともに動かす。
 *
 * 持ち方と読み方は `lab/keyframe/`（`value.ts` と `track.ts`）で測って決めたものを、そのまま持ってきた。
 * 要点（表は `lab/keyframe/README.md`）:
 *
 * - 打点の秒は「何の秒か」を値ごとに持つ。映像と音は素材の秒（`source`）、静止画とテロップは
 *   クリップの頭からの秒（`local`）、尺いっぱいに動かす型は尺の割合（`fraction`）。
 *   こうすると、詰める・割る・速さを変える、どの編集の操作にも 1 行も足さずに打点が付いてくる
 *   （`ops.ts` はクリップを `structuredClone` で丸ごと写す）。
 * - 打点を全部消しても、人が選んだ軸は畳んだ形（`{ base, v }`）で覚えておく。
 * - 繋ぎ方は「手前の打点」に持たせる。打点を消したときに、どの繋ぎ方が残るかが一意に決まる。
 *
 * lab と違う所が 1 つある。lab は `opacity` などの型そのものを「数か打点の列」に変える案だったが、
 * 本体ではその値を読む所が 150 か所を超えるので、**打点はクリップの `anim` に別に持たせ、
 * 描く直前に `animatedClipAt()` で素の数へ戻す**形にした。動かしていないクリップは `anim` が無く、
 * 読む側の費用も JSON の大きさも、これまでと 1 文字も変わらない。
 *
 * 繋ぎ方のうち「行き過ぎて戻る」「ばね」「はずむ」は、openreel-video
 * （MIT, Augustus Otu and Contributors）の `easing-functions.ts` の式をそのまま使っている。
 */

import type { Clip, ClipKind } from './types';

/** 打点から次の打点までの繋ぎ方。 */
export type Ease = 'hold' | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'back' | 'elastic' | 'bounce';

export const EASE_LABELS: Record<Ease, string> = {
  linear: '一定の速さ',
  easeInOut: 'ゆっくり始めて、ゆっくり止まる',
  easeOut: 'だんだん遅く',
  easeIn: 'だんだん速く',
  back: '少し行き過ぎて戻る',
  elastic: 'ばねのように揺れて止まる',
  bounce: 'はずんで止まる',
  hold: '動かさず、次の点で切り替える',
};

export interface Keyframe {
  /** 時刻（秒）。何の秒かは `TrackBase` が決める。 */
  t: number;
  v: number;
  /** この打点から次の打点までの繋ぎ方（省略時は一定の速さ）。 */
  ease?: Ease;
}

/** 打点の秒を何として読むか。 */
export type TrackBase = 'source' | 'local' | 'fraction';

/** 打点を持つ形。`base` を省いたら `source`。 */
export interface KeyedTrack {
  base?: TrackBase;
  keys: Keyframe[];
}

/** 打点を持たないが、人が選んだ時間軸と値を覚えている形。 */
export interface StillTrack {
  base: TrackBase;
  v: number;
  keys?: undefined;
}

export type AnimTrack = KeyedTrack | StillTrack;

/** 動かせる値。 */
export type AnimProp = 'scale' | 'x' | 'y' | 'opacity' | 'rotate';
export const ANIM_PROPS: AnimProp[] = ['scale', 'x', 'y', 'opacity', 'rotate'];

export type ClipAnim = Partial<Record<AnimProp, AnimTrack>>;

/** 打点が無いときの「無い」の意味。拡大と濃さで 0 を既定にすると、絵が消える。 */
const FALLBACK: Record<AnimProp, number> = { scale: 1, x: 0, y: 0, opacity: 1, rotate: 0 };

// ---------- 並べ方と、1 コマぶんの取り出し（lab/keyframe/src/value.ts） ----------

/** 打点の列を整える。時刻の順に並べ、同じ時刻は後から来たほうを残す。数でない打点は捨てる。 */
export function normalizeKeys(keys: readonly Keyframe[]): Keyframe[] {
  const clean = keys.filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v));
  const sorted = clean
    .map((k, i) => ({ k, i }))
    .sort((a, b) => (a.k.t === b.k.t ? a.i - b.i : a.k.t - b.k.t))
    .map(({ k }) => k);
  const out: Keyframe[] = [];
  for (const k of sorted) {
    const tidy = { t: k.t, v: k.v, ...(k.ease && k.ease !== 'linear' ? { ease: k.ease } : {}) };
    if (out.length > 0 && out[out.length - 1].t === k.t) out[out.length - 1] = tidy;
    else out.push(tidy);
  }
  return out;
}

// openreel-video の easing-functions.ts から（MIT）。
const C1 = 1.70158;
const C3 = C1 + 1;
const C4 = (2 * Math.PI) / 3;
function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/** 0〜1 の進み具合を繋ぎ方で曲げる。`easeOut` は本体のテロップと同じ形（`1-(1-u)^3`）。 */
export function easeAt(ease: Ease | undefined, u: number): number {
  switch (ease) {
    case 'hold':
      return 0;
    case 'easeIn':
      return u * u * u;
    case 'easeOut':
      return 1 - (1 - u) ** 3;
    case 'easeInOut':
      return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    case 'back':
      return 1 + C3 * (u - 1) ** 3 + C1 * (u - 1) ** 2;
    case 'elastic':
      return u <= 0 ? 0 : u >= 1 ? 1 : 2 ** (-10 * u) * Math.sin((u * 10 - 0.75) * C4) + 1;
    case 'bounce':
      return bounceOut(u);
    default:
      return u;
  }
}

/** 時刻 `t` の手前にある打点の番号（最初より前なら -1）。列は並んでいること。 */
function findSegment(keys: readonly Keyframe[], t: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 打点の列から、時刻 `t` の値。端より外はその打点の値を保つ。 */
export function sampleKeys(keys: readonly Keyframe[], t: number, fallback: number): number {
  if (keys.length === 0) return fallback;
  if (keys.length === 1 || Number.isNaN(t) || t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  const i = findSegment(keys, t);
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  return a.v + (b.v - a.v) * easeAt(a.ease, (t - a.t) / span);
}

// ---------- クリップの上で読む（lab/keyframe/src/track.ts） ----------

interface ClipTiming {
  kind: ClipKind;
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
}

/** 種類ごとの既定の時間軸。素材のコマがある映像と音は `source`、それ以外は `local`。 */
export function defaultTrackBase(kind: ClipKind): TrackBase {
  return kind === 'video' || kind === 'audio' ? 'source' : 'local';
}

export const isKeyedTrack = (track: AnimTrack | undefined): track is KeyedTrack =>
  !!track && Array.isArray((track as KeyedTrack).keys);

/** その値をいま何の秒として読むか。 */
export function trackBaseIn(clip: ClipTiming, track: AnimTrack | undefined): TrackBase {
  return track ? (track.base ?? 'source') : defaultTrackBase(clip.kind);
}

/** タイムラインの時刻 → 打点の時刻（頭で丸めない。頭より前に居る打点もつまめるように）。 */
export function keyTimeIn(base: TrackBase, clip: ClipTiming, time: number): number {
  if (base === 'local') return time - clip.start;
  if (base === 'fraction') return clip.duration > 0 ? (time - clip.start) / clip.duration : 0;
  return clip.sourceIn + (time - clip.start) * (clip.speed || 1);
}

/** 打点の時刻 → タイムラインの時刻（打点をタイムラインに描くとき）。 */
export function timeAtKeyTime(base: TrackBase, clip: ClipTiming, t: number): number {
  if (base === 'local') return clip.start + t;
  if (base === 'fraction') return clip.start + t * clip.duration;
  const speed = clip.speed || 1;
  return speed > 0 ? clip.start + (t - clip.sourceIn) / speed : clip.start;
}

/** その時刻の値。打点が無ければ素の値（`clip[prop]`）。 */
export function animValueAt(clip: Clip, prop: AnimProp, time: number): number {
  const track = clip.anim?.[prop];
  const plain = clip[prop];
  if (!track) return plain;
  if (!isKeyedTrack(track)) return Number.isFinite(track.v) ? track.v : plain;
  return sampleKeys(track.keys, keyTimeIn(track.base ?? 'source', clip, time), FALLBACK[prop]);
}

/**
 * 描く直前に、その時刻の値を素の数へ戻したクリップ。
 * **打点を持たないクリップは同じものを返す**（描く側の費用がこれまでと同じ）。
 */
export function animatedClipAt(clip: Clip, time: number): Clip {
  const anim = clip.anim;
  if (!anim) return clip;
  let out: Clip | null = null;
  for (const prop of ANIM_PROPS) {
    if (!anim[prop]) continue;
    out ??= { ...clip };
    out[prop] = animValueAt(clip, prop, time);
  }
  return out ?? clip;
}

/** その値に打点が 1 つでもあるか。 */
export function isAnimated(clip: Clip, prop: AnimProp): boolean {
  const track = clip.anim?.[prop];
  return isKeyedTrack(track) && track.keys.length > 0;
}

/** 1 コマ（既定 30fps）の半分より近ければ「その時刻の打点」とみなす。 */
const NEAR = 1 / 60;

/** いまの時刻に立っている打点の番号（無ければ -1）。 */
export function keyIndexAt(clip: Clip, prop: AnimProp, time: number): number {
  const track = clip.anim?.[prop];
  if (!isKeyedTrack(track)) return -1;
  const base = track.base ?? 'source';
  return track.keys.findIndex((k) => Math.abs(timeAtKeyTime(base, clip, k.t) - time) < NEAR);
}

function withTrack(clip: Clip, prop: AnimProp, track: AnimTrack | null, plain?: number): Partial<Clip> {
  const anim: ClipAnim = { ...(clip.anim ?? {}) };
  if (track) anim[prop] = track;
  else delete anim[prop];
  const empty = Object.keys(anim).length === 0;
  return { anim: empty ? undefined : anim, ...(plain !== undefined ? { [prop]: plain } : {}) };
}

/**
 * 値を書く。**打点のある値なら、いまの時刻の打点として書く**（無ければ素の値を書き換える）。
 * スライダーやプレビューでつまんだとき、動かしている値の形を壊さずに済む。
 */
export function writeAnimated(clip: Clip, prop: AnimProp, value: number, time: number): Partial<Clip> {
  const track = clip.anim?.[prop];
  if (!isKeyedTrack(track) || track.keys.length === 0) {
    if (track) return withTrack(clip, prop, { base: track.base ?? 'source', v: value }, value);
    return { [prop]: value };
  }
  const base = track.base ?? 'source';
  const t = keyTimeIn(base, clip, time);
  const at = keyIndexAt(clip, prop, time);
  const keys = [...track.keys];
  if (at >= 0) {
    keys[at] = { ...keys[at], v: value };
  } else {
    // 区間の途中に足した打点は、その区間の繋ぎ方を引き継ぐ（足しただけで動き方が変わらないように）。
    const ease = keys[findSegment(keys, t)]?.ease;
    keys.push({ t, v: value, ...(ease ? { ease } : {}) });
  }
  return withTrack(clip, prop, { ...track, keys: normalizeKeys(keys) });
}

/** いくつかの値をまとめて書く（プレビューで掴んで動かすと、左右と上下が一緒に変わる）。 */
export function writeAnimatedMany(clip: Clip, values: Partial<Record<AnimProp, number>>, time: number): Partial<Clip> {
  let next: Clip = clip;
  let patch: Partial<Clip> = {};
  for (const prop of ANIM_PROPS) {
    const value = values[prop];
    if (value === undefined) continue;
    const step = writeAnimated(next, prop, value, time);
    next = { ...next, ...step };
    patch = { ...patch, ...step };
  }
  return patch;
}

/**
 * いまの時刻に打点を置く／あれば外す（画面の ◆ ボタン）。
 * 置くときは**いまの値をそのまま打点にする**ので、置いた瞬間に絵が飛ばない。
 * 外して 1 つも無くなったら、最後の値を素の値として残す（人が選んだ軸なら覚えておく）。
 */
export function toggleKeyAt(clip: Clip, prop: AnimProp, time: number): Partial<Clip> {
  const track = clip.anim?.[prop];
  const at = keyIndexAt(clip, prop, time);
  if (isKeyedTrack(track) && at >= 0) {
    const keys = track.keys.filter((_, i) => i !== at);
    if (keys.length > 0) return withTrack(clip, prop, { ...track, keys });
    const last = track.keys[at].v;
    const base = track.base ?? 'source';
    return base === defaultTrackBase(clip.kind)
      ? withTrack(clip, prop, null, last)
      : withTrack(clip, prop, { base, v: last }, last);
  }
  const base = trackBaseIn(clip, track);
  const v = animValueAt(clip, prop, time);
  const keys = isKeyedTrack(track) ? track.keys : [];
  return withTrack(clip, prop, { base, keys: normalizeKeys([...keys, { t: keyTimeIn(base, clip, time), v }]) });
}

/** いまの時刻に立っている打点の繋ぎ方を変える（打点が無ければ何もしない）。 */
export function setEaseAt(clip: Clip, prop: AnimProp, time: number, ease: Ease): Partial<Clip> {
  const track = clip.anim?.[prop];
  const at = keyIndexAt(clip, prop, time);
  if (!isKeyedTrack(track) || at < 0) return {};
  const keys = track.keys.map((k, i) => (i === at ? { ...k, ease } : k));
  return withTrack(clip, prop, { ...track, keys: normalizeKeys(keys) });
}

/** その値の打点を全部外す（最初の打点の値ではなく、いまの時刻の値を残す）。 */
export function clearKeys(clip: Clip, prop: AnimProp, time: number): Partial<Clip> {
  return withTrack(clip, prop, null, animValueAt(clip, prop, time));
}

/** 打点が立っているタイムラインの時刻（重なりは 1 つにまとめる）。タイムラインに印を出すため。 */
export function keyTimesOf(clip: Clip): number[] {
  if (!clip.anim) return [];
  const times: number[] = [];
  for (const prop of ANIM_PROPS) {
    const track = clip.anim[prop];
    if (!isKeyedTrack(track)) continue;
    const base = track.base ?? 'source';
    for (const k of track.keys) {
      const t = timeAtKeyTime(base, clip, k.t);
      if (!times.some((x) => Math.abs(x - t) < NEAR)) times.push(t);
    }
  }
  return times.sort((a, b) => a - b);
}

/** 前後の打点へ飛ぶ先（無ければ null）。 */
export function neighborKeyTime(clip: Clip, time: number, direction: -1 | 1): number | null {
  const times = keyTimesOf(clip);
  if (direction > 0) return times.find((t) => t > time + NEAR) ?? null;
  for (let i = times.length - 1; i >= 0; i -= 1) if (times[i] < time - NEAR) return times[i];
  return null;
}

/**
 * ゆっくり寄る（ケンバーンズ）。尺の割合で持つので、尺を変えても最後まで寄り切る。
 * 静止画や、動きの少ない動画を、止まって見せないための定番。
 */
export function kenBurns(clip: Clip, to = 1.15): Partial<Clip> {
  const from = clip.anim?.scale ? animValueAt(clip, 'scale', clip.start) : clip.scale;
  return withTrack(clip, 'scale', {
    base: 'fraction',
    keys: normalizeKeys([{ t: 0, v: from, ease: 'easeInOut' }, { t: 1, v: from * to }]),
  });
}
