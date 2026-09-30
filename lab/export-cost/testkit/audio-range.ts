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
  EncodedPacketSink,
  Input,
  MkvOutputFormat,
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
  judgeTimestampGrid,
  offsetInParts,
  planAssetDecodes,
  summarizeRangeCost,
  type DecodedPart,
  type TimestampGridVerdict,
} from '../src/audio-ranges.ts';
import { Fingerprint, SIGNATURE_BLOCK, placeInto, synth } from './audio.ts';

/**
 * 焼くのに使えるコーデック。
 *
 * この端末（GPU 無しの Chromium）で焼けるのは **Opus と PCM だけ**だった
 * （`getEncodableAudioCodecs()` に AAC / Vorbis / FLAC は入っていない）。
 * なので「48kHz でない素材」を作る道は PCM しか無い。
 */
export type BakeCodec = 'opus' | 'pcm-s16';

/** 焼いた素材 1 本。**何 Hz で焼けたか**は頼んだ値と違うことがあるので、両方持つ。 */
interface BakedAsset {
  blob: Blob;
  /** 焼くときに渡した標本の速さ。 */
  askedSampleRate: number;
  codec: BakeCodec;
}

/** 焼いた素材は 1 回だけ作って使い回す（焼き直すと粒が変わって前後が比べられない）。 */
const bakedAssets = new Map<string, BakedAsset>();

/**
 * 合成波を、**コーデックと標本の速さを指定して**焼く。
 *
 * 1 秒ずつ渡しているのは、長い素材（10 分級）で `AudioBuffer` を 1 本作ると
 * **焼くだけでメモリの山が測りたいものより大きくなる**ため。
 *
 * ## 48kHz 以外を焼けるようにした理由
 *
 * 範囲読みの「後ろの余裕」（`tailSeconds`・既定 0.05 秒）は、
 * **48kHz でない素材の補間が境目の外の標本を要る**ことを理由の 1 つにして残してある。
 * ところが 2026-09-30（1 回目）の実測は **48kHz の Opus 1 通り**しか通していないので、
 * その理由だけ実測が無い。
 *
 * ## Opus に 48kHz 以外を頼んではいけない
 *
 * **Opus は 48kHz しか持たない。** それでも `getFirstEncodableAudioCodec` は
 * 44.1kHz でも 96kHz でも「焼ける」と答え、`AudioBufferSource` が黙って 48kHz へ直す。
 * 起こすと 48kHz で出てくるので、**頼んだ値を信じて書くと「44.1kHz を測った」という嘘になる。**
 * だから呼ぶ側がコーデックを名指しし、`measureRangeDecode` は
 * **起こした buffer の速さをそのまま返す**（`decodedSampleRate`）。
 *
 * ## PCM は「コーデックの温まり」を外した相手として要る
 *
 * PCM には前の packet に重ねて復号する仕組みが無いので、**助走が要らない**。
 * つまり PCM で測れば、9/30（1 回目）の 0.22 秒が
 * **範囲読みそのものの性質なのか Opus の性質なのか**が切り分けられる。
 * 起こす時間の比較には使えない（PCM は桁が違う）ので、そこは Opus のままにする。
 */
