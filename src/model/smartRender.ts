/**
 * スマートレンダー: 手を加えていない区間は、素材の動画データ（H.264）をそのまま写し、読み解きも書き直しもしない。
 *
 * openreel-video（MIT, Augustus Otu and Contributors）の `export/smart-render.ts` に倣った。
 * 写せる条件（素材の側）も、そちらの WebCodecs 向けの条件をそのまま使っている。
 *
 * ViViD ではほぼ全編にテロップが乗るので、効くのは「縦で撮った動画を、字幕なしでそのまま出す」ような区間だけ。
 * その区間は、書き出しの時間がほぼ 0 になり、画質も素材のまま（書き直しで落ちない）。
 *
 * ここは「どのコマを写せるか」と「どこで切るか」の計算だけ（画面にも WebCodecs にも依らない）。
 * 実際に写すのは `engine/smartRender.ts`。
 */
import { isNeutralGrade } from './color';
import { animatedClipAt } from './keyframes';
import { clipAtTime } from './ops';
import { clipEnd, type Clip, type Sequence } from './types';

/** 写す区間がこれより短いなら、書き直したほうがよい（区切りごとに鍵になるコマと SPS/PPS の差し替えが要るので）。 */
export const MIN_COPY_FRAMES = 12;

/** 素材の動画の様子（`engine/smartRender.ts` が素材の目次から読む）。 */
export interface SmartSourceInfo {
  mediaId: string;
  codec: 'avc';
  width: number;
  height: number;
  frameRate: number;
  /** 最初のコマの時刻。どのコマも firstPts + k / frameRate に並ぶ。 */
  firstPts: number;
  /** 最後のコマの終わり。 */
  endTime: number;
  /** 鍵になるコマ（キーフレーム）の時刻。昇順。 */
  keyframeTimes: number[];
  /** キーフレームをまたいで参照するコマが無い（そこで切れる）。 */
  closedGops: boolean;
  /** どのコマも一定の間隔に並ぶ。 */
  constantFrameRate: boolean;
  nalLengthSize: number;
  rotation: number;
  color?: { matrix?: string | null; transfer?: string | null; fullRange?: boolean | null };
}

/** 出力の 1 コマが、素材のどのコマそのものか（手を加えていないとき）。 */
export interface UntouchedFrame {
  mediaId: string;
  clipId: string;
  sourceTime: number;
}

export type SmartSegment =
  | { kind: 'encode'; startFrame: number; endFrame: number }
  | { kind: 'copy'; startFrame: number; endFrame: number; mediaId: string; sourceStart: number; sourceEnd: number };

export interface SmartPlan {
  segments: SmartSegment[];
  copiedFrames: number;
  totalFrames: number;
  /** 写せなかった主な理由（書き出しの結果に添える）。 */
  reasons: string[];
}

const EPS = 1e-4;

/** 画面の作り（素材を手を加えずに全面へ置いているか）。動きの値は、その時刻の値で見る。 */
function plainFullFrame(clip: Clip, time: number): string | null {
  if (clip.kind !== 'video' || !clip.mediaId) return '動画ではない';
  const c = animatedClipAt(clip, time);
  if ((c.speed || 1) !== 1) return '速さを変えている';
  if (c.opacity !== 1 || c.scale !== 1 || c.x !== 0 || c.y !== 0 || c.rotate !== 0) return '大きさ・位置・濃さ・回転を変えている';
  if (c.effects.length > 0) return 'エフェクトがある';
  if (c.color && !isNeutralGrade(c.color)) return '色調整がある';
  if (c.crop.enabled) return '切り抜いている';
  if (c.bgBlur.enabled) return '背景ぼかしがある';
  const local = time - c.start;
  if (c.fadeIn > 0 && local < c.fadeIn) return 'フェードの途中';
  if (c.fadeOut > 0 && c.duration - local < c.fadeOut) return 'フェードの途中';
  if (c.transitionIn.type !== 'none' && local < c.transitionIn.duration) return '切り替えの途中';
  return null;
}

/**
 * その時刻の出力が、素材の 1 コマそのものか。
 * 映っているのが動画 1 本だけで、文字も重ねず、全面に手を加えずに置いているときだけ。
 * 大きさが出力と同じかは素材の様子を知らないと言えないので、計画（`planSmartRender`）の側で見る。
 */
export function untouchedFrameAt(sequence: Sequence, time: number): UntouchedFrame | { reason: string } {
  let found: Clip | null = null;
  for (const track of sequence.tracks) {
    if (track.hidden) continue;
    if (track.kind === 'text') {
      const text = sequence.clips.some((c) => c.trackId === track.id && time >= c.start && time < clipEnd(c));
      if (text) return { reason: '文字が乗っている' };
      continue;
    }
    if (track.kind !== 'video') continue;
    const clip = clipAtTime(sequence, track.id, time);
    if (!clip) continue;
    if (found) return { reason: '映像が重なっている' };
    found = clip;
  }
  if (!found) return { reason: '映像が無い' };
  const why = plainFullFrame(found, time);
  if (why) return { reason: why };
  return { mediaId: found.mediaId as string, clipId: found.id, sourceTime: found.sourceIn + (time - found.start) };
}

