/**
 * テンポのつまみ — しゃべりの「間」を、つまみ 1 本で詰める。
 *
 * 間（無音）の見つけ方は試作置き場の無音カット（`lab/auto-cut/src/silence.ts` の写し）。
 * ここは、つまみの値を無音カットの決めごとに直すのと、見つけた間をタイムラインから取り除くだけ。
 *
 * 取り除き方は、手で「分割 → リップル削除」するのと同じ（`splitAt` → `removeClips(ripple)`）。
 * つないだ音（または映像）も一緒に割れて一緒に消えるので、映像と音はずれない。
 * 後ろから順に取り除くので、前の間の位置は動かない。
 * ほかのトラック（BGM・字幕など）は動かさない（BGM まで刻まれるのを避けるため）。
 */

import { reconcileLinks } from './links';
import { carve, removeClips, splitAt } from './ops';
import type { Clip, Sequence } from './types';

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * つまみ（0 = ゆったり 〜 1 = きびきび）を、無音カットの決めごとへ。
 * - どれだけ短い間まで詰めるか: 0.9 秒 → 0.25 秒（短い間は息継ぎ。詰めすぎると息が詰まって聞こえる）
 * - 声の前後に残す余白: 0.14 秒 → 0.06 秒（0 にすると語頭・語尾が食われる）
 */
export function tempoOptions(amount: number): { minSilence: number; padding: number } {
  const t = Math.min(1, Math.max(0, amount));
  return { minSilence: 0.9 - 0.65 * t, padding: 0.14 - 0.08 * t };
}

/** 素材の秒 → タイムラインの秒。 */
function toTimeline(clip: Clip, sourceTime: number): number {
  return clip.start + (sourceTime - clip.sourceIn) / (clip.speed || 1);
}

/**
 * 残す範囲（素材の秒）から、取り除く範囲（タイムラインの秒・後ろから順）を出す。
 * クリップが使っていない所は数えない。`minLength` より短いものは捨てる。
 */
