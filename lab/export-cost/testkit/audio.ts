/**
 * 音の側を**本物の部品で**回して、段ごとに時計を当てる。
 *
 * ## これは画面の一部ではない
 *
 * `index.html` からは読み込んでいない。`audio.mjs` が playwright 越しに差し込むためだけに置いてある
 * （`testkit/measure.ts` と同じ理由・同じ置き方）。
 *
 * ## 何を回しているか
 *
 * 本体（`src/engine/offline-export.ts`）の音の道を写した:
 *
 * 1. `decodeAssetAudio` — 素材の音をまるごと起こす（ここは `decodeAudioData` の側だけ）
 * 2. `renderAudioMix` — `OfflineAudioContext` でタイムライン全体を一括ミックス
 * 3. `sliceAudio` + `audioSource.add` — 1 秒ずつ切り出して出力へ渡す
 *
 * 比べる相手は**窓に割る形**（`src/audio-mix.ts`）で、2 と 3 が
 * 「窓 1 つを混ぜてそのまま渡す」に変わる。置き方は一括も窓割りも
 * `windowSounds` の**同じ 1 本の道**から出しているので、差は窓の切り方だけ。
 *
 * ## 素材を自前で作っている理由
 *
 * `lab/fixtures/make-audio.mjs` は node:fs を掴んでいるのでブラウザへ持ち込めない。
 * ここで要るのは「音として妥当な波」ではなく**尺と標本化周波数を自由に振れる波**
 * （窓の境目で継ぎ目が出るかを見たい）なので、種を固定した短い合成で足りる。
 */

import {
  AudioBufferSource,
  BufferTarget,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import {
  AUDIO_CHUNK_SECONDS,
  CHANNELS,
  SAMPLE_RATE,
  planAudioWindows,
  soundsOf,
  splitAudioSequence,
  summarizeAudioCost,
  windowSounds,
  type Placement,
} from '../src/audio-mix.ts';

/** 種を固定した擬似乱数（`lab/fixtures/make-audio.mjs` と同じ mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 試し素材の波。**声のつもりの倍音＋伴奏のつもりの和音＋わずかな雑音**。
 *
 * 雑音を混ぜてあるのは、窓の境目の継ぎ目を**隠さない**ため。
 * 正弦波だけだと、境目でサンプルが 1 つずれても指紋がほとんど動かない。
 */
export function synth(seconds: number, sampleRate: number): Float32Array {
  const length = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(length);
  const noise = rng(20260926);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.3 * t);
    let v = 0;
    for (const [f, a] of [
      [180, 0.5],
      [360, 0.25],
      [540, 0.12],
    ] as const) {
      v += a * Math.sin(2 * Math.PI * f * t) * syllable;
    }
    for (const f of [220, 277, 330]) v += 0.08 * Math.sin(2 * Math.PI * f * t);
    v += 0.02 * (noise() * 2 - 1);
    out[i] = Math.max(-1, Math.min(1, v * 0.6));
  }
  return out;
}

/** 16bit PCM・1ch の WAV を組み立てる（`lab/fixtures/wav.mjs` の書き出しと同じ形）。 */
function toWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

/** 素材は 1 回だけ作って使い回す（作り直すと粒が変わって前後が比べられない）。 */
const baked = new Map<string, Uint8Array>();

function bakeAudio(seconds: number, sampleRate: number): Uint8Array {
  const key = `${seconds}/${sampleRate}`;
  const hit = baked.get(key);
  if (hit) return hit;
  const made = toWav(synth(seconds, sampleRate), sampleRate);
  baked.set(key, made);
  return made;
}

/** 起こした素材も使い回す。デコードの時計を測る回だけ別に起こす。 */
const decodedCache = new Map<string, AudioBuffer>();

async function decodeAsset(seconds: number, sampleRate: number): Promise<{ buffer: AudioBuffer; ms: number }> {
  const bytes = bakeAudio(seconds, sampleRate);
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const t0 = performance.now();
  // `decodeAudioData` は渡した ArrayBuffer を取り上げるので、毎回コピーを渡す。
  const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
  return { buffer, ms: performance.now() - t0 };
}