async function bakeAsset(seconds: number, sampleRate: number, codec: BakeCodec): Promise<BakedAsset> {
  const key = `${seconds}@${sampleRate}@${codec}`;
  const hit = bakedAssets.get(key);
  if (hit) return hit;
  const encodable = await getFirstEncodableAudioCodec([codec], { numberOfChannels: 1, sampleRate });
  if (!encodable) throw new Error(`${sampleRate}Hz の ${codec} は焼けない環境です`);
  // WebM は載せられるコーデックが決まっているので、PCM は Matroska に入れる
  // （読む側は `ALL_FORMATS` なのでどちらでも同じ経路で開く）。
  const format = codec === 'opus' ? new WebMOutputFormat() : new MkvOutputFormat();
  const output = new Output({ format, target: new BufferTarget() });
  const source = new AudioBufferSource(
    codec === 'opus' ? { codec, quality: new Quality({ bitrate: 96_000 }) } : { codec },
  );
  output.addAudioTrack(source);
  await output.start();
  const wave = synth(seconds, sampleRate);
  const step = sampleRate;
  for (let at = 0; at < wave.length; at += step) {
    const count = Math.min(step, wave.length - at);
    const buffer = new AudioBuffer({ length: count, numberOfChannels: 1, sampleRate });
    buffer.copyToChannel(wave.subarray(at, at + count), 0);
    await source.add(buffer);
  }
  await output.finalize();
  const bytes = (output.target as InstanceType<typeof BufferTarget>).buffer;
  if (!bytes) throw new Error('焼いた素材が空でした');
  const baked: BakedAsset = {
    blob: new Blob([bytes], { type: codec === 'opus' ? 'video/webm' : 'video/x-matroska' }),
    askedSampleRate: sampleRate,
    codec,
  };
  bakedAssets.set(key, baked);
  return baked;
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

/**
 * **容器の時刻の粒と packet の長さを読む。**
 *
 * `judgeTimestampGrid` はここで読んだ値だけで判定する（それ以外に手がかりが無いことが、
 * 2026-09-30・2 回目の収穫）。packet は `metadataOnly` で拾うのでバイトは読まない。
 * 先頭から `limit` 本だけ見るのは、**丸ごと歩いたら範囲読みの意味が無い**ため。
 * 少ししか見ないぶん取りこぼす恐れはあるが、
 * 「長さが揃っていない素材」は最初の数本でほぼ出る（PCM は 1 本目から出た）。
 */
async function inspectGrid(blob: Blob, limit = 8): Promise<{ verdict: TimestampGridVerdict; timeResolution: number; sampleRate: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('音のトラックが無い');
    const timeResolution = await track.getTimeResolution();
    const sampleRate = track.sampleRate;
    // 容器に書いてある packet の境目。`metadataOnly` なのでバイトは読まない。
    const packetBoundaries: number[] = [];
    const sink = new EncodedPacketSink(track);
    let packet = await sink.getFirstPacket({ metadataOnly: true });
    for (let i = 0; packet && i < limit; i += 1) {
      packetBoundaries.push(packet.timestamp);
      if (i === limit - 1) packetBoundaries.push(packet.timestamp + packet.duration);
      packet = await sink.getNextPacket(packet, { metadataOnly: true });
    }
    // 起こしてみた buffer の境目。**ここを突き合わせないと、丸めてあることが分からない**
    // （容器の境目は定義上いつも粒の整数倍なので、それだけ見ても素通りする）。
    // 頭から容器の境目を知っている範囲までしか読まないので、範囲読みの得を食わない。
    const decodedBoundaries: number[] = [];
    const lastKnown = packetBoundaries[packetBoundaries.length - 1] ?? 0;
    let at = 0;
    for await (const wrapped of new AudioBufferSink(track).buffers()) {
      if (decodedBoundaries.length === 0) {
        at = wrapped.timestamp;
        decodedBoundaries.push(at);
      }
      at += wrapped.buffer.duration;
      decodedBoundaries.push(at);
      if (at >= lastKnown) break;
    }
    return {
      verdict: judgeTimestampGrid({ sampleRate, timeResolution, packetBoundaries, decodedBoundaries }),
      timeResolution,
      sampleRate,
    };
  } finally {
    input.dispose();
  }
}

/**
 * 起こした区間の中身が、丸ごとのどこに当たるかを**整数の標本ずれで探す**。
 *
 * 容器の時刻が丸められている素材では、`timestamp` を信じた位置と中身が食い違う。
 * 窓は区間の真ん中から取る（端は助走と覆いで中身が違うので、そこで合わせると測りたいものが見えない）。
 */