/** 素材がそのまま写せる形か（出力の大きさ・速さとも合うか）。合わなければ理由。openreel の settingsMatchSource と同じ条件。 */
export function sourceMismatch(source: SmartSourceInfo, out: { width: number; height: number; fps: number }): string | null {
  if (source.width !== out.width || source.height !== out.height) return '素材と出力の大きさが違う';
  if (Math.abs(source.frameRate - out.fps) > 0.01) return '素材と出力のフレームレートが違う';
  if (source.rotation !== 0) return '素材が回転して記録されている';
  if (source.color?.fullRange === true) return '素材がフルレンジ';
  if (source.color?.matrix && source.color.matrix !== 'bt709') return '素材の色の決まりが違う';
  if (source.color?.transfer && source.color.transfer !== 'bt709' && source.color.transfer !== 'iec61966-2-1') return '素材の明るさの決まりが違う（HDR など）';
  if (source.nalLengthSize !== 4) return '素材の H.264 の形が違う';
  if (!source.closedGops) return '素材がキーフレームをまたいで参照している';
  if (!source.constantFrameRate) return '素材のフレームレートが一定でない';
  return null;
}

/**
 * どこを写し、どこを書き直すか。
 *
 * 写すのは「同じ素材の連続したコマが、出力でも連続している」所のうち、キーフレームからキーフレームまで。
 * 頭と尻の半端（キーフレームの間）は書き直す。写す区間の頭は必ずキーフレームなので、
 * そこから読む機器はそこだけで絵を作れる。
 */
export function planSmartRender(
  frames: readonly (UntouchedFrame | { reason: string })[],
  sources: ReadonlyMap<string, SmartSourceInfo | null>,
  out: { width: number; height: number; fps: number },
): SmartPlan {
  const total = frames.length;
  const reasons = new Map<string, number>();
  const note = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const grid = 1 / out.fps;

  // 1. コマごとに「素材のどのコマか（格子の番号）」を出す。写せないコマは null。
  const slots: ({ mediaId: string; k: number; source: SmartSourceInfo } | null)[] = frames.map((frame) => {
    if ('reason' in frame) {
      note(frame.reason);
      return null;
    }
    const source = sources.get(frame.mediaId);
    if (!source) {
      note('素材が H.264 ではない（または読めない）');
      return null;
    }
    const mismatch = sourceMismatch(source, out);
    if (mismatch) {
      note(mismatch);
      return null;
    }
    const k = (frame.sourceTime - source.firstPts) / grid;
    if (Math.abs(k - Math.round(k)) > 0.02 || frame.sourceTime + EPS >= source.endTime) {
      note('素材のコマと出力のコマがずれている');
      return null;
    }
    return { mediaId: frame.mediaId, k: Math.round(k), source };
  });

  // 2. 同じ素材で、格子の番号が 1 つずつ進む並びをまとめる。その中でキーフレームからキーフレームまでを写す。
  const segments: SmartSegment[] = [];
  let encodeFrom = 0;
  let copied = 0;
  const pushCopy = (startFrame: number, endFrame: number, mediaId: string, sourceStart: number, sourceEnd: number) => {
    if (startFrame > encodeFrom) segments.push({ kind: 'encode', startFrame: encodeFrom, endFrame: startFrame });
    segments.push({ kind: 'copy', startFrame, endFrame, mediaId, sourceStart, sourceEnd });
    copied += endFrame - startFrame;
    encodeFrom = endFrame;
  };

  let i = 0;
  while (i < total) {
    const head = slots[i];
    if (!head) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < total) {
      const s = slots[j];
      if (!s || s.mediaId !== head.mediaId || s.k !== head.k + (j - i)) break;
      j += 1;
    }
    // 並び i..j（出力のコマ）＝ 素材の格子 head.k .. head.k + (j - i)
    const { source } = head;
    const timeOf = (k: number) => source.firstPts + k * grid;
    const runStart = timeOf(head.k);
    const runEnd = timeOf(head.k + (j - i));
    const keys = source.keyframeTimes.filter((t) => t >= runStart - EPS && t <= runEnd + EPS);
    // 写す頭は並びの中の最初のキーフレーム、尻は最後のキーフレーム（並びの終わりが素材の終わりなら、そこまで）。
    const first = keys[0];
    let last = keys[keys.length - 1];
    if (Math.abs(runEnd - source.endTime) < EPS) last = source.endTime;
    if (first !== undefined && last !== undefined && last > first + EPS) {
      const startFrame = i + Math.round((first - runStart) / grid);
      const endFrame = i + Math.round((last - runStart) / grid);
      if (endFrame - startFrame >= MIN_COPY_FRAMES) pushCopy(startFrame, endFrame, head.mediaId, first, last);
      else note('手つかずの区間が短すぎる');
    } else {
      note('手つかずの区間にキーフレームが無い');
    }
    i = j;
  }
  if (total > encodeFrom) segments.push({ kind: 'encode', startFrame: encodeFrom, endFrame: total });

  const ordered = [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason]) => reason);
  return { segments, copiedFrames: copied, totalFrames: total, reasons: ordered.slice(0, 3) };
}
