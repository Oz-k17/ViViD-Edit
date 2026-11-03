/**
 * 確かめリスト（model/checks.ts）のための、文字の塊の測り方。
 * 折り返し・縮めて合わせる・台紙はプレビューと同じ描き方でないと分からないので、
 * そのクリップだけを小さなキャンバスに描いて、描画が返す当たり判定の矩形を使う。
 */
import type { Box, MeasureText } from '../model/checks';
import type { Sequence } from '../model/types';
import { renderFrame, type RenderSources } from './renderer';

export function textMeasurer(sequence: Sequence, sources: RenderSources): MeasureText {
  const canvas = document.createElement('canvas');
  // 描く量を減らすため小さく描く（矩形はシーケンスの座標で返るので、大きさに依らない）。
  canvas.width = Math.max(1, Math.round(sequence.width / 8));
  canvas.height = Math.max(1, Math.round(sequence.height / 8));
  const ctx = canvas.getContext('2d');
  return (clip) => {
    if (!ctx || clip.kind !== 'text') return null;
    const track = sequence.tracks.find((t) => t.id === clip.trackId);
    if (!track) return null;
    // 出だしの動き（ずれ・拡大）が落ち着いた、表示時間の真ん中で測る。
    const alone: Sequence = { ...sequence, tracks: [{ ...track, hidden: false }], clips: [{ ...clip, opacity: 1, fadeIn: 0, fadeOut: 0 }] };
    const bounds = renderFrame(ctx, alone, clip.start + clip.duration / 2, sources, { guides: false });
    const box = bounds.get(clip.id);
    return box ? ({ x: box.x, y: box.y, w: box.w, h: box.h } satisfies Box) : null;
  };
}
