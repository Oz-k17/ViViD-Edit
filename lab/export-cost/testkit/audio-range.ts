/**
 * 「素材の要る範囲だけを起こす」を**本物の WebM / Opus で**測る。
 *
 * ## これは画面の一部ではない
 *
 * `index.html` からは読み込んでいない。`range.mjs` が playwright 越しに差し込むためだけに置いてある
 * （`testkit/audio.ts`・`testkit/measure.ts` と同じ理由・同じ置き方）。
 *
 * ## 素材を WAV ではなく WebM にしている理由
 *
 * `testkit/audio.ts` は WAV を `decodeAudioData` で起こしている。WAV は PCM なので
 * **バイトを切れば範囲が取れてしまい、範囲デコードの費用が測れない**
 * （頭出しも、packet の丸めも、デコーダの立ち上げも出てこない）。
 * 本体が素材に使うのは配信の録画（WebM / MP4）なので、ここは 1 回焼いてから
 * `AudioBufferSink.buffers(from, to)` で読む。**本体の `decodeAssetAudio` と同じ経路。**
 *
 * ## 何と何を比べるか
 *
 * - `whole` — いまの本体。`sink.buffers()` を端から端まで回して 1 本の `AudioBuffer` に繋ぐ。
 * - `ranges` — `planAssetDecodes` が組んだ区間だけを `buffers(from, to)` で起こす。
 *
 * 置き方（`windowSounds`）は**どちらも同じ 1 本の道**から出し、
 * 範囲の側だけ `offsetInParts` で区間の座標へ移す。差が出たらそれは範囲のせいだと言える。
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  Input,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import { CHANNELS, SAMPLE_RATE, soundsOf, splitAudioSequence, windowSounds } from '../src/audio-mix.ts';
import {
  DEFAULT_MERGE_GAP_SECONDS,
  DEFAULT_PREROLL_SECONDS,
  DEFAULT_TAIL_SECONDS,
  jetCutSequence,
  offsetInParts,
  planAssetDecodes,
  summarizeRangeCost,
  type DecodedPart,
} from '../src/audio-ranges.ts';
import { Fingerprint, SIGNATURE_BLOCK, placeInto, synth } from './audio.ts';

/** 焼いた素材は 1 回だけ作って使い回す（焼き直すと粒が変わって前後が比べられない）。 */
const bakedAssets = new Map<string, Blob>();

/**
 * 合成波を WebM / Opus に焼く。
 *
 * 1 秒ずつ渡しているのは、長い素材（10 分級）で `AudioBuffer` を 1 本作ると
 * **焼くだけでメモリの山が測りたいものより大きくなる**ため。
 */
async function bakeWebM(seconds: number): Promise<Blob> {
  const key = `${seconds}`;
  const hit = bakedAssets.get(key);
  if (hit) return hit;
  const codec = await getFirstEncodableAudioCodec(['opus', 'vorbis'], {
    numberOfChannels: 1,
    sampleRate: SAMPLE_RATE,
  });
  if (!codec) throw new Error('Opus も Vorbis も焼けない環境です');
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new AudioBufferSource({ codec, quality: new Quality({ bitrate: 96_000 }) });
  output.addAudioTrack(source);
  await output.start();
  const wave = synth(seconds, SAMPLE_RATE);
  const step = SAMPLE_RATE;
  for (let at = 0; at < wave.length; at += step) {
    const count = Math.min(step, wave.length - at);
    const buffer = new AudioBuffer({ length: count, numberOfChannels: 1, sampleRate: SAMPLE_RATE });
    buffer.copyToChannel(wave.subarray(at, at + count), 0);
    await source.add(buffer);
  }
  await output.finalize();
  const bytes = (output.target as InstanceType<typeof BufferTarget>).buffer;
  if (!bytes) throw new Error('焼いた素材が空でした');
  const blob = new Blob([bytes], { type: 'video/webm' });
  bakedAssets.set(key, blob);
  return blob;
}

/** 起こしたもの 1 本。境目は**要求した値ではなく、返ってきた buffer の時刻**を入れる。 */
interface LoadedPart extends DecodedPart {
  buffer: AudioBuffer;
  /** 要求した境目（どれくらい広がったかを見るため）。 */
  askedFrom: number;
  askedTo: number;
}

const bytesOf = (buffer: AudioBuffer) => buffer.length * buffer.numberOfChannels * 4;

