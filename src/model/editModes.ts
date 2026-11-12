/**
 * 編集モード（Premiere のツールに相当）。
 *
 * タイムラインのドラッグが「何をするか」を、モードで切り替える:
 *
 * | モード | 端をドラッグ | クリップをドラッグ |
 * |---|---|---|
 * | 通常 | トリム（空いた所は残る） | 移動 |
 * | リップル | 後続も一緒に動くトリム | 移動 |
 * | ロール | 隣との境目だけを動かす | 移動 |
 * | スリップ | トリム | 位置と尺はそのまま、素材のどこを使うかをずらす |
 * | スライド | トリム | 位置を動かし、前後が伸び縮みして埋める |
 *
 * 判断はすべて純粋関数（`editOps.ts` の組み合わせ）。DOM を使わないので Node で検査できる。
 */
import { rippleTrim, rollEdit, slideClip, slipClip } from './editOps';
import { moveClips, trimClip } from './ops';
import { clipEnd, type Clip, type Sequence } from './types';

export type EditMode = 'normal' | 'ripple' | 'roll' | 'slip' | 'slide';

/**
 * `plain` は何が起きるかで言い直した名前、`label` は元の専門用語（Premiere と同じ呼び名）。
 * 画面には両方を並べて出す（`plain（label）`）。
 */
export const EDIT_MODES: ReadonlyArray<{ key: EditMode; plain: string; label: string; hint: string }> = [
  { key: 'normal', plain: '通常', label: '通常', hint: '端をドラッグすると長さが変わり、空いた所はそのまま残ります。クリップをドラッグすると移動します。' },
  { key: 'ripple', plain: '詰めて伸縮', label: 'リップル', hint: '端をドラッグして長さを変えると、後ろのクリップも一緒に寄ります。隙間ができません。' },
  { key: 'roll', plain: '境目を動かす', label: 'ロール', hint: '端をドラッグすると、隣のクリップとの境目だけが動きます。全体の長さは変わりません。' },
  { key: 'slip', plain: '中身をずらす', label: 'スリップ', hint: 'クリップをドラッグすると、位置と長さはそのままで、使う場面だけがずれます。' },
  { key: 'slide', plain: '位置をずらす', label: 'スライド', hint: 'クリップをドラッグすると位置が動き、前後のクリップが伸び縮みして隙間を埋めます。' },
];

/** 素材の長さ（秒）を返す。分からなければ undefined（＝制限なし）。 */
export type SourceLengthOf = (clip: Clip) => number | undefined;

const ADJACENT = 0.02;

/** 同じトラックで、すき間なく隣り合うクリップ。 */
export function neighborOf(sequence: Sequence, clip: Clip, side: 'prev' | 'next'): Clip | null {
  return (
    sequence.clips.find((c) =>
      c.trackId === clip.trackId &&
      c.id !== clip.id &&
      (side === 'prev' ? Math.abs(clipEnd(c) - clip.start) <= ADJACENT : Math.abs(c.start - clipEnd(clip)) <= ADJACENT),
    ) ?? null
  );
}

/** モードに応じた端のドラッグ。`delta` は秒（右が正）。 */
export function trimByMode(
  original: Sequence,
  clipId: string,
  side: 'left' | 'right',
  delta: number,
  mode: EditMode,
  sourceLengthOf: SourceLengthOf,
): Sequence {
  const clip = original.clips.find((c) => c.id === clipId);
  if (!clip) return original;
  if (mode === 'ripple') return rippleTrim(original, clipId, side, delta, sourceLengthOf(clip));
  if (mode === 'roll') {
    const other = neighborOf(original, clip, side === 'left' ? 'prev' : 'next');
    if (other) {
      // 動かすのは境目。左端なら（前, 自分）、右端なら（自分, 次）の組で、右へ動かす量は同じ向き。
      const left = side === 'left' ? other : clip;
      const right = side === 'left' ? clip : other;
      return rollEdit(original, left.id, right.id, delta, sourceLengthOf(left));
    }
  }
  return trimClip(original, clipId, side, delta);
}

/**
 * スリップ / スライドのドラッグ。`delta` はタイムライン上の秒（右が正）。
 * それ以外のモードでは null を返す（呼び出し側は通常の移動をする）。
 *
 * スリップは「中身を右へ引きずる」向きに合わせる: 右へドラッグ → イン点は手前へ戻る。
 */
export function dragByMode(
  original: Sequence,
  clipId: string,
  delta: number,
  mode: EditMode,
  sourceLengthOf: SourceLengthOf,
): Sequence | null {
  const clip = original.clips.find((c) => c.id === clipId);
  if (!clip) return original;
  if (mode === 'slip') return slipClip(original, clipId, -delta * (clip.speed || 1), sourceLengthOf(clip));
  if (mode === 'slide') {
    const prev = neighborOf(original, clip, 'prev');
    return slideClip(original, clipId, delta, { previous: prev ? sourceLengthOf(prev) : undefined });
  }
  return null;
}

/** キーボードのナッジ。選択中のクリップを、いまのモードの動かし方で `delta` 秒（右が正）ずらす。 */
export function nudgeByMode(
  sequence: Sequence,
  ids: string[],
  delta: number,
  mode: EditMode,
  sourceLengthOf: SourceLengthOf,
): Sequence {
  if (ids.length === 0) return sequence;
  if (mode === 'slip' || mode === 'slide') {
    let next = sequence;
    for (const id of ids) next = dragByMode(next, id, delta, mode, sourceLengthOf) ?? next;
    return next;
  }
  return moveClips(sequence, ids, delta, 0);
}
