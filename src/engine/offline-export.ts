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

import { finishMix } from './finish';
import { canWriteFiles, FILE_SINK_THRESHOLD_BYTES, openExportSink } from './export-sink';
import {
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  UrlSource,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { VIDEO_INPUT_FORMATS } from './formats';
import { mediaRegistry } from './media';
import { renderFrame, type RenderSources } from './renderer';
import { previousAdjacent } from '../model/ops';
import { sourceTimeAt, type Clip, type Sequence } from '../model/types';


const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** 音を出力へ流し込む単位（秒）。まとめて渡すとメモリを食うので刻む。 */
const AUDIO_CHUNK_SECONDS = 1;
/** 音量の仕上げ（全体を見て整える）をする上限の長さ。これを超えると全長のバッファが大きすぎる。 */
const FINISH_AUDIO_MAX_SECONDS = 600;

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
  /** 書き出す音に音量仕上げ（-14 LUFS・-1 dBTP）を当てる（試験的）。 */
  finishAudio?: boolean;
  /** 大きい出力をファイルへ書き始める見込みサイズ（バイト）。試験用に変えられる。 */
  fileThresholdBytes?: number;
  /** 音を区間に分けて作る長さ（秒）。試験用に変えられる。 */
  audioSegmentSeconds?: number;
  /**
   * 高速エンコード（既定は切）。ソフトウェアの符号化（VP9 など）で `latencyMode: 'realtime'` を使う。
   * 画面の動きが激しい合成フレームでは、画質・サイズを変えずに 2.6 倍速かった（43ms → 17ms / コマ）が、
   * 動きの少ない実際のプロジェクトでは差が測れなかった。**効果は中身しだい**なので、既定は切にしてある。
   * H.264 / H.265 には使わない（ハードウェア符号化は元から速く、効果を測れていない）。
   * エンコーダが追いつかずコマを落としたら、自動で通常モードでやり直す。
   */
  fast?: boolean;
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface FrameExportOutput {
  blob: Blob;
  mimeType: string;
  ext: string;
  /** 音が入れられなかったなど、書き出せてはいるが伝えるべきこと。 */
  warning?: string;
  /** 音量仕上げの結果など、伝えておくとよいこと。 */
  note?: string;
  /** エンコーダが落としたコマ数（通常は 0）。呼び出し側へは渡さない内部用。 */
  dropped?: number;
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
  streaming: boolean,
): Promise<PickedTarget | null> {
  const mp4 = {
    // ファイルへ書くときは目次（moov）を末尾に置く。先頭に置くには全部をメモリに溜める必要がある。
    make: () => new Mp4OutputFormat({ fastStart: streaming ? (false as const) : ('in-memory' as const) }),
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

/** 音を持ちうるクリップの数。書き出し結果に音が無いときの警告判定に使う。 */
function soundingClips(sequence: Sequence): number {
  return sequence.clips.filter((c) => (c.kind === 'video' || c.kind === 'audio') && c.mediaId).length;
}

/** 素材の実体（Blob）を取り出す。mediaRegistry は object URL しか持っていないので取り直す。 */
export async function assetBlob(mediaId: string): Promise<Blob | null> {
  const asset = mediaRegistry.get(mediaId);
  if (!asset) return null;
  try {
    const response = await fetch(asset.url);
    return await response.blob();
  } catch {
    return null;
  }
}

/** デコードした断片を 1 本の AudioBuffer につなぐ。元の標本化周波数のまま（ミックス側で WebAudio が変換する）。 */
function mergeAudioParts(parts: AudioBuffer[]): AudioBuffer {
  const channels = Math.max(...parts.map((p) => p.numberOfChannels));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const merged = new AudioBuffer({ length: total, numberOfChannels: channels, sampleRate: parts[0].sampleRate });
  let offset = 0;
  for (const part of parts) {
    for (let channel = 0; channel < channels; channel += 1) {
      merged.copyToChannel(part.getChannelData(Math.min(channel, part.numberOfChannels - 1)), channel, offset);
    }
    offset += part.length;
  }
  return merged;
}

/**
 * 素材の音を丸ごと 1 本の AudioBuffer にする。
 *
 * 取り出し方を 2 通り用意してある。
 *  1. mediabunny（WebCodecs）。映像と同じ経路なので、映像がデコードできる素材なら
 *     音も取り出せる。
 *  2. decodeAudioData。mp3 や wav のような、映像コンテナではない素材のため。
 *
 * 以前は 2 だけに頼っていたが、これは端末やファイルによっては映像が読めても失敗することが
 * あり、しかも失敗しても例外を握りつぶして「音の無い動画」が黙って出来上がっていた。
 */
export async function decodeAssetAudio(mediaId: string): Promise<AudioBuffer | null> {
  const blob = await assetBlob(mediaId);
  if (!blob) return null;

  // デコーダは端末ごとに同時に持てる数が決まっている。使い終わったら必ず閉じること。
  // 開きっぱなしにすると、あとから映像側のデコーダを作れなくなり
  // 「decoder failure」で書き出し全体が落ちる。
  let input: Input | null = null;
  try {
    input = new Input({ source: new BlobSource(blob), formats: VIDEO_INPUT_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (track) {
      const sink = new AudioBufferSink(track);
      const parts: AudioBuffer[] = [];
      for await (const wrapped of sink.buffers()) parts.push(wrapped.buffer);
      if (parts.length > 0) return mergeAudioParts(parts);
    }
  } catch {
    /* 映像コンテナではない、音声トラックが無い、デコードに失敗した等。下の方法へ。 */
  } finally {
    input?.dispose();
  }

  try {
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 素材の音のうち、`from`〜`to`（素材内の秒）だけを取り出す。
 *
 * 長い素材（3 時間など）で、使うのが数十秒でも全部をデコードしてしまうと、
 * メモリも時間も素材の長さに比例して食う。ここは使う範囲だけ。
 * 返す `start` は、先頭の標本が素材の何秒にあたるか（コマの区切りで `from` とは少しずれる）。
 * NAS 参照の素材は、ファイルを丸ごと落とさず、必要な範囲だけを Range で読む。
 */
export async function decodeAssetAudioRange(
  mediaId: string,
  from: number,
  to: number,
): Promise<{ buffer: AudioBuffer; start: number } | null> {
  const asset = mediaRegistry.get(mediaId);
  if (!asset) return null;
  const begin = Math.max(0, from);

  let input: Input | null = null;
  try {
    const source = asset.src ? new UrlSource(asset.url) : new BlobSource((await assetBlob(mediaId)) as Blob);
    input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (track) {
      const sink = new AudioBufferSink(track);
      const parts: AudioBuffer[] = [];
      let start = begin;
      for await (const wrapped of sink.buffers(begin, to)) {
        if (parts.length === 0) start = wrapped.timestamp;
        parts.push(wrapped.buffer);
      }
      if (parts.length > 0) {
        const merged = mergeAudioParts(parts);
        // 範囲が素材の外だと、最後の断片が 1 つだけ返ることがある。範囲に掛かっていなければ「無い」とする。
        if (start >= to || start + merged.duration <= begin) return null;
        return { buffer: merged, start };
      }
    }
  } catch {
    /* 映像コンテナではない、音声トラックが無い、デコードに失敗した等。下の方法へ。 */
  } finally {
    input?.dispose();
  }

  // mp3・wav など。こちらは全部を読むしかないので、読んだあとで範囲だけ切り出す。
  const whole = await decodeAssetAudio(mediaId);
  if (!whole) return null;
  const rate = whole.sampleRate;
  const first = Math.min(whole.length, Math.floor(begin * rate));
  const last = Math.min(whole.length, Math.ceil(to * rate));
  if (last <= first) return null;
  return { buffer: sliceAudio(whole, first, last - first), start: first / rate };
}

/** 音量の時間変化。折れ線（時刻は絶対秒）。 */
type GainPoints = { t: number; v: number }[];

function gainAt(points: GainPoints, t: number): number {
  if (points.length === 0) return 1;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1].v;
}

/** 1 本ぶんの鳴らし方（タイムライン上の絶対時刻で持つ）。 */
interface AudioJob {
  mediaId: string;
  /** タイムライン上の開始秒と長さ。 */
  at: number;
  wall: number;
  /** 素材内の開始秒。 */
  sourceOffset: number;
  speed: number;
  gain: GainPoints;
  /** ループするクリップは素材の頭から繰り返す（素材の全体が要る）。 */
  loop: { start: number } | null;
}

/** 区間ごとに作れるミキサー。全長を 1 本のバッファにせず、30 秒ずつなど必要な所だけ作る。 */
export interface AudioMixer {
  /** 全長（標本数）。 */
  length: number;
  /** `fromSample` から `count` 標本ぶんをミックスする。 */
  renderSegment(fromSample: number, count: number): Promise<AudioBuffer>;
  dispose(): void;
}

/** 区間の手前から余分にデコードする長さ（秒）。 */
const AUDIO_PREROLL_SECONDS = 0.5;

/** ミキサーが 1 区間で作る長さ（秒）。 */
export const AUDIO_SEGMENT_SECONDS = 30;

/**
 * タイムライン全体の音を、区間ごとにミックスできる形で用意する。
 * 実時間で鳴らさず OfflineAudioContext で計算するので、端末が重くてもプチノイズや欠落が入りようがない。
 *
 * 全長を 1 本で作ると、3 時間ならそれだけで約 4GB になる。区間ごとに作って、
 * 出力へ流し込んだらすぐ捨てれば、長さに関わらずメモリは区間ぶんで済む。
 * どの素材にも音が無いときは null。
 */
export async function createAudioMixer(sequence: Sequence, duration: number): Promise<AudioMixer | null> {
  const sounding = sequence.clips.filter((c) => (c.kind === 'video' || c.kind === 'audio') && c.mediaId);
  if (sounding.length === 0) return null;
  const trackById = new Map(sequence.tracks.map((t) => [t.id, t]));

  const jobs: AudioJob[] = [];
  for (const clip of sounding) {
    if (clip.muted || trackById.get(clip.trackId)?.muted) continue;
    const start = Math.max(0, clip.start);
    const end = Math.min(duration, clip.start + clip.duration);
    if (end <= start) continue;
    const volume = Math.max(0, clip.volume);
    const speed = clampSpeed(clip.speed);
    // プレビュー側の fadeEnvelope と同じ直線フェード。
    const wall = end - start;
    const fadeIn = Math.max(0, Math.min(clip.fadeIn, wall));
    const fadeOut = Math.max(0, Math.min(clip.fadeOut, wall));
    const gain: GainPoints = [{ t: start, v: fadeIn > 0 ? 0 : volume }];
    if (fadeIn > 0) gain.push({ t: start + fadeIn, v: volume });
    if (fadeOut > 0) {
      gain.push({ t: Math.max(start, end - fadeOut), v: volume });
      gain.push({ t: end, v: 0 });
    } else {
      gain.push({ t: end, v: volume });
    }
    jobs.push({
      mediaId: clip.mediaId as string,
      at: start,
      wall,
      sourceOffset: clip.sourceIn,
      speed,
      gain,
      loop: clip.loop ? { start: clip.sourceIn } : null,
    });
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
    const speed = clampSpeed(previous.speed);
    const span = Math.min(transition.duration, Math.max(0, duration - clip.start));
    if (span <= 0) continue;
    const volume = Math.max(0, previous.volume);
    jobs.push({
      mediaId: previous.mediaId,
      at: clip.start,
      wall: span,
      sourceOffset: previous.sourceIn + previous.duration * speed,
      speed,
      gain: [
        { t: clip.start, v: volume },
        { t: clip.start + span, v: 0 },
      ],
      loop: null,
    });
  }
  if (jobs.length === 0) return null;

  // 音を持つ素材があるか。素材ごとに頭の少しだけデコードして確かめる（全部は読まない）。
  let anyAudio = false;
  for (const mediaId of new Set(jobs.map((j) => j.mediaId))) {
    const probe = await decodeAssetAudioRange(mediaId, 0, 0.5).catch(() => null);
    if (probe) {
      anyAudio = true;
      break;
    }
  }
  if (!anyAudio) return null;

  /** 全体が要る素材（ループ）は一度だけデコードして持つ。 */
  const wholeCache = new Map<string, { buffer: AudioBuffer; start: number } | null>();
  const length = Math.max(1, Math.ceil(duration * SAMPLE_RATE));

  const renderSegment = async (fromSample: number, count: number): Promise<AudioBuffer> => {
    const t0 = fromSample / SAMPLE_RATE;
    const t1 = (fromSample + count) / SAMPLE_RATE;
    const ctx = new OfflineAudioContext(CHANNELS, Math.max(1, count), SAMPLE_RATE);

    interface Piece {
      job: AudioJob;
      /** 区間内での開始・終了（絶対秒）。 */
      a0: number;
      a1: number;
      offset: number;
    }
    const pieces: Piece[] = [];
    for (const job of jobs) {
      const a0 = Math.max(job.at, t0);
      const a1 = Math.min(job.at + job.wall, t1);
      if (a1 <= a0) continue;
      pieces.push({ job, a0, a1, offset: job.sourceOffset + (a0 - job.at) * job.speed });
    }

    // 素材ごとに、この区間で鳴らす範囲だけをデコードする。
    const need = new Map<string, { from: number; to: number }>();
    for (const { job, offset, a0, a1 } of pieces) {
      if (job.loop) continue;
      const to = offset + (a1 - a0) * job.speed;
      const n = need.get(job.mediaId);
      if (!n) need.set(job.mediaId, { from: offset, to });
      else {
        n.from = Math.min(n.from, offset);
        n.to = Math.max(n.to, to);
      }
    }
    const decoded = new Map<string, { buffer: AudioBuffer; start: number } | null>();
    for (const [mediaId, range] of need) {
      // 範囲の前後に余白を持たせる（コマの区切りで端が欠けないように）。手前は長めに取る:
      // 圧縮音声は途中から読み始めると、最初の数十ミリ秒はデコーダの状態が整わず、継ぎ目で小さなプチ音になる。
      decoded.set(mediaId, await decodeAssetAudioRange(mediaId, range.from - AUDIO_PREROLL_SECONDS, range.to + 0.1));
    }
    for (const { job } of pieces) {
      if (job.loop && !wholeCache.has(job.mediaId)) {
        const buffer = await decodeAssetAudio(job.mediaId);
        wholeCache.set(job.mediaId, buffer ? { buffer, start: 0 } : null);
      }
    }

    for (const { job, a0, a1, offset: rawOffset } of pieces) {
      const audio = job.loop ? wholeCache.get(job.mediaId) : decoded.get(job.mediaId);
      if (!audio) continue;
      const { buffer } = audio;
      const speed = job.speed;
      let offset = rawOffset - audio.start;
      let at = a0;
      let wall = a1 - a0;
      if (job.loop) {
        // 区間の途中から入るとき、ループ内の位置に直す。
        const loopStart = Math.min(job.loop.start - audio.start, Math.max(0, buffer.duration - 0.05));
        const span = buffer.duration - loopStart;
        if (offset >= buffer.duration && span > 0) offset = loopStart + ((offset - loopStart) % span);
      } else if (offset < 0) {
        // デコードできた範囲の手前（コマの区切りのずれ）。そのぶん開始を遅らせる。
        const shift = -offset / speed;
        at += shift;
        wall -= shift;
        offset = 0;
      }
      if (wall <= 0 || offset >= buffer.duration) continue;
      // 素材内の位置が標本のちょうど上にあるはずのとき、浮動小数点の誤差で 1 標本ずれないよう吸い寄せる
      // （区間の継ぎ目で、位相が 1 標本ずれて小さなプチ音になるのを防ぐ）。
      const frames = offset * buffer.sampleRate;
      if (Math.abs(frames - Math.round(frames)) < 0.01) offset = Math.round(frames) / buffer.sampleRate;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speed;
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      // 音量: 折れ線を、この区間内の時刻（区間の先頭が 0 秒）に写して予約する。
      const param = gain.gain;
      param.setValueAtTime(gainAt(job.gain, at), at - t0);
      for (const p of job.gain) {
        if (p.t > at && p.t < at + wall) param.linearRampToValueAtTime(p.v, p.t - t0);
      }
      param.linearRampToValueAtTime(gainAt(job.gain, at + wall), at + wall - t0);
      if (job.loop) {
        source.loop = true;
        source.loopStart = Math.min(job.loop.start - audio.start, Math.max(0, buffer.duration - 0.05));
        source.loopEnd = buffer.duration;
      }
      source.start(at - t0, offset, wall * speed);
      source.stop(at + wall - t0);
    }
    return ctx.startRendering();
  };

  return { length, renderSegment, dispose: () => wholeCache.clear() };
}

/**
 * タイムライン全体の音を 1 本にミックスする（短い動画の音量仕上げ・試験用）。
 * 長い動画では全長のバッファが巨大になるので、通常の書き出しは `createAudioMixer` の区間ごとを使う。
 */
export async function renderAudioMix(sequence: Sequence, duration: number): Promise<AudioBuffer | null> {
  const mixer = await createAudioMixer(sequence, duration);
  if (!mixer) return null;
  try {
    return await mixer.renderSegment(0, mixer.length);
  } finally {
    mixer.dispose();
  }
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
  const fast = options.fast === true;
  const first = await runPass(options, fast);
  const { dropped = 0, ...output } = first;
  if (fast && dropped > 0) {
    // 高速モードで、エンコーダが追いつかずにコマを落とした。コマ落ちのある動画は渡さず、通常モードでやり直す。
    const retry = await runPass(options, false);
    const { dropped: _ignored, ...redone } = retry;
    return {
      ...redone,
      note: [redone.note, `高速モードでコマが ${dropped} 個落ちたので、通常モードで書き出し直しました`].filter(Boolean).join(' / '),
    };
  }
  return output;
}

async function runPass(options: FrameExportOptions, fast: boolean): Promise<FrameExportOutput> {
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
  // 音の取り出しに失敗しても、映像だけは必ず書き出せるようにする
  // （そのぶん下で警告を出す）。
  let mixer = await createAudioMixer(sequence, duration).catch(() => null);
  /** 音量仕上げをしたときだけ、全長を 1 本にしたもの（短い動画に限る）。 */
  let wholeMix: AudioBuffer | null = null;
  let note: string | undefined;
  if (mixer && options.finishAudio) {
    if (duration > FINISH_AUDIO_MAX_SECONDS) {
      note = `長い動画（${Math.round(FINISH_AUDIO_MAX_SECONDS / 60)} 分超）では、音量の仕上げは省きました（全体を一度に計算するとメモリが足りなくなるため）`;
    } else {
      try {
        const rendered = await mixer.renderSegment(0, mixer.length);
        try {
          const finished = finishMix(rendered);
          wholeMix = finished.buffer;
          note = `音量を整えました: ${finished.report.summary}`;
        } catch {
          wholeMix = rendered;
          note = '音量を整えられなかったので、そのまま書き出しました';
        }
      } catch {
        mixer.dispose();
        mixer = null;
      }
    }
  }
  if (isCancelled()) throw new Error('書き出しを中止しました');

  // 出力が大きいときはメモリに溜めず、ファイルへ書く。
  const estimateBytes = Math.ceil(((options.bitrate + (mixer ? 128_000 : 0)) * duration * 1.1) / 8);
  const fileThreshold = options.fileThresholdBytes ?? FILE_SINK_THRESHOLD_BYTES;
  const streaming = estimateBytes >= fileThreshold && (await canWriteFiles());

  const picked = await pickTarget(
    options.format,
    sequence.width,
    sequence.height,
    options.bitrate,
    mixer !== null,
    streaming,
  );
  if (!picked) throw new FrameExportUnsupported('この環境では書き出しに使えるコーデックが見つかりませんでした');

  const canvas = document.createElement('canvas');
  canvas.width = sequence.width;
  canvas.height = sequence.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');

  const sink = await openExportSink(estimateBytes, picked.ext, fileThreshold);
  if (sink.wantedFile && sink.kind === 'memory') {
    const mb = Math.round(estimateBytes / 1024 / 1024);
    note = [
      note,
      `出力が大きい（約 ${mb}MB）のに、この環境ではファイルへ逃がせないため、メモリ上で書き出します。途中で止まるときは、長さを分けるか画質を下げてください`,
    ]
      .filter(Boolean)
      .join(' / ');
  }
  const output = new Output({ format: picked.format, target: sink.target });
  let packets = 0;
  const realtime = fast && picked.videoCodec !== 'avc' && picked.videoCodec !== 'hevc';
  const videoSource = new CanvasSource(canvas, {
    codec: picked.videoCodec,
    quality: new Quality({ bitrate: options.bitrate }),
    keyFrameInterval: 2,
    latencyMode: realtime ? 'realtime' : 'quality',
    // 出力に入ったコマを数えておく（高速モードで落とされていないかの確認用）。
    onEncodedPacket: () => {
      packets += 1;
    },
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  const audioSource =
    mixer && picked.audioCodec
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
    opened?: boolean;
    input?: Input;
    iterator?: AsyncGenerator<WrappedCanvas | null, void, unknown>;
    /** 次のコマのデコード（エンコードを待つあいだに先に進めておく）。 */
    pending?: Promise<IteratorResult<WrappedCanvas | null, void>>;
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

  /**
   * デコーダは端末ごとに同時に持てる数が限られている（超えると decoder failure になる）。
   * クリップの数だけ最初に開くのではなく、必要になった時に開き、そのクリップの
   * 最後のコマを取り出したら即座に閉じる。こうすると同時に開くのは
   * 「その瞬間に映っているクリップ」の分だけで済む。
   */
  /**
   * 素材ごとの Input（ファイルの目次を読んだもの）を、書き出しのあいだ使い回す。
   * クリップごとに素材を読み直さない。シーン分割で同じ素材を何十個にも分けていると、
   * 以前は NAS 参照の素材でその回数ぶん**ファイル全体をダウンロード**していた。
   * NAS 参照の素材は Range で必要な所だけ読む（`UrlSource`）。
   * 同時に持つのは数本まで。使い終わった（参照が 0 の）ものから手放す。
   */
  const inputs = new Map<string, { input: Input; refs: number }>();
  const MAX_INPUTS = 4;
  const acquireInput = async (mediaId: string): Promise<Input | null> => {
    const cached = inputs.get(mediaId);
    if (cached) {
      cached.refs += 1;
      // 使った順に並べ直す（Map は挿入順なので、入れ直せば最後尾＝最近使った）。
      inputs.delete(mediaId);
      inputs.set(mediaId, cached);
      return cached.input;
    }
    const asset = mediaRegistry.get(mediaId);
    if (!asset) return null;
    let source: BlobSource | UrlSource;
    if (asset.src) {
      source = new UrlSource(asset.url);
    } else {
      const blob = await assetBlob(mediaId);
      if (!blob) return null;
      source = new BlobSource(blob);
    }
    const input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
    inputs.set(mediaId, { input, refs: 1 });
    for (const [key, entry] of inputs) {
      if (inputs.size <= MAX_INPUTS) break;
      if (entry.refs === 0 && key !== mediaId) {
        entry.input.dispose();
        inputs.delete(key);
      }
    }
    return input;
  };
  const releaseInput = (mediaId: string) => {
    const entry = inputs.get(mediaId);
    if (entry) entry.refs = Math.max(0, entry.refs - 1);
  };

  /**
   * デコーダは端末ごとに同時に持てる数が限られている（超えると decoder failure になる）。
   * クリップの数だけ最初に開くのではなく、必要になった時に開き、そのクリップの
   * 最後のコマを取り出したら即座に閉じる。こうすると同時に開くのは
   * 「その瞬間に映っているクリップ」の分だけで済む。
   */
  const openStream = async (stream: ClipStream) => {
    if (stream.opened) return;
    stream.opened = true;
    const mediaId = stream.clip.mediaId as string;
    const input = await acquireInput(mediaId);
    if (!input) return;
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      releaseInput(mediaId);
      return;
    }
    stream.input = input;
    // poolSize: デコードしたコマを入れるキャンバスを輪番で使い回す。先読み（次のコマを、いまのコマの描画後に
    // すぐ始める）でも、描画中のコマが上書きされないよう、3 枚持つ。
    stream.iterator = new CanvasSink(track, { poolSize: 3 }).canvasesAtTimestamps(stream.times);
  };

  const closeStream = (stream: ClipStream) => {
    void stream.iterator?.return(undefined);
    stream.iterator = undefined;
    stream.pending = undefined;
    if (stream.input) releaseInput(stream.clip.mediaId as string);
    stream.input = undefined;
  };

  cleanup.push(() => streams.forEach(closeStream));
  cleanup.push(() => {
    for (const entry of inputs.values()) entry.input.dispose();
    inputs.clear();
  });

  let audioFailed = false;
  try {
    await output.start();

    const mixLength = mixer?.length ?? 0;
    let audioSamplesSent = 0;
    const chunkSamples = Math.round(AUDIO_CHUNK_SECONDS * SAMPLE_RATE);
    const segmentSamples = Math.round((options.audioSegmentSeconds ?? AUDIO_SEGMENT_SECONDS) * SAMPLE_RATE);
    /** いま流し込んでいる区間（それより前は捨てる）。 */
    let segment: { from: number; buffer: AudioBuffer } | null = wholeMix ? { from: 0, buffer: wholeMix } : null;

    const segmentAt = async (sample: number) => {
      if (segment && sample >= segment.from && sample < segment.from + segment.buffer.length) return segment;
      const count = Math.min(segmentSamples, mixLength - sample);
      let buffer: AudioBuffer;
      try {
        buffer = await (mixer as AudioMixer).renderSegment(sample, count);
      } catch {
        // この区間の音だけ作れなかった。映像は書き出し続け、無音で埋めて、最後に知らせる。
        audioFailed = true;
        buffer = new AudioBuffer({ length: count, numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE });
      }
      segment = { from: sample, buffer };
      return segment;
    };

    const pushAudioUpTo = async (seconds: number) => {
      if (!mixer || !audioSource) return;
      const wanted = Math.min(mixLength, Math.ceil(seconds * SAMPLE_RATE));
      while (audioSamplesSent < wanted) {
        const current = await segmentAt(audioSamplesSent);
        const inSegment = current.from + current.buffer.length - audioSamplesSent;
        const count = Math.min(chunkSamples, mixLength - audioSamplesSent, inSegment);
        if (count <= 0) break;
        await audioSource.add(sliceAudio(current.buffer, audioSamplesSent - current.from, count));
        audioSamplesSent += count;
      }
    };

    for (let i = 0; i < totalFrames; i += 1) {
      if (isCancelled()) throw new Error('書き出しを中止しました');
      const time = i / fps;

      // このフレームで要る素材フレームを取り出す。取り出せるまで待つので、
      // 端末が遅くても「間に合わなかった」コマは発生しない。
      const advanced: ClipStream[] = [];
      for (const stream of streams.values()) {
        if (stream.frames[stream.cursor] !== i) continue;
        stream.cursor += 1;
        await openStream(stream);
        if (!stream.iterator) {
          frames.set(stream.clip.id, null);
          continue;
        }
        // 先読みが済んでいればそれを、無ければここで取り出す。
        const next = await (stream.pending ?? stream.iterator.next());
        stream.pending = undefined;
        frames.set(stream.clip.id, next.done ? null : (next.value?.canvas ?? null));
        // このクリップは使い終わったので、デコーダを次のクリップへ譲る。
        if (stream.cursor >= stream.frames.length) closeStream(stream);
        else advanced.push(stream);
      }

      renderFrame(ctx, sequence, time, sources, { guides: false, selectedIds: [] });
      // 次のコマのデコードを、エンコードを待つあいだに先に進めておく（描画は済んだので、キャンバスを渡してよい）。
      // デコードとエンコードを直列に待つと、どちらかが必ず遊んでしまう。
      for (const stream of advanced) {
        stream.pending = stream.iterator
          ?.next()
          .catch(() => ({ done: true, value: undefined }) as IteratorResult<WrappedCanvas | null, void>);
      }
      await videoSource.add(time, 1 / fps);
      // 映像より少し先まで音を流し込んでおく（多重化のバッファを膨らませないため）。
      await pushAudioUpTo(time + AUDIO_CHUNK_SECONDS * 2);

      onProgress((i + 1) / totalFrames);
    }

    await pushAudioUpTo(Number.POSITIVE_INFINITY);
    await output.finalize();
  } catch (error) {
    if (output.state === 'started' || output.state === 'pending') await output.cancel().catch(() => undefined);
    await sink.discard();
    throw error;
  } finally {
    cleanup.forEach((fn) => fn());
    mixer?.dispose();
  }

  const mimeType = await output.getMimeType();
  const blob = await sink.finish(mimeType);
  // 音のあるプロジェクトなのに音を載せられなかった場合は、黙って無音の動画を渡さない。
  let warning: string | undefined;
  if (soundingClips(sequence) > 0) {
    if (!mixer) warning = '素材から音を取り出せなかったため、音の入っていない動画になりました。';
    else if (!picked.audioCodec) warning = `この環境では ${picked.ext.toUpperCase()} に音を入れられませんでした。`;
    else if (audioFailed) warning = '一部の区間で音を作れず、その間は無音になっています。';
  }
  return {
    blob,
    mimeType,
    ext: picked.ext,
    warning,
    note,
    dropped: realtime ? Math.max(0, totalFrames - packets) : 0,
  };
}
