/**
 * 字幕あり / なしの 2 種類を書き出すための、クリップの振り分け。
 *
 * `ops.ts` ではなくここに置いてあるのは、**型以外を import していない**から。
 * そのおかげで Node がこのファイルをそのまま読める＝ブラウザ抜きで規則を試せる。
 */

import type { Sequence } from './types';

function isCaption(clip: Sequence['clips'][number]): boolean {
  // 古い保存ファイルには role が無い。テロップ＝字幕として扱う（消える側）。
  return clip.kind === 'text' && (clip.text?.role ?? 'caption') === 'caption';
}

/**
 * 字幕を外したシーケンス。字幕なし版の書き出しに使う。
 *
 * 消すのは「種類＝字幕」のテロップだけで、タイトルや飾りは残す。
 * 書き出しの経路は 2 つ（コマ単位 / 実時間の収録）あるが、どちらも渡された
 * シーケンスをそのまま描くので、ここで外しておけば両方に効く。
 */
export function withoutCaptions(sequence: Sequence): Sequence {
  return {
    ...sequence,
    clips: sequence.clips.filter((clip) => !isCaption(clip)),
  };
}

/** 字幕として消えるテロップの数。書き出し画面で「何が消えるか」を出すために使う。 */
export function captionCount(sequence: Sequence): number {
  return sequence.clips.filter(isCaption).length;
}
