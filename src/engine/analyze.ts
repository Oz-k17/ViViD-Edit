/**
 * クリップの映像を解析して、編集に使える形で答える（ブラウザ専用）。
 *
 * 判断はすべて `src/analysis/`（ラボの試作から持ってきた純粋な関数）にあり、
 * ここは「素材を読み出す」「解析へ渡す」「素材の秒をタイムラインの秒へ直す」だけ。
 * **試験的な機能**として入れているので、画面でもそう断っている。
 *
 * 読むのはクリップが使っている範囲だけ。ぜんぶ読むと長尺では上限で打ち切られ、
 * 使う所が読まれない（`decode.ts` の `from` / `to`）。
 */

import { decodeVideoFrames, ANALYSIS_FPS, type DecodedClip } from '../analysis/decode';
import { summarizeFrames } from '../analysis/frames';
import { planSceneCut, type ScenePlan } from '../analysis/scene';
import { pickThumbnails, type ThumbPick } from '../analysis/pick';
import { summarizeThumbs } from '../analysis/thumb';
import {
  REFRAME_ANALYSIS_FPS,
  VERTICAL_REFRAME,
  DEFAULT_REFRAME,
  planReframe,
  planReframeVertical,
  summarizeForReframe,
  summarizeForReframeVertical,
} from '../analysis/reframe';
import { segmentCenters, type CenterSegment } from '../analysis/segments';
import { reframeWindow, usedSourceRange, type ReframeWindow } from '../model/analysisEdits';
import type { Clip, Sequence } from '../model/types';
import { assetBlob } from './offline-export';

export class AnalysisError extends Error {}

interface Source {
  blob: Blob;
  range: { from: number; to: number };
}

/** クリップの素材を取り出し、使っている範囲を添える。映像でなければ理由を言って止める。 */
async function sourceOf(clip: Clip): Promise<Source> {
  if (clip.kind !== 'video' || !clip.mediaId) throw new AnalysisError('映像のクリップを選んでください。');
  const blob = await assetBlob(clip.mediaId);
  if (!blob) throw new AnalysisError('素材を読み出せませんでした。');
  return { blob, range: usedSourceRange(clip) };
}

export interface Progress {
  (ratio: number): void;
}

/** 読むコマを素材の何割まで進めたか、を全体の進み具合へ直す（読む段が 0〜0.9、解析が残り）。 */
function readProgress(onProgress?: Progress) {
  return onProgress ? (ratio: number) => onProgress(ratio * 0.9) : undefined;
}

export interface SceneResult {
  /** 素材の頭からの秒。 */
  times: number[];
  plan: ScenePlan;
  truncated: boolean;
}

/** カットの切り替わりを探す。 */
export async function detectScenes(clip: Clip, onProgress?: Progress): Promise<SceneResult> {
  const { blob, range } = await sourceOf(clip);
  const decoded = await decodeVideoFrames(blob, { fps: ANALYSIS_FPS, ...range, onProgress: readProgress(onProgress) });
  const stats = summarizeFrames(decoded.frames, decoded.times);
  const plan = planSceneCut(stats);
  onProgress?.(1);
  return { times: plan.boundaries.map((b) => b.time), plan, truncated: decoded.truncated };
}

export interface CoverCandidate extends ThumbPick {
  /** 解析に使った小さな絵（候補の見た目を出すため）。 */
  frame: DecodedClip['frames'][number];
}

export interface CoverResult {
  picks: CoverCandidate[];
  truncated: boolean;
}

/** 表紙に使えそうなコマを選ぶ。 */
export async function pickCovers(clip: Clip, count = 3, onProgress?: Progress): Promise<CoverResult> {
  const { blob, range } = await sourceOf(clip);
  const decoded = await decodeVideoFrames(blob, { fps: ANALYSIS_FPS, ...range, onProgress: readProgress(onProgress) });
  const thumbs = summarizeThumbs(decoded.frames, decoded.times);
  const stats = summarizeFrames(decoded.frames, decoded.times);
  const picks = pickThumbnails(thumbs, stats, { count });
  onProgress?.(1);
  return {
    picks: picks.map((p) => ({ ...p, frame: decoded.frames[p.index] })),
    truncated: decoded.truncated,
  };
}

export interface ReframeResult {
  segments: CenterSegment[];
  window: ReframeWindow;
  /** 枠が動いた量の合計を尺で割ったもの。被写体が居ない素材でここが大きい。 */
  travelPerSecond: number;
  truncated: boolean;
}

/**
 * 被写体を追う枠の置き所を決める。
 * シーケンスと素材の縦横比が同じなら切り出す余りが無いので `null`。
 */
export async function planClipReframe(
  clip: Clip,
  sequence: Sequence,
  media: { width: number; height: number },
  onProgress?: Progress,
): Promise<ReframeResult | null> {
  const window = reframeWindow(media, sequence.width / sequence.height);
  if (!window) return null;

  const { blob, range } = await sourceOf(clip);
  // 速さは 30fps（ラボで「間引くと枠が振れる」と測ってある）。
  const decoded = await decodeVideoFrames(blob, {
    fps: REFRAME_ANALYSIS_FPS,
    ...range,
    onProgress: readProgress(onProgress),
  });

  const plan =
    window.axis === 'x'
      ? planReframe(summarizeForReframe(decoded.frames, decoded.times, { cropWidth: window.size }), {
          ...DEFAULT_REFRAME,
          cropWidth: window.size,
        })
      : planReframeVertical(
          summarizeForReframeVertical(decoded.frames, decoded.times, { cropWidth: window.size }),
          { ...VERTICAL_REFRAME, cropWidth: window.size },
        );

  const segments = segmentCenters(plan.frames.map((f) => ({ time: f.time, center: f.center })));
  const span = Math.max(1e-6, range.to - range.from);
  onProgress?.(1);
  return { segments, window, travelPerSecond: plan.travel / span, truncated: decoded.truncated };
}