export type MixMode =
  /** いまの本体。タイムライン全体を 1 本に混ぜてから、1 秒ずつ切り出して渡す。 */
  | 'one-shot'
  /** 窓 1 つぶんを混ぜて、そのまま渡す（切り出しが要らない）。 */
  | 'windowed'
  /**
   * わざと**素材内の位置を進めない**窓割り。どの窓も素材の頭から鳴らす。
   * 「窓に割ったら音がずれる」をいちばん素直に作った形で、
   * **照合がちゃんと落ちること**を確かめるための相手。
   */
  | 'windowed-broken';

export interface AudioMeasureOptions {
  /** タイムラインの尺（秒）。 */
  seconds?: number;
  /** 素材の尺（秒）。尺より短ければ素材を頭から取り直す。 */
  assetSeconds?: number;
  /** 素材の標本化周波数。48000 以外だと混ぜる側で補間が入る。 */
  assetSampleRate?: number;
  /** 何本のクリップに割るか。 */
  pieces?: number;
  /** フェードの長さ（秒）。窓の境目がフェードの途中に来る形を作る。 */
  fade?: number;
  mode?: MixMode;
  /** 窓の幅（秒）。既定は本体が出力へ渡す単位と同じ 1 秒。 */
  windowSeconds?: number;
  /** 出力（WebM・Opus）へ実際に渡すところまで測る。 */
  encode?: boolean;
  /** 渡した波の指紋を取る（時計は当てにならなくなるので計測とは別に回す）。 */
  verify?: boolean;
  /**
   * 利得の初期値を入れずに、**本体と同じ書き方**で組む。
   * クリップの頭で利得 1.0 が 1 標本漏れる（`placeInto` の注）。既定は入れる側。
   */
  leakDefaultGain?: boolean;
}

export interface AudioMeasureResult {
  mode: MixMode;
  seconds: number;
  windowSeconds: number;
  /** 素材を起こすのにかかった時間。 */
  decodeMs: number;
  /** 混ぜる（`startRendering`）のにかかった時間の合計。 */
  mixMs: number;
  /** 切り出し（`sliceAudio`）にかかった時間の合計。窓割りでは 0。 */
  sliceMs: number;
  /** 出力へ渡すのにかかった時間（`encode` のときだけ）。 */
  encodeMs: number;
  /** 仕上げ（`finalize`）。 */
  finalizeMs: number;
  /** 上の合計（＝映像の 1 コマ目を描く前に先払いしている時間）。 */
  totalMs: number;
  /** 混ぜる入れ物として抱えたバイトの最大（起こした素材は別に数える）。 */
  peakMixBytes: number;
  /** 起こした素材のバイト。 */
  decodedBytes: number;
  /** 音源を組んだ回数（窓割りでは窓の数だけ増える）。 */
  placements: number;
  /** 出力へ渡した回数と標本の数。 */
  deliveries: number;
  deliveredSamples: number;
  /** 渡した波の指紋（`verify` のときだけ）。1 区画につき 2 つ（符号つき平均・絶対値の最大）。 */
  signature: number[];
  bytes: number;
}

/** 指紋を取る区画の長さ（標本）。48kHz で 1 区画 ≒ 10.7ms。 */
export const SIGNATURE_BLOCK = 512;

/**
 * 出力へ渡した波の指紋を、**渡す単位をまたいで**取る。
 *
 * **符号つきの平均と絶対値の最大を並べて持つ。** 片方だけでは足りない——
 * 平均だけだと 1 標本ずれても値がほとんど動かず、最大だけだと符号の反転を見落とす
 * （9/26・2 回目に映像の側で「平均に畳むと素通りする」を 2 回踏んでいる）。
 *
 * 区画を**渡した塊ごとに切らない**のが要点。塊の切れ目で区画を閉じると、
 * 窓の幅を変えただけで区画の数が変わり、**比べる相手と長さが揃わなくなる**
 * （最初はそう書いて、窓 0.37 秒と 5 秒が「長さが違う」で落ちた）。
 */
export class Fingerprint {
  private sum = 0;
  private peak = 0;
  private count = 0;
  readonly values: number[] = [];