/** 返ってきた buffer の列を 1 本に繋ぐ。**本体の `decodeAssetAudio` と同じ繋ぎ方**（時刻は見ない）。 */
function joinBuffers(parts: AudioBuffer[]): AudioBuffer {
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

/** 素材を丸ごと起こす（いまの本体）。 */
async function decodeWhole(blob: Blob): Promise<{ part: LoadedPart; ms: number; firstTimestamp: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('音のトラックが無い');
    const duration = await track.computeDuration();
    const sink = new AudioBufferSink(track);
    const t0 = performance.now();
    const buffers: AudioBuffer[] = [];
    let firstTimestamp = Number.NaN;
    for await (const wrapped of sink.buffers()) {
      if (Number.isNaN(firstTimestamp)) firstTimestamp = wrapped.timestamp;
      buffers.push(wrapped.buffer);
    }
    const buffer = joinBuffers(buffers);
    const ms = performance.now() - t0;
    return {
      // **本体は時刻を捨てて繋いでいる**ので、丸ごとの側の t=0 は「最初の buffer の頭」。
      part: { mediaId: 'asset', from: firstTimestamp || 0, to: (firstTimestamp || 0) + buffer.duration, assetDuration: duration, buffer, askedFrom: 0, askedTo: duration },
      ms,
      firstTimestamp: firstTimestamp || 0,
    };
  } finally {
    input.dispose();
  }
}

/**
 * 区間だけを起こす。
 *
 * `Input` は**素材ごとに 1 本**開いて使い回す。区間ごとに開き直すと、
 * 測っているのが「範囲デコード」ではなく「ファイルを開く手間 × 区間の数」になる
 * （9/26・1 回目に映像の側で同じ形を踏んで、出口を `auto` にした理由がこれ）。
 */
async function decodeRanges(
  blob: Blob,
  ranges: { from: number; to: number }[],
): Promise<{ parts: LoadedPart[]; ms: number; bytes: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('音のトラックが無い');
    const duration = await track.computeDuration();
    const sink = new AudioBufferSink(track);
    const t0 = performance.now();
    const parts: LoadedPart[] = [];
    for (const range of ranges) {
      const buffers: AudioBuffer[] = [];
      let from = Number.NaN;
      let to = Number.NaN;
      for await (const wrapped of sink.buffers(range.from, range.to)) {
        if (Number.isNaN(from)) from = wrapped.timestamp;
        to = wrapped.timestamp + wrapped.duration;
        buffers.push(wrapped.buffer);
      }
      if (buffers.length === 0) continue;
      const buffer = joinBuffers(buffers);
      parts.push({
        mediaId: 'asset',
        // **返ってきた時刻を使う。** packet の頭からしか始められないので、
        // 要求より手前から出てくる。要求した値を信じると、その差だけ先を鳴らす。
        from,
        to: Math.max(to, from + buffer.duration),
        assetDuration: duration,
        buffer,
        askedFrom: range.from,
        askedTo: range.to,
      });
    }
    const ms = performance.now() - t0;
    return { parts, ms, bytes: parts.reduce((n, p) => n + bytesOf(p.buffer), 0) };
  } finally {
    input.dispose();
  }
}

export type RangeMode =
  /** いまの本体。素材を丸ごと起こしてから混ぜる。 */
  | 'whole'
  /** 区間だけ起こして混ぜる。 */
  | 'ranges'
  /**
   * わざと**区間の頭ぶんを引かない**。素材内の絶対秒をそのまま `offset` に渡す形。
   * 「範囲だけ起こしたら座標が変わる」をいちばん素直に外した相手で、
   * **照合がちゃんと落ちること**を確かめるために置いてある。
   */
  | 'ranges-unshifted'
  /**
   * わざと区間を**両側から削る**（`shrinkSeconds`）。載らない置き方が出るので、
   * 「載らなかったものを数えているか」が確かめられる。
   */
  | 'ranges-shrunk';

export interface RangeMeasureOptions {
  /** 素材の尺（秒）。焼くのに時間がかかるので、既定は控えめ。 */
  assetSeconds?: number;
  /** タイムラインの形。`split` は素材の中を順に使う / `jet` はジェットカットした後の形。 */
  shape?: 'split' | 'jet';
  /** `jet` のときの 1 山の長さと残す割合。 */
  takeSeconds?: number;
  keepRatio?: number;
  /** `split` のときのタイムラインの尺とクリップの本数。 */
  seconds?: number;
  pieces?: number;
  prerollSeconds?: number;
  tailSeconds?: number;
  mergeGapSeconds?: number;
  mode?: RangeMode;
  shrinkSeconds?: number;
  /** 混ぜた波の指紋を取る（時計は当てにならなくなるので計測とは別に回す）。 */
  verify?: boolean;
}