function bestShiftOf(
  data: Float32Array,
  truth: Float32Array,
  fromSamples: number,
  { window: asked = 4096, search = 96 }: { window?: number; search?: number } = {},
): { bestShift: number; residual: number; zeroResidual: number } {
  // **区間より広い窓を取らない。** 取ると `data` の外を読んで残差が NaN になり、
  // 「訂正が当たっていない」と「そもそも測れていない」の区別が付かなくなる。
  const window = Math.max(1, Math.min(asked, data.length));
  const start = Math.max(0, Math.floor((data.length - window) / 2));
  const base = fromSamples + start;
  let bestShift = 0;
  let residual = Infinity;
  let zeroResidual = Infinity;
  for (let shift = -search; shift <= search; shift += 1) {
    const at = base + shift;
    if (at < 0 || at + window > truth.length) continue;
    let sum = 0;
    for (let i = 0; i < window; i += 1) sum += Math.abs(data[start + i] - truth[at + i]);
    const mean = sum / window;
    if (shift === 0) zeroResidual = mean;
    if (mean < residual) {
      residual = mean;
      bestShift = shift;
    }
  }
  return { bestShift, residual, zeroResidual };
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
): Promise<{ parts: LoadedPart[]; ms: number; bytes: number; tickDrift: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('音のトラックが無い');
    const duration = await track.computeDuration();
    const sink = new AudioBufferSink(track);
    const t0 = performance.now();
    const parts: LoadedPart[] = [];
    // **区間の中だけで測れる食い違い。** `duration` は標本ちょうど、`timestamp` は容器の粒。
    // 粒に乗らないコーデックでは、この 2 つが合わない（下の注）。
    let tickDrift = 0;
    for (const range of ranges) {
      const buffers: AudioBuffer[] = [];
      let from = Number.NaN;
      let to = Number.NaN;
      let accumulated = 0;
      for await (const wrapped of sink.buffers(range.from, range.to)) {
        if (Number.isNaN(from)) from = wrapped.timestamp;
        else tickDrift = Math.max(tickDrift, Math.abs(wrapped.timestamp - (from + accumulated)));
        accumulated += wrapped.duration;
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
    return { parts, ms, bytes: parts.reduce((n, p) => n + bytesOf(p.buffer), 0), tickDrift };
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
  | 'ranges-shrunk'
  /**
   * 区間の頭を、**中身を突き合わせて訂正してから**置く。
   *
   * 容器の時刻が丸められている素材（`judgeTimestampGrid` が断る側）では、
   * `timestamp` を信じた位置と中身が最大半目盛りずれる。
   * これは**丸ごと起こして突き合わせないと直せない**ので、出口には使えない
   * （直すために丸ごと起こすなら範囲読みの意味が無い）。
   * ここに置いてあるのは、**時刻の嘘を外したときに何が残るか**を測るため——
   * 「48kHz でない素材の補間」の話を、時刻のずれと切り離して見る唯一の道。
   */
  | 'ranges-aligned';

export interface RangeMeasureOptions {
  /** 素材の尺（秒）。焼くのに時間がかかるので、既定は控えめ。 */
  assetSeconds?: number;
  /**
   * 素材を何 Hz で焼くか。既定は本体のミックスと同じ 48kHz。
   * **48kHz 以外を頼むと、混ぜる段で標本の速さの変換が挟まる**（そこが今回の本題）。
   */
  assetSampleRate?: number;
  /**
   * 素材のコーデック。既定は 9/30（1 回目）と同じ `opus`。
   * **48kHz 以外を測りたいなら `pcm-s16`**（Opus は 48kHz しか持たない。上の注）。
   */
  assetCodec?: BakeCodec;
  /** クリップの速さ。`source.playbackRate` に入る。1 以外にすると補間が挟まる。 */
  speed?: number;
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
  /** 焼くときに頼んだ標本の速さ。 */
  askedSampleRate: number;
  /** **起こしたものが実際に何 Hz だったか。** 頼んだ値と違えば、そこは測れていない。 */
  decodedSampleRate: number;
  /** 焼いたコーデック。助走の長さはコーデックの持ち方で決まるので一緒に出す。 */
  codec: BakeCodec;
  /** クリップの速さ。 */
  speed: number;
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
  /**
   * 起こした区間 1 本ごとの境目。**照合が落ちたときに、どこがずれたかを見るために要る。**
   * 「違う区画が 87%」だけでは、区間の作り方が悪いのか写し方が悪いのか分からない。
   */
  partBounds: { askedFrom: number; askedTo: number; from: number; to: number; seconds: number }[];
  /** 容器の時刻の粒から出した「時刻を信じてよいか」の判定。 */
  grid: TimestampGridVerdict;
  /** 容器の時刻の細かさ（1 秒を x 分割）。 */
  timeResolution: number;
  /** `ranges-aligned` のときだけ入る、区間ごとの訂正量（標本）。 */
  partShifts: number[];
  /**
   * `ranges-aligned` のときだけ入る、訂正したあとの残差。
   * **これが 0 でない区間があったら、訂正そのものが当たっていない**（静かな所で合わせると
   * 別のずれでも残差が小さくなる）。そういう行を「範囲読みが落ちた」と読まないために出す。
   */
  partResiduals: number[];
  signature: number[];
  /** 指紋 1 区画の標本数。**測る側で 512 と書き直さない**ため（書くと片方だけ直して食い違う）。 */
  signatureBlock: number;
}

function buildSequence(options: RangeMeasureOptions) {
  const { assetSeconds = 60, shape = 'split', seconds = 13, pieces = 1, takeSeconds = 2, keepRatio = 0.25, speed = 1 } = options;
  if (shape === 'jet') return jetCutSequence({ assetSeconds, takeSeconds, keepRatio, fade: 0.1, volume: 0.8, speed });
  return splitAudioSequence({ seconds, pieces, assetSeconds, fade: 0.5, volume: 0.8, speed });
}

export async function measureRangeDecode(options: RangeMeasureOptions = {}): Promise<RangeMeasureResult> {
  const {
    assetSeconds = 60,
    assetSampleRate = SAMPLE_RATE,
    assetCodec = 'opus',
    speed = 1,
    prerollSeconds = DEFAULT_PREROLL_SECONDS,
    tailSeconds = DEFAULT_TAIL_SECONDS,
    mergeGapSeconds = DEFAULT_MERGE_GAP_SECONDS,
    mode = 'whole',
    shrinkSeconds = 0.5,
    verify = false,
  } = options;

  const sequence = buildSequence({ ...options, assetSeconds, speed });
  const baked = await bakeAsset(assetSeconds, assetSampleRate, assetCodec);
  const blob = baked.blob;
  // **素材の標本の速さがミックスより速いと、読む源の秒が足りない**（実測・`sourceRateRatio` の注）。
  const planOptions = {
    prerollSeconds,
    tailSeconds,
    mergeGapSeconds,
    sourceRateRatio: assetSampleRate / SAMPLE_RATE,
  };
  const plan = planAssetDecodes(sequence, planOptions);
  const planned = summarizeRangeCost(sequence, planOptions);

  const grid = await inspectGrid(blob);

  let parts: LoadedPart[] = [];
  let decodeMs = 0;
  let firstTimestamp = 0;
  const partShifts: number[] = [];
  const partResiduals: number[] = [];
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
    if (mode === 'ranges-aligned') {
      // **丸ごとを起こして突き合わせ、区間の頭を標本単位で訂正する。**
      // 出口の道ではない（丸ごと起こすなら範囲読みの意味が無い）。時刻の嘘を外した先を見るため。
      const whole = await decodeWhole(blob);
      const truth = whole.part.buffer.getChannelData(0);
      const rate = whole.part.buffer.sampleRate;
      parts = parts.map((part) => {
        const { bestShift, residual } = bestShiftOf(part.buffer.getChannelData(0), truth, Math.round(part.from * rate));
        partShifts.push(bestShift);
        partResiduals.push(residual);
        const from = (Math.round(part.from * rate) + bestShift) / rate;
        return { ...part, from, to: from + part.buffer.duration };
      });
    }
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
    askedSampleRate: assetSampleRate,
    // **起こした buffer の速さをそのまま出す。** 頼んだ値を書き写すと、
    // コーデックが黙って化けた（Opus に 44.1kHz を頼んだ）ときに気づけない。
    decodedSampleRate: parts[0]?.buffer.sampleRate ?? 0,
    codec: baked.codec,
    speed,
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
    grid: grid.verdict,
    timeResolution: grid.timeResolution,
    partShifts,
    partResiduals,
    partBounds: parts.map((p) => ({
      askedFrom: p.askedFrom,
      askedTo: p.askedTo,
      from: p.from,
      to: p.to,
      seconds: p.buffer.duration,
    })),
    signature: fingerprint.values,
    signatureBlock: SIGNATURE_BLOCK,
  };
}

/**
 * **起こした区間の中身が、丸ごと起こしたものの何標本ずれているか**を直接探る。
 *
 * これが要ったのは、境目の数字だけでは分からない食い違いに当たったから（2026-09-30・2 回目）。
 * `partBounds` を並べると `from` も `to` も長さも 1 標本まで筋が通っているのに、
 * 混ざった波が 87% の区画で違う、という形になった。
 * **時刻が嘘をついている**なら、境目をいくら見ても見つからない——
 * 中身を突き合わせて「何標本ずらすといちばん合うか」を測るしかない。
 *
 * 探すのは整数の標本ずれだけ（容器の時刻の粒は標本より粗いので、
 * ずれが出るならまず整数標本ぶん出る）。窓は区間の真ん中あたりから取る
 * （端は助走と覆いで中身が違うので、そこで合わせると測りたいものが見えない）。
 */
export async function measureRangeAlignment(options: RangeMeasureOptions = {}): Promise<{
  codec: BakeCodec;
  sampleRate: number;
  /** 区間ごとの「いちばん合うずれ（標本）」と、そのときの残差。 */
  parts: { askedFrom: number; from: number; bestShift: number; residual: number; zeroResidual: number }[];
  /**
   * **区間の中だけで分かる食い違い**（秒）。
   * 返ってくる `duration` は標本ちょうどなのに `timestamp` は容器の粒に丸められるので、
   * 「2 本目以降の時刻 − 1 本目の時刻」と「長さの足し上げ」がずれる。
   * これは**丸ごとと突き合わせずに、その場で測れる**（下の門の土台）。
   */
  tickDrift: number;
  /** 容器の時刻の粒から出した判定（**実測のずれと合っているかを突き合わせるため**）。 */
  grid: TimestampGridVerdict;
}> {
  const {
    assetSeconds = 60,
    assetSampleRate = SAMPLE_RATE,
    assetCodec = 'opus',
    speed = 1,
    prerollSeconds = DEFAULT_PREROLL_SECONDS,
    tailSeconds = DEFAULT_TAIL_SECONDS,
    mergeGapSeconds = DEFAULT_MERGE_GAP_SECONDS,
  } = options;

  const sequence = buildSequence({ ...options, assetSeconds, speed });
  const baked = await bakeAsset(assetSeconds, assetSampleRate, assetCodec);
  const plan = planAssetDecodes(sequence, {
    prerollSeconds,
    tailSeconds,
    mergeGapSeconds,
    sourceRateRatio: assetSampleRate / SAMPLE_RATE,
  });

  const whole = await decodeWhole(baked.blob);
  const truth = whole.part.buffer.getChannelData(0);
  const sampleRate = whole.part.buffer.sampleRate;
  const loaded = await decodeRanges(baked.blob, plan[0]?.ranges ?? []);
  const tickDrift = loaded.tickDrift;

  const out: { askedFrom: number; from: number; bestShift: number; residual: number; zeroResidual: number }[] = [];
  for (const part of loaded.parts) {
    const found = bestShiftOf(part.buffer.getChannelData(0), truth, Math.round(part.from * sampleRate));
    out.push({ askedFrom: part.askedFrom, from: part.from, ...found });
  }
  return { codec: baked.codec, sampleRate, parts: out, tickDrift, grid: (await inspectGrid(baked.blob)).verdict };
}

declare global {
  interface Window {
    __labRangeMeasure: typeof measureRangeDecode;
    __labRangeAlign: typeof measureRangeAlignment;
  }
}
window.__labRangeMeasure = measureRangeDecode;
window.__labRangeAlign = measureRangeAlignment;