  /** 渡した塊を 1 つ足す。区画は全体を通した標本の番号で切る。 */
  push(buffer: AudioBuffer): void {
    const channels = buffer.numberOfChannels;
    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c += 1) planes.push(buffer.getChannelData(c));
    for (let i = 0; i < buffer.length; i += 1) {
      for (const plane of planes) {
        this.sum += plane[i];
        if (Math.abs(plane[i]) > this.peak) this.peak = Math.abs(plane[i]);
        this.count += 1;
      }
      if (this.count >= SIGNATURE_BLOCK * channels) this.close();
    }
  }

  /** 端数の区画も最後に閉じる（落とすと尺の端が比べられない）。 */
  close(): void {
    if (this.count === 0) return;
    this.values.push(this.sum / this.count, this.peak);
    this.sum = 0;
    this.peak = 0;
    this.count = 0;
  }
}

/** 本体の `sliceAudio` をそのまま写したもの。 */
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

/**
 * 本体の `place()` と同じ組み方。折れ線は `Placement` が持っているものをそのまま使う。
 *
 * **1 か所だけ本体と違う。利得の初期値をその場で入れている**（`leakDefaultGain` で本体の側も試せる）。
 * 本体は `setValueAtTime` だけで始めるが、`GainNode` の初期値は **1.0** なので、
 * その節が音源の開始より **1 標本でも後ろに丸められると、そこだけ利得 1.0 で鳴る**。
 * 実測（2026-09-26・3 回目）では、クリップの頭ちょうどの 1 標本が
 * **素材の生の値そのまま**で出た（7.80 秒の -0.02895 など）。
 * 音量 0.1 のクリップでもフェードインの途中でも、その 1 標本だけは素通りする。
 * 窓に割ると節の時刻が窓の頭からの相対秒に変わるので、**丸めの残りが変わって
 * 漏れる場所も変わる**——最初に「窓に割ると波が違う」と出たのは、窓のせいではなくこれだった。
 */
export function placeInto(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  placement: Placement,
  leakDefaultGain = false,
): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = placement.speed;
  const gain = ctx.createGain();
  source.connect(gain);
  gain.connect(ctx.destination);
  const envelope = placement.envelope;
  // 初期値を先に入れておけば、節の丸めがどちらへ転んでも 1.0 は出てこない。
  if (!leakDefaultGain) gain.gain.value = envelope[0].gain;
  gain.gain.setValueAtTime(envelope[0].gain, Math.max(0, envelope[0].time));
  for (let i = 1; i < envelope.length; i += 1) {
    gain.gain.linearRampToValueAtTime(envelope[i].gain, Math.max(0, envelope[i].time));
  }
  if (placement.loop) {
    source.loop = true;
    source.loopEnd = buffer.duration;
  }
  source.start(placement.startAt, placement.offset, placement.seconds * placement.speed);
  source.stop(placement.startAt + placement.seconds);
}

const bytesOf = (buffer: AudioBuffer) => buffer.length * buffer.numberOfChannels * 4;