export interface RangeMeasureResult {
  mode: RangeMode;
  assetSeconds: number;
  timelineSeconds: number;
  clips: number;
  /** 起こすのにかかった時間。 */
  decodeMs: number;
  /** 混ぜる（`startRendering`）のにかかった時間。 */
  mixMs: number;
  /** 起こして抱えたバイト。 */
  decodedBytes: number;
  /** 起こした区間の本数（丸ごとは 1）。 */
  parts: number;
  /** 起こした秒の合計。 */
  decodedSeconds: number;
  /** 数え上げが「起こす」と言った秒（実測との差が packet の丸め）。 */
  plannedSeconds: number;
  /** 置き方の数と、そのうち区間に載らなかった数。 */
  placements: number;
  missed: number;
  /** 丸ごとの側で、最初の buffer の時刻（本体はここを捨てて繋いでいる）。 */
  firstTimestamp: number;
  /** 要求した境目から、実際どれだけ広がったか（片側の最大・秒）。 */
  worstWidening: number;
  signature: number[];
  /** 指紋 1 区画の標本数。**測る側で 512 と書き直さない**ため（書くと片方だけ直して食い違う）。 */
  signatureBlock: number;
}

function buildSequence(options: RangeMeasureOptions) {
  const { assetSeconds = 60, shape = 'split', seconds = 13, pieces = 1, takeSeconds = 2, keepRatio = 0.25 } = options;
  if (shape === 'jet') return jetCutSequence({ assetSeconds, takeSeconds, keepRatio, fade: 0.1, volume: 0.8 });
  return splitAudioSequence({ seconds, pieces, assetSeconds, fade: 0.5, volume: 0.8 });
}

export async function measureRangeDecode(options: RangeMeasureOptions = {}): Promise<RangeMeasureResult> {
  const {
    assetSeconds = 60,
    prerollSeconds = DEFAULT_PREROLL_SECONDS,
    tailSeconds = DEFAULT_TAIL_SECONDS,
    mergeGapSeconds = DEFAULT_MERGE_GAP_SECONDS,
    mode = 'whole',
    shrinkSeconds = 0.5,
    verify = false,
  } = options;

  const sequence = buildSequence({ ...options, assetSeconds });
  const blob = await bakeWebM(assetSeconds);
  const plan = planAssetDecodes(sequence, { prerollSeconds, tailSeconds, mergeGapSeconds });
  const planned = summarizeRangeCost(sequence, { prerollSeconds, tailSeconds, mergeGapSeconds });

  let parts: LoadedPart[] = [];
  let decodeMs = 0;
  let firstTimestamp = 0;
  if (mode === 'whole') {
    const whole = await decodeWhole(blob);
    parts = [whole.part];
    decodeMs = whole.ms;
    firstTimestamp = whole.firstTimestamp;
  } else {
    const ranges = (plan[0]?.ranges ?? []).map((r) =>
      mode === 'ranges-shrunk'
        ? { from: r.from + shrinkSeconds, to: Math.max(r.from + shrinkSeconds + 1e-3, r.to - shrinkSeconds) }
        : r,
    );
    const loaded = await decodeRanges(blob, ranges);
    parts = loaded.parts;
    decodeMs = loaded.ms;
  }

  // 混ぜる。置き方は一括（窓 1 つ）で作り、範囲の側だけ区間の座標へ移す。
  const sounds = soundsOf(sequence);
  const length = Math.max(1, Math.ceil(sequence.duration * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(CHANNELS, length, SAMPLE_RATE);
  let placements = 0;
  let missed = 0;
  for (const placement of windowSounds(sounds, 0, sequence.duration)) {
    placements += 1;
    const hit = offsetInParts(parts, placement.mediaId, placement);
    if (!hit) {
      missed += 1;
      continue;
    }
    const loaded = parts.find((p) => p === hit.part) as LoadedPart;
    // **わざと外す側**は区間の頭ぶんを引かない（素材内の絶対秒をそのまま渡す）。
    const offset = mode === 'ranges-unshifted' ? placement.offset : hit.offset;
    placeInto(ctx, loaded.buffer, { ...placement, offset });
  }
  const t0 = performance.now();
  const mix = await ctx.startRendering();
  const mixMs = performance.now() - t0;

  const fingerprint = new Fingerprint();
  if (verify) fingerprint.push(mix);
  fingerprint.close();

  return {
    mode,
    assetSeconds,
    timelineSeconds: sequence.duration,
    clips: sequence.clips.length,
    decodeMs,
    mixMs,
    decodedBytes: parts.reduce((n, p) => n + bytesOf(p.buffer), 0),
    parts: parts.length,
    decodedSeconds: parts.reduce((n, p) => n + p.buffer.duration, 0),
    plannedSeconds: mode === 'whole' ? planned.wholeSeconds : planned.rangeSeconds,
    placements,
    missed,
    firstTimestamp,
    worstWidening: parts.reduce((n, p) => Math.max(n, p.askedFrom - p.from, p.to - p.askedTo), 0),
    signature: fingerprint.values,
    signatureBlock: SIGNATURE_BLOCK,
  };
}

declare global {
  interface Window {
    __labRangeMeasure: typeof measureRangeDecode;
  }
}
window.__labRangeMeasure = measureRangeDecode;
