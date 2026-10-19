/**
 * WebCodecs が使えない・読めないときの、解析用のコマの取り出し（予備の道）。
 *
 * iPad のアプリ版（WKWebView）では、WebCodecs のデコーダが無い・その動画を読めないことがある。
 * 一方で、同じ動画は `<video>` では再生できる（OS のプレーヤーが読むので）。
 * そこで、`<video>` を 1 コマずつ目的の秒へ動かし（シーク）、canvas に写して読む。
 *
 * - 返す形は `decodeVideoFrames` と同じ（`DecodedClip`）。判断の側（シーン検出など）は何も変えない
 * - 読む秒の決め方も同じ（`sampleTimes`・`analysisSize`）。素材の本当のコマの速さは `<video>` からは分からないので、
 *   希望の速さ（`fps`）で読む。札は読もうとした秒を貼る（`frameTimes` が単調さを守る）
 * - 遅い。シーク 1 回ごとに待つので、WebCodecs の何倍もかかる。だから**予備**で、WebCodecs が読めるときは使わない
 */

import type { FrameLike } from './frames.ts';
import { analysisSize, DEFAULT_DECODE, frameTimes, sampleTimes, type DecodedClip, type DecodeOptions } from './decode';
import { EXPORT_LONG_SIDE, exportSize, type ExportedFrame } from './cover-export';

/** シーク 1 回を待つ上限（ミリ秒）。来なければ、そのコマは「返らなかった」として前のコマで埋める。 */
const SEEK_TIMEOUT_MS = 5000;
/** 読み込みを待つ上限（ミリ秒）。 */
const LOAD_TIMEOUT_MS = 20000;

function waitFor(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener(event, onEvent);
      el.removeEventListener('error', onError);
      window.clearTimeout(timer);
      resolve(ok);
    };
    const onEvent = () => finish(true);
    const onError = () => finish(false);
    el.addEventListener(event, onEvent);
    el.addEventListener('error', onError);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
  });
}

function blankFrame(width: number, height: number): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/**
 * `source` は Blob でも、再生できる URL（素材の `url`）でもよい。
 * 長い動画では、素材をまるごと Blob に読み出すこと自体が端末で失敗することがあるので、URL のまま読めるようにしてある。
 */
export async function decodeVideoFramesViaElement(source: Blob | string, options: Partial<DecodeOptions> = {}): Promise<DecodedClip> {
  const o = { ...DEFAULT_DECODE, ...options };
  const owned = typeof source !== 'string';
  const url = owned ? URL.createObjectURL(source) : source;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  const canvas = document.createElement('canvas');
  try {
    video.src = url;
    if (!(await waitFor(video, 'loadeddata', LOAD_TIMEOUT_MS))) {
      throw new Error('この端末では、この動画を読み込めませんでした');
    }
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('動画の長さが分かりませんでした');
    if (!video.videoWidth || !video.videoHeight) throw new Error('この素材に映像がありません');

    const fps = o.fps;
    const size = analysisSize(video.videoWidth, video.videoHeight, o.longSide);
    const rangeFrom = Math.min(Math.max(0, o.from ?? 0), duration);
    const rangeTo = Math.min(duration, Math.max(rangeFrom, o.to ?? duration));
    const span = rangeTo - rangeFrom;
    const times = sampleTimes(span, fps, o.maxFrames).map((t) => t + rangeFrom);

    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('キャンバスを初期化できませんでした');

    const frames: FrameLike[] = [];
    const stamps: (number | null)[] = [];
    let missing = 0;
    for (let i = 0; i < times.length; i += 1) {
      const target = times[i];
      let ok = true;
      if (Math.abs(video.currentTime - target) > 1e-4) {
        const seeked = waitFor(video, 'seeked', SEEK_TIMEOUT_MS);
        video.currentTime = target;
        ok = await seeked;
      }
      if (ok && video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, size.width, size.height);
        const image = ctx.getImageData(0, 0, size.width, size.height);
        frames.push({ width: image.width, height: image.height, data: image.data });
        stamps.push(target);
      } else {
        // 返らなかった所は前のコマで埋める（`decodeVideoFrames` と同じ扱い）。
        missing += 1;
        frames.push(frames[frames.length - 1] ?? blankFrame(size.width, size.height));
        stamps.push(null);
      }
      if (o.onProgress && (i + 1) % 15 === 0) o.onProgress((i + 1) / Math.max(1, times.length));
    }
    o.onProgress?.(1);

    return {
      frames,
      times: frameTimes(times, stamps),
      width: size.width,
      height: size.height,
      sourceFps: fps,
      fps,
      duration,
      truncated: times.length >= o.maxFrames && span * fps > o.maxFrames,
      missing,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    if (owned) URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * 表紙の書き出し用に、指定した秒のコマを素材の大きさ（長辺 `longSide` まで）で取り出す（`decodeFramesAt` の予備の道）。
 * 返す形も同じ（渡した秒と同じ並び、取れなかった所は null）。
 */
export async function decodeFramesAtViaElement(
  source: Blob | string,
  times: number[],
  { longSide = EXPORT_LONG_SIDE }: { longSide?: number } = {},
): Promise<(ExportedFrame | null)[]> {
  if (!times.length) return [];
  const owned = typeof source !== 'string';
  const url = owned ? URL.createObjectURL(source) : source;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const canvas = document.createElement('canvas');
  try {
    video.src = url;
    if (!(await waitFor(video, 'loadeddata', LOAD_TIMEOUT_MS))) throw new Error('この端末では、この動画を読み込めませんでした');
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const size = exportSize(sourceWidth, sourceHeight, longSide);
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('キャンバスを初期化できませんでした');
    const out: (ExportedFrame | null)[] = times.map(() => null);
    for (let i = 0; i < times.length; i += 1) {
      const seeked = waitFor(video, 'seeked', SEEK_TIMEOUT_MS);
      video.currentTime = Math.min(Math.max(0, times[i]), Math.max(0, video.duration - 1e-3));
      if (!(await seeked) || video.readyState < 2) continue;
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const image = ctx.getImageData(0, 0, size.width, size.height);
      out[i] = { time: times[i], width: image.width, height: image.height, data: image.data, sourceWidth, sourceHeight };
    }
    return out;
  } finally {
    video.removeAttribute('src');
    video.load();
    if (owned) URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}