export function cutRanges(clip: Clip, keep: TimeRange[], minLength = 0.12): TimeRange[] {
  const from = clip.start;
  const to = clip.start + clip.duration;
  const kept = keep
    .map((r) => ({ start: Math.max(from, toTimeline(clip, r.start)), end: Math.min(to, toTimeline(clip, r.end)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const cuts: TimeRange[] = [];
  let cursor = from;
  for (const r of kept) {
    if (r.start - cursor >= minLength) cuts.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (to - cursor >= minLength) cuts.push({ start: cursor, end: to });
  // 残すものが何も無いなら、何もしない（丸ごと消してしまうより安全）。
  if (kept.length === 0) return [];
  return cuts.reverse();
}

export interface TempoResult {
  sequence: Sequence;
  /** 詰めた秒数。 */
  removed: number;
  /** 詰めた所の数。 */
  count: number;
}

/** 操作をして、アプリと同じく映像と音のつなぎを揃え直す。 */
function step(sequence: Sequence, fn: (s: Sequence) => Sequence): Sequence {
  return reconcileLinks(sequence, fn(sequence));
}

/** そのトラックで、時刻 `time` から始まるクリップ。 */
function pieceAt(sequence: Sequence, trackId: string, time: number): Clip | undefined {
  return sequence.clips.find((c) => c.trackId === trackId && Math.abs(c.start - time) < 1e-6);
}

/** そのトラックで、時刻 `time` にかかっているクリップ。 */
function pieceOver(sequence: Sequence, trackId: string, time: number): Clip | undefined {
  return sequence.clips.find((c) => c.trackId === trackId && c.start - 1e-6 <= time && time < c.start + c.duration - 1e-6);
}

/**
 * 取り除く範囲（タイムラインの秒・後ろから順）を、そのクリップから取り除いて詰める。
 * 返す `removed` は、実際に取り除けた秒数。
 */
export function removeRanges(sequence: Sequence, clipId: string, cuts: TimeRange[]): TempoResult {
  const clip = sequence.clips.find((c) => c.id === clipId);
  if (!clip) return { sequence, removed: 0, count: 0 };
  const trackId = clip.trackId;
  let seq = sequence;
  let removed = 0;
  let count = 0;
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) {
    // 範囲の終わりで割る（割れない＝クリップの終わりと同じなら、そのまま）。
    const tail = pieceOver(seq, trackId, cut.end - 1e-4);
    if (!tail) continue;
    seq = step(seq, (s) => splitAt(s, cut.end, [tail.id]));
    // 範囲の頭で割る。
    const head = pieceOver(seq, trackId, cut.start + 1e-4);
    if (!head) continue;
    seq = step(seq, (s) => splitAt(s, cut.start, [head.id]));
    const gone = pieceAt(seq, trackId, cut.start) ?? (Math.abs(head.start - cut.start) < 0.06 ? head : undefined);
    if (!gone) continue;
    const length = gone.duration;
    seq = step(seq, (s) => removeClips(s, [gone.id], true));
    removed += length;
    count += 1;
  }
  return { sequence: seq, removed, count };
}

const EPS = 1e-6;

/**
 * 中身のすべてのトラックから、範囲 [a, b)（中身の秒）を取り除いて詰める。
 * 映像・音は割って取り除く（つないだ映像と音は同じに割れる）。文字と画像は割らずに縮める
 * （見出しのように全体にかかる文字が、切れ目ごとに何枚にも分かれないように）。
 */
function rippleCutAll(inner: Sequence, a: number, b: number): Sequence {
  const d = b - a;
  if (d <= EPS) return inner;
  const clips: Clip[] = [];
  for (const c of inner.clips) {
    const end = c.start + c.duration;
    if (end <= a + EPS) {
      clips.push(c);
    } else if (c.start >= b - EPS) {
      clips.push({ ...c, start: c.start - d });
    } else if (c.kind === 'video' || c.kind === 'audio') {
      for (const piece of carve([c], c.trackId, a, b, '')) {
        clips.push(piece.start >= b - EPS ? { ...piece, start: piece.start - d } : piece);
      }
    } else {
      const overlap = Math.min(end, b) - Math.max(c.start, a);
      const duration = c.duration - overlap;
      if (duration <= EPS) continue;
      clips.push({ ...c, start: Math.min(c.start, a), duration });
    }
  }
  return reconcileLinks(inner, { ...inner, clips });
}

/**
 * まとめたクリップ（3 分割など）に、丸ごと間を詰める。`cuts` は外のタイムラインの秒（`cutRanges` の結果）。
 * 中の帯 3 本・音・見出しを同じ所で詰め、まとめたクリップを短くして、同じトラックの後ろのクリップを寄せる。
 * ほかのトラックは動かさない（`removeRanges` と同じ）。
 */
export function removeRangesInNest(sequence: Sequence, nestId: string, cuts: TimeRange[]): TempoResult {
  const nest = sequence.clips.find((c) => c.id === nestId);
  if (!nest || nest.kind !== 'nest' || !nest.nested) return { sequence, removed: 0, count: 0 };
  let current: Clip = nest;
  let after = sequence.clips.filter((c) => c.id !== nestId);
  let removed = 0;
  let count = 0;
  for (const cut of [...cuts].sort((x, y) => y.start - x.start)) {
    const from = Math.max(cut.start, current.start);
    const to = Math.min(cut.end, current.start + current.duration);
    const d = to - from;
    if (d <= EPS) continue;
    const a = current.sourceIn + (from - current.start);
    const nestEnd = current.start + current.duration;
    current = { ...current, duration: current.duration - d, nested: rippleCutAll(current.nested!, a, a + d) };
    after = after.map((c) => (c.trackId === nest.trackId && c.start >= nestEnd - 1e-4 ? { ...c, start: c.start - d } : c));
    removed += d;
    count += 1;
  }
  const moved = new Map(after.map((c) => [c.id, c]));
  const clips = sequence.clips.map((c) => (c.id === nestId ? current : (moved.get(c.id) ?? c)));
  return { sequence: { ...sequence, clips }, removed, count };
}

