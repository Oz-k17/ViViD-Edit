/**
 * 書き出し（フレーム精度）。
 *
 * MediaRecorder による収録は「実時間キャプチャ」なので、書き出している最中に
 * デコードやエンコードが 1 度でも間に合わないと、その瞬間のカクつき・音切れが
 * そのままファイルに焼き付いてしまう。重い素材ほど確実に破綻する。
 *
 * ここでは実時間から完全に切り離し、
 *   1. 素材を WebCodecs でデコードし、必要なフレームだけを 1 枚ずつ取り出す
 *   2. そのフレームでキャンバスを描き、1 枚ずつエンコードする
 *   3. 音は OfflineAudioContext でタイムライン全体を一括ミックスしてから乗せる
 * という手順にする。1 枚ごとに「描けるまで待つ」ので、端末が遅くても出力は絶対に
 * コマ落ちしない（そのぶん書き出しには実時間より長くかかることがある）。
 */

import {
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  Quality,
  WEBM,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { mediaRegistry } from './media';
import { renderFrame, type RenderSources } from './renderer';
import { previousAdjacent } from '../model/ops';
import { sourceTimeAt, type Clip, type Sequence } from '../model/types';

/**
 * 読み込める素材の形式。
 * mediabunny の ALL_FORMATS を使うと全形式のデマルチプレクサを抱き込んで
 * 配布物が倍近くになるので、このアプリが実際に扱う映像の入れ物だけに絞る。
 */
const VIDEO_INPUT_FORMATS = [MP4, QTFF, MATROSKA, WEBM];

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** 音を出力へ流し込む単位（秒）。まとめて渡すとメモリを食うので刻む。 */
const AUDIO_CHUNK_SECONDS = 1;

/** この方式が使えない環境であることを示す（呼び出し側は従来の収録方式へ切り替える）。 */
export class FrameExportUnsupported extends Error {}

export interface FrameExportOptions {
  /** 書き出す解像度を反映済みのシーケンス。 */
  sequence: Sequence;
  duration: number;
  fps: number;
  /** 映像のビットレート（bps）。 */
  bitrate: number;
  format: 'auto' | 'mp4' | 'webm';
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface FrameExportOutput {
  blob: Blob;
  mimeType: string;
  ext: string;
}

export function isFrameExportSupported(): boolean {
  const g = globalThis as Record<string, unknown>;
  return (
    typeof g.VideoEncoder === 'function' &&
    typeof g.VideoDecoder === 'function' &&
    typeof g.AudioEncoder === 'function' &&
    typeof g.OfflineAudioContext === 'function'
  );
}

function clampSpeed(speed: number): number {
  return Math.max(0.0625, Math.min(16, speed || 1));
}

/** 素材内の再生位置（ループを考慮）。プレビュー側と同じ計算。 */
function sourceTimeFor(clip: Clip, time: number, assetDuration: number): number {
  const raw = sourceTimeAt(clip, time);
  if (!clip.loop || assetDuration <= 0) return raw;
  const span = Math.max(0.1, assetDuration - clip.sourceIn);
  return clip.sourceIn + ((raw - clip.sourceIn) % span);
}

/**
 * その時刻に映像として描かれるクリップ。
 * renderer 側が transition のときに前のカットも描くので、ここでも同じ条件で拾う。
 */
function visibleVideoClips(sequence: Sequence, time: number): Clip[] {
  const out: Clip[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    const current = sequence.clips.find(
      (c) => c.trackId === track.id && time >= c.start && time < c.start + c.duration,
    );
    if (!current) continue;
    if (current.kind === 'video') out.push(current);
    const transition = current.transitionIn;
    if (transition.type !== 'none' && transition.duration > 0 && time < current.start + transition.duration) {
      const previous = previousAdjacent(sequence, current);
      if (previous && previous.kind === 'video') out.push(previous);
    }
  }
  return out;
}

// ---------- 形式とコーデックの選択 ----------

interface PickedTarget {
  format: OutputFormat;
  ext: string;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | null;
}

async function pickTarget(
  prefer: 'auto' | 'mp4' | 'webm',
  width: number,
  height: number,
  bitrate: number,
  needsAudio: boolean,
): Promise<PickedTarget | null> {
  const mp4 = {
    make: () => new Mp4OutputFormat({ fastStart: 'in-memory' as const }),
    ext: 'mp4',
    // MP4 を選ぶ意味は「どこでも再生できる」ことなので、H.264 / H.265 が使えないなら
    // 中途半端な MP4 を作らず WebM に回す。
    video: ['avc', 'hevc'] as VideoCodec[],
    // 音も同じ理由で AAC だけに絞る。MP4 に Opus を入れたファイルは規格上は正しいが、
    // QuickTime・iOS の写真アプリ・一部の SNS が音声トラックを再生できず、
    // 「映像は出るのに音が入っていない」動画になってしまう。
    audio: ['aac'] as AudioCodec[],
  };
  const webm = {
    make: () => new WebMOutputFormat(),
    ext: 'webm',
    video: ['vp9', 'vp8', 'av1'] as VideoCodec[],
    audio: ['opus'] as AudioCodec[],
  };
  // MP4（H.264）がいちばん通りやすいので既定はそちら。
  const candidates = prefer === 'webm' ? [webm, mp4] : [mp4, webm];

  let fallback: PickedTarget | null = null;
  for (const candidate of candidates) {
    const format = candidate.make();
    const supported = new Set<string>(format.getSupportedCodecs());
    const videoCodec = await getFirstEncodableVideoCodec(
      candidate.video.filter((c) => supported.has(c)),
      { width, height, quality: new Quality({ bitrate }) },
    );
    if (!videoCodec) continue;
    const audioCodec = await getFirstEncodableAudioCodec(
      candidate.audio.filter((c) => supported.has(c)),
      { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE },
    );
    const picked: PickedTarget = { format, ext: candidate.ext, videoCodec, audioCodec };
    // 音のあるプロジェクトなのに、その入れ物では音を載せられない場合は次の候補へ。
    // 無音の動画を黙って書き出してしまうより、形式を変えてでも音を残す方がよい。
    if (needsAudio && !audioCodec) {
      fallback ??= picked;
      continue;
    }
    return picked;
  }
  // どの入れ物でも音を載せられなかったときだけ、映像だけで書き出す。
  return fallback;
}

// ---------- 音 ----------

/** 素材の実体（Blob）を取り出す。mediaRegistry は object URL しか持っていないので取り直す。 */
async function assetBlob(mediaId: string): Promise<Blob | null> {
  const asset = mediaRegistry.get(mediaId);
  if (!asset) return null;
  try {
    const response = await fetch(asset.url);
    return await response.blob();
  } catch {
    return null;
  }
}

/**
 * タイムライン全体の音を 1 本にミックスする。
 * 実時間で鳴らさず OfflineAudioContext で一括計算するので、
 * 端末が重くてもプチノイズや欠落が入りようがない。
 */
async function renderAudioMix(sequence: Sequence, duration: number): Promise<AudioBuffer | null> {
  const sounding = sequence.clips.filter((c) => (c.kind === 'video' || c.kind === 'audio') && c.mediaId);
  if (sounding.length === 0) return null;

  const trackById = new Map(sequence.tracks.map((t) => [t.id, t]));
  const decoded = new Map<string, AudioBuffer | null>();
  const decodeCtx = new OfflineAudioContext(1, 1, SAMPLE_RATE);

  for (const clip of sounding) {
    const mediaId = clip.mediaId as string;
    if (decoded.has(mediaId)) continue;
    const blob = await assetBlob(mediaId);
    if (!blob) {
      decoded.set(mediaId, null);
      continue;
    }
    try {
      decoded.set(mediaId, await decodeCtx.decodeAudioData(await blob.arrayBuffer()));
    } catch {
      // 音声トラックを持たない映像など。無音として扱う。
      decoded.set(mediaId, null);
    }
  }

  if (![...decoded.values()].some(Boolean)) return null;

  const length = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(CHANNELS, length, SAMPLE_RATE);
  let scheduled = 0;

  /** 1 本ぶんの音を置く。gainShape が音量の時間変化を組み立てる。 */
  const place = (
    buffer: AudioBuffer,
    startAt: number,
    offset: number,
    wallSeconds: number,
    speed: number,
    shape: (gain: GainNode, from: number, to: number) => void,
    loop: { start: number } | null,
  ) => {
    if (wallSeconds <= 0 || offset >= buffer.duration) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    shape(gain, startAt, startAt + wallSeconds);
    if (loop) {
      source.loop = true;
      source.loopStart = Math.min(loop.start, Math.max(0, buffer.duration - 0.05));
      source.loopEnd = buffer.duration;
    }
    source.start(startAt, offset, wallSeconds * speed);
    source.stop(startAt + wallSeconds);
    scheduled += 1;
  };

  for (const clip of sounding) {
    const buffer = decoded.get(clip.mediaId as string);
    if (!buffer) continue;
    if (clip.muted || trackById.get(clip.trackId)?.muted) continue;

    const start = Math.max(0, clip.start);
    const end = Math.min(duration, clip.start + clip.duration);
    if (end <= start) continue;
    const volume = Math.max(0, clip.volume);
    const speed = clampSpeed(clip.speed);

    place(
      buffer,
      start,
      clip.sourceIn,
      end - start,
      speed,
      (gain, from, to) => {
        // プレビュー側の fadeEnvelope と同じ直線フェード。
        const fadeIn = Math.max(0, Math.min(clip.fadeIn, to - from));
        const fadeOut = Math.max(0, Math.min(clip.fadeOut, to - from));
        gain.gain.setValueAtTime(fadeIn > 0 ? 0 : volume, from);
        if (fadeIn > 0) gain.gain.linearRampToValueAtTime(volume, from + fadeIn);
        if (fadeOut > 0) {
          gain.gain.setValueAtTime(volume, Math.max(from, to - fadeOut));
          gain.gain.linearRampToValueAtTime(0, to);
        }
      },
      clip.loop ? { start: clip.sourceIn } : null,
    );
  }

  // トランジション中は前のカットの音も引き延ばして重ねる（プレビューと同じ）。
  for (const clip of sequence.clips) {
    if (clip.kind !== 'video') continue;
    const transition = clip.transitionIn;
    if (transition.type === 'none' || transition.duration <= 0) continue;
    const previous = previousAdjacent(sequence, clip);
    if (!previous || !previous.mediaId) continue;
    if (previous.muted || trackById.get(previous.trackId)?.muted) continue;
    // プレビュー側は fadeOut があると引き延ばし分が無音になるので、ここでも合わせる。
    if (previous.fadeOut > 0) continue;
    const buffer = decoded.get(previous.mediaId);
    if (!buffer) continue;

    const speed = clampSpeed(previous.speed);
    const startAt = clip.start;
    const span = Math.min(transition.duration, Math.max(0, duration - startAt));
    const volume = Math.max(0, previous.volume);
    place(
      buffer,
      startAt,
      previous.sourceIn + previous.duration * speed,
      span,
      speed,
      (gain, from, to) => {
        gain.gain.setValueAtTime(volume, from);
        gain.gain.linearRampToValueAtTime(0, to);
      },
      null,
    );
  }

  if (scheduled === 0) return null;
  return ctx.startRendering();
}

/** ミックス済みの音を、出力へ渡せる長さに切り出す。 */
function sliceAudio(source: AudioBuffer, fromSample: number, sampleCount: number): AudioBuffer {
  const slice = new AudioBuffer({
    length: sampleCount,
    numberOfChannels: source.numberOfChannels,
    sampleRate: source.sampleRate,
  });
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    slice.copyToChannel(source.getChannelData(channel).subarray(fromSample, fromSample + sampleCount), channel);
  }
  return slice;
}

// ---------- 本体 ----------

export async function runFrameAccurateExport(options: FrameExportOptions): Promise<FrameExportOutput> {
  const { sequence, fps, duration, onProgress, isCancelled } = options;
  if (!isFrameExportSupported()) {
    throw new FrameExportUnsupported('この環境では WebCodecs が使えません');
  }

  // 文字が代替フォントのまま焼き込まれないよう、読み込みを待つ。
  await document.fonts?.ready?.catch?.(() => undefined);

  const totalFrames = Math.max(1, Math.round(duration * fps));
  onProgress(0);

  // 音は先に作る。トラック構成だけでなく、
  // 「音を載せられる入れ物か」で形式を選び分けるのにも要るため。
  const mix = await renderAudioMix(sequence, duration);
  if (isCancelled()) throw new Error('書き出しを中止しました');

  const picked = await pickTarget(
    options.format,
    sequence.width,
    sequence.height,
    options.bitrate,
    mix !== null,
  );
  if (!picked) throw new FrameExportUnsupported('この環境では書き出しに使えるコーデックが見つかりませんでした');

  const canvas = document.createElement('canvas');
  canvas.width = sequence.width;
  canvas.height = sequence.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');

  const output = new Output({ format: picked.format, target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, {
    codec: picked.videoCodec,
    quality: new Quality({ bitrate: options.bitrate }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  const audioSource =
    mix && picked.audioCodec
      ? new AudioBufferSource({ codec: picked.audioCodec, quality: new Quality({ bitrate: 128_000 }) })
      : null;
  if (audioSource) output.addAudioTrack(audioSource);

  // クリップごとに、必要なフレームの素材内時刻をあらかじめ並べておく。
  // 昇順に並んでいれば mediabunny 側がデコードを 1 パスで済ませてくれる。
  interface ClipStream {
    clip: Clip;
    frames: number[];
    times: number[];
    cursor: number;
    input?: Input;
    iterator?: AsyncGenerator<WrappedCanvas | null, void, unknown>;
  }
  const streams = new Map<string, ClipStream>();

  for (let i = 0; i < totalFrames; i += 1) {
    const time = i / fps;
    for (const clip of visibleVideoClips(sequence, time)) {
      if (!clip.mediaId) continue;
      let stream = streams.get(clip.id);
      if (!stream) {
        stream = { clip, frames: [], times: [], cursor: 0 };
        streams.set(clip.id, stream);
      }
      if (stream.frames[stream.frames.length - 1] === i) continue;
      const asset = mediaRegistry.get(clip.mediaId);
      stream.frames.push(i);
      stream.times.push(Math.max(0, sourceTimeFor(clip, time, asset?.duration ?? 0)));
    }
  }

  const frames = new Map<string, WrappedCanvas['canvas'] | null>();
  const cleanup: (() => void)[] = [];

  const sources: RenderSources = {
    frameFor: (clip) => {
      if (clip.kind === 'image') {
        const img = mediaRegistry.imageElement(clip.mediaId);
        return img?.complete ? img : null;
      }
      if (clip.kind !== 'video') return null;
      return frames.get(clip.id) ?? null;
    },
    sizeFor: (clip) => {
      const decodedFrame = frames.get(clip.id);
      if (decodedFrame && decodedFrame.width > 0 && decodedFrame.height > 0) {
        return { width: decodedFrame.width, height: decodedFrame.height };
      }
      const asset = mediaRegistry.get(clip.mediaId);
      return asset ? { width: asset.width, height: asset.height } : null;
    },
    emojiFor: (mediaId) => {
      const img = mediaRegistry.imageElement(mediaId);
      return img?.complete ? img : null;
    },
  };

  try {
    // 素材ごとのデコーダを用意する。
    for (const stream of streams.values()) {
      const blob = await assetBlob(stream.clip.mediaId as string);
      if (!blob) continue;
      const input = new Input({ source: new BlobSource(blob), formats: VIDEO_INPUT_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) continue;
      const sink = new CanvasSink(track);
      stream.input = input;
      stream.iterator = sink.canvasesAtTimestamps(stream.times);
      cleanup.push(() => void stream.iterator?.return(undefined));
    }

    await output.start();

    const mixChannels = mix?.numberOfChannels ?? 0;
    const mixLength = mix?.length ?? 0;
    let audioSamplesSent = 0;
    const chunkSamples = Math.round(AUDIO_CHUNK_SECONDS * SAMPLE_RATE);

    const pushAudioUpTo = async (seconds: number) => {
      if (!mix || !audioSource || mixChannels === 0) return;
      const wanted = Math.min(mixLength, Math.ceil(seconds * SAMPLE_RATE));
      while (audioSamplesSent < wanted) {
        const count = Math.min(chunkSamples, mixLength - audioSamplesSent);
        if (count <= 0) break;
        await audioSource.add(sliceAudio(mix, audioSamplesSent, count));
        audioSamplesSent += count;
      }
    };

    for (let i = 0; i < totalFrames; i += 1) {
      if (isCancelled()) throw new Error('書き出しを中止しました');
      const time = i / fps;

      // このフレームで要る素材フレームを取り出す。取り出せるまで待つので、
      // 端末が遅くても「間に合わなかった」コマは発生しない。
      for (const stream of streams.values()) {
        if (stream.frames[stream.cursor] !== i) continue;
        stream.cursor += 1;
        if (!stream.iterator) {
          frames.set(stream.clip.id, null);
          continue;
        }
        const next = await stream.iterator.next();
        frames.set(stream.clip.id, next.done ? null : (next.value?.canvas ?? null));
      }

      renderFrame(ctx, sequence, time, sources, { guides: false, selectedIds: [] });
      await videoSource.add(time, 1 / fps);
      // 映像より少し先まで音を流し込んでおく（多重化のバッファを膨らませないため）。
      await pushAudioUpTo(time + AUDIO_CHUNK_SECONDS * 2);

      onProgress((i + 1) / totalFrames);
    }

    await pushAudioUpTo(Number.POSITIVE_INFINITY);
    await output.finalize();
  } catch (error) {
    if (output.state === 'started' || output.state === 'pending') await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    cleanup.forEach((fn) => fn());
  }

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('書き出したデータを取り出せませんでした');
  const mimeType = await output.getMimeType();
  return { blob: new Blob([buffer], { type: mimeType }), mimeType, ext: picked.ext };
}