export async function measureAudioMix(options: AudioMeasureOptions = {}): Promise<AudioMeasureResult> {
  const {
    seconds = 13,
    assetSeconds = 13,
    assetSampleRate = SAMPLE_RATE,
    pieces = 1,
    fade = 0.5,
    mode = 'one-shot',
    windowSeconds = AUDIO_CHUNK_SECONDS,
    encode = false,
    verify = false,
    leakDefaultGain = false,
  } = options;

  const sequence = splitAudioSequence({ seconds, pieces, assetSeconds, fade, volume: 0.8 });
  const cacheKey = `${assetSeconds}/${assetSampleRate}`;
  let decodeMs = 0;
  let asset = decodedCache.get(cacheKey);
  if (!asset) {
    const decoded = await decodeAsset(assetSeconds, assetSampleRate);
    asset = decoded.buffer;
    decodeMs = decoded.ms;
    decodedCache.set(cacheKey, asset);
  } else {
    // 起こす時計は素材ごとに 1 回だけ本物を測り、2 回目以降はその値を引き継ぐ。
    // 毎回起こすと、測りたい「混ぜる」の差がデコードの振れに埋まる。
    const again = await decodeAsset(assetSeconds, assetSampleRate);
    decodeMs = again.ms;
  }

  // 出力（WebM・Opus）。本体と同じ 48kHz・2ch で開く。
  let output: Output | null = null;
  let audioSource: AudioBufferSource | null = null;
  if (encode) {
    const codec = await getFirstEncodableAudioCodec(['opus', 'vorbis'], {
      numberOfChannels: CHANNELS,
      sampleRate: SAMPLE_RATE,
    });
    if (codec) {
      output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
      audioSource = new AudioBufferSource({ codec, quality: new Quality({ bitrate: 128_000 }) });
      output.addAudioTrack(audioSource);
      await output.start();
    }
  }

  let mixMs = 0;
  let sliceMs = 0;
  let encodeMs = 0;
  let peakMixBytes = 0;
  let placements = 0;
  let deliveries = 0;
  let deliveredSamples = 0;
  const fingerprint = new Fingerprint();

  const deliver = async (buffer: AudioBuffer) => {
    deliveries += 1;
    deliveredSamples += buffer.length;
    if (verify) fingerprint.push(buffer);
    if (!audioSource) return;
    const t0 = performance.now();
    await audioSource.add(buffer);
    encodeMs += performance.now() - t0;
  };

  if (mode === 'one-shot') {
    const sounds = soundsOf(sequence);
    const length = Math.max(1, Math.ceil(seconds * SAMPLE_RATE));
    const ctx = new OfflineAudioContext(CHANNELS, length, SAMPLE_RATE);
    for (const placement of windowSounds(sounds, 0, seconds)) {
      placeInto(ctx, asset, placement, leakDefaultGain);
      placements += 1;
    }
    const t0 = performance.now();
    const mix = await ctx.startRendering();
    mixMs += performance.now() - t0;
    peakMixBytes = bytesOf(mix);

    // 本体と同じく 1 秒ずつ切り出して渡す。**切り出しはミックスをもう 1 回複製する。**
    const chunkSamples = Math.round(AUDIO_CHUNK_SECONDS * SAMPLE_RATE);
    let sent = 0;
    while (sent < mix.length) {
      const count = Math.min(chunkSamples, mix.length - sent);
      const s0 = performance.now();
      const slice = sliceAudio(mix, sent, count);
      sliceMs += performance.now() - s0;
      await deliver(slice);
      sent += count;
    }
  } else {
    const windows = planAudioWindows(sequence, { windowSeconds });
    for (const window of windows) {
      const length = Math.max(1, Math.round((window.to - window.from) * SAMPLE_RATE));
      const ctx = new OfflineAudioContext(CHANNELS, length, SAMPLE_RATE);
      for (const placement of window.placements) {
        // **わざと壊す側**は素材内の位置を進めない（どの窓も素材の頭から鳴らす）。
        placeInto(ctx, asset, mode === 'windowed-broken' ? { ...placement, offset: 0 } : placement, leakDefaultGain);
        placements += 1;
      }
      const t0 = performance.now();
      const mix = await ctx.startRendering();
      mixMs += performance.now() - t0;
      peakMixBytes = Math.max(peakMixBytes, bytesOf(mix));
      // 窓がそのまま渡す単位なので、切り出しは 1 回も要らない。
      await deliver(mix);
    }
  }

  fingerprint.close();

  let finalizeMs = 0;
  let bytes = 0;
  if (output) {
    const t0 = performance.now();
    await output.finalize();
    finalizeMs = performance.now() - t0;
    bytes = (output.target as InstanceType<typeof BufferTarget>).buffer?.byteLength ?? 0;
  }

  return {
    mode,
    seconds,
    windowSeconds,
    decodeMs,
    mixMs,
    sliceMs,
    encodeMs,
    finalizeMs,
    totalMs: decodeMs + mixMs + sliceMs + encodeMs + finalizeMs,
    peakMixBytes,
    decodedBytes: bytesOf(asset),
    placements,
    deliveries,
    deliveredSamples,
    signature: fingerprint.values,
    bytes,
  };
}

/** 数え上げも同じページから引けるようにしておく（表を 1 か所で組みたいので）。 */
export function countAudioCost(options: Parameters<typeof splitAudioSequence>[0], windowSeconds: number) {
  return summarizeAudioCost(splitAudioSequence(options), { windowSeconds });
}

declare global {
  interface Window {
    __labAudioMeasure: typeof measureAudioMix;
  }
}
window.__labAudioMeasure = measureAudioMix;
