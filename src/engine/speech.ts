/**
 * 文字起こしへ渡す前に、音を整える。
 *
 * whisper は**声の無い所を渡されると、勝手に言葉を作る**。
 * 無音や音楽の上に「ご視聴ありがとうございました」のような定型句が乗るのは、
 * ほぼこれが原因。だから渡す前に、声のある所だけを抜き出して繋ぐ。
 *
 * 繋ぐと時刻がずれるので、元の時刻へ戻すための対応表も一緒に返す。
 *
 * 画面にも WebAudio にも依存していない。数の列だけを扱うので、
 * ブラウザ抜きで「どこを声と見なしたか」を測れる。
 */

export interface Span {
  start: number;
  end: number;
}

/** 声を探すときの手加減。 */
export interface VoiceOptions {
  /** いちばん強い所に対する、声と見なす下限の比。 */
  floor?: number;
  /** これより短い声は、雑音として捨てる（秒）。 */
  minVoice?: number;
  /** これより短い切れ目は、間として繋いでしまう（秒）。 */
  minGap?: number;
  /** 前後に足す余白（秒）。頭と尻が欠けるのを防ぐ。 */
  pad?: number;
}

/** コマごとの強さ（RMS）。 */
function frameEnergy(samples: Float32Array, size: number, hop: number): Float32Array {
  const count = Math.max(0, Math.floor((samples.length - size) / hop) + 1);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    const at = i * hop;
    for (let k = 0; k < size; k += 1) sum += samples[at + k] * samples[at + k];
    out[i] = Math.sqrt(sum / size);
  }
  return out;
}

/**
 * 声のある区間を探す。
 *
 * 一本の線で切ると、息継ぎのたびに切れて短い破片だらけになる。
 * 「入る線」を高く、「出る線」を低くして、いったん入ったら少し粘るようにしてある。
 */
export function voiceSpans(samples: Float32Array, sampleRate: number, options: VoiceOptions = {}): Span[] {
  const floor = options.floor ?? 0.08;
  const minVoice = options.minVoice ?? 0.25;
  const minGap = options.minGap ?? 0.35;
  const pad = options.pad ?? 0.15;

  const size = Math.max(64, Math.round(sampleRate * 0.032));
  const hop = Math.max(32, Math.round(sampleRate * 0.016));
  const energy = frameEnergy(samples, size, hop);
  if (energy.length === 0) return [];

  const loudest = Math.max(...energy);
  if (loudest <= 1e-6) return [];
  const enter = loudest * floor;
  const leave = enter * 0.6;

  const spans: Span[] = [];
  let open = -1;
  for (let i = 0; i < energy.length; i += 1) {
    const t = (i * hop) / sampleRate;
    if (open < 0) {
      if (energy[i] >= enter) open = t;
    } else if (energy[i] < leave) {
      spans.push({ start: open, end: t });
      open = -1;
    }
  }
  if (open >= 0) spans.push({ start: open, end: samples.length / sampleRate });

  // 近いものを繋ぐ。
  const joined: Span[] = [];
  for (const span of spans) {
    const last = joined[joined.length - 1];
    if (last && span.start - last.end <= minGap) last.end = span.end;
    else joined.push({ ...span });
  }

  // 短すぎるものを捨て、前後に余白を付ける。
  const duration = samples.length / sampleRate;
  const out: Span[] = [];
  for (const span of joined) {
    if (span.end - span.start < minVoice) continue;
    const start = Math.max(0, span.start - pad);
    const end = Math.min(duration, span.end + pad);
    const last = out[out.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

export interface Condensed {
  /** 声のある所だけを繋いだ波形。 */
  audio: Float32Array;
  /** 繋いだあとの時刻 → 元の時刻の対応表。 */
  map: { at: number; shift: number }[];
  /** 元の長さ（秒）。 */
  duration: number;
  /** 残した割合（0〜1）。1 なら何も落としていない。 */
  kept: number;
}

/** 繋ぎ目に挟む無音（秒）。ここが無いと、離れた言葉が 1 語に化ける。 */
const JOIN_SILENCE = 0.12;

/**
 * 声のある所だけを繋ぐ。
 * 落とした所のぶん時刻が詰まるので、戻すための対応表を一緒に返す。
 */
export function condense(samples: Float32Array, sampleRate: number, spans: Span[]): Condensed {
  const duration = samples.length / sampleRate;
  if (spans.length === 0) {
    return { audio: samples, map: [{ at: 0, shift: 0 }], duration, kept: 1 };
  }

  const gap = Math.round(JOIN_SILENCE * sampleRate);
  let total = 0;
  for (const span of spans) total += Math.round((span.end - span.start) * sampleRate);
  total += gap * Math.max(0, spans.length - 1);

  const audio = new Float32Array(total);
  const map: { at: number; shift: number }[] = [];
  let at = 0;
  spans.forEach((span, i) => {
    const from = Math.max(0, Math.round(span.start * sampleRate));
    const to = Math.min(samples.length, Math.round(span.end * sampleRate));
    // この区間の頭が、繋いだあとの何秒に来るか。元へ戻すときの差がこれ。
    map.push({ at: at / sampleRate, shift: span.start - at / sampleRate });
    audio.set(samples.subarray(from, to), at);
    at += to - from;
    if (i < spans.length - 1) at += gap;
  });

  return { audio, map, duration, kept: total / Math.max(1, samples.length) };
}

/** 繋いだあとの時刻を、元の時刻へ戻す。 */
export function restoreTime(map: { at: number; shift: number }[], time: number): number {
  let shift = map.length ? map[0].shift : 0;
  for (const point of map) {
    if (time + 1e-9 < point.at) break;
    shift = point.shift;
  }
  return time + shift;
}

/**
 * 音量を揃える。
 * 小さく録れているものをそのまま渡すと、聞き取りが目に見えて落ちる。
 * 頭を叩かないよう、いちばん大きい所を 0.95 に合わせるだけにしてある。
 */
export function normalize(samples: Float32Array, target = 0.95): Float32Array {
  let peak = 0;
  for (const value of samples) {
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
  }
  if (peak <= 1e-6 || peak >= target) return samples;
  const gain = target / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain;
  return out;
}

/**
 * 低い方を落とす（1 次のハイパス）。
 * 空調やマイクの当たる音は声より下にあり、残すと強さの判定が鈍る。
 */
export function highpass(samples: Float32Array, sampleRate: number, cutoff = 80): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  const out = new Float32Array(samples.length);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = alpha * (prevOut + samples[i] - prevIn);
    out[i] = value;
    prevIn = samples[i];
    prevOut = value;
  }
  return out;
}
