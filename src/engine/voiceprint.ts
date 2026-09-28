/**
 * 声の指紋。「この区間を喋っているのはどちらか」を決めるための下ごしらえ。
 *
 * 手順書では resemblyzer（声を数十次元へ写す学習済みのもの）を使っているが、
 * ブラウザの中でそれを回すのは現実的でないので、**声の高さと音色の形**という
 * 手で作れる手がかりでやる。手順書と同じで、**手本（アンカー）を人が示し、
 * 残りをそれとの近さで振り分ける**形にしてある。手本無しに 2 つへ割る
 *（クラスタリング）のは、手順書自身が「両者が同じ側に寄る」と書いているので採らない。
 *
 * 画面にも WebAudio にも依存していない。渡すのは数の列だけなので、
 * ブラウザ抜きで「見分けられるか」を測れる。
 */

/** 声の高さを探す範囲（Hz）。人の声はこの中に収まる。 */
const PITCH_MIN = 70;
const PITCH_MAX = 400;

/** 音色を見る帯の数と範囲。低すぎる所は雑音、高すぎる所は子音しか無い。 */
const BAND_COUNT = 14;
const BAND_LOW = 120;
const BAND_HIGH = 6000;

export interface VoicePrint {
  /** 使えたコマの数。少ないと当てにならないので、呼ぶ側が見られるようにしておく。 */
  frames: number;
  /** 声の高さ（Hz）の中央値。0 なら取れなかった。 */
  pitch: number;
  /**
   * 音色の形。帯ごとの対数エネルギーから**全体の平均を引いて**あるので、
   * 録りの音量やマイクの近さでは動かない。長さは 1 に揃えてある。
   */
  timbre: number[];
}

/** 2 のべき乗の長さの FFT（その場で書き換える）。 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * 自己相関で声の高さを取る。
 * 山の高さが低いコマ（雑音や子音だけ）は 0 を返して捨てさせる。
 */
function framePitch(frame: Float32Array, sampleRate: number): number {
  const minLag = Math.floor(sampleRate / PITCH_MAX);
  const maxLag = Math.min(Math.floor(sampleRate / PITCH_MIN), frame.length - 1);
  if (maxLag <= minLag) return 0;

  let energy = 0;
  for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
  if (energy <= 1e-9) return 0;

  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < frame.length; i += 1) sum += frame[i] * frame[i + lag];
    const score = sum / energy;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // 周期がはっきりしないコマは、母音として数えない。
  if (bestLag === 0 || bestScore < 0.3) return 0;
  return sampleRate / bestLag;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 帯の境目。低い側を細かく見たいので、対数で等間隔に取る。 */
function bandEdges(): number[] {
  const edges: number[] = [];
  for (let i = 0; i <= BAND_COUNT; i += 1) {
    edges.push(BAND_LOW * Math.pow(BAND_HIGH / BAND_LOW, i / BAND_COUNT));
  }
  return edges;
}

/**
 * 声の指紋を取る。
 *
 * 声の出ていないコマ（息継ぎ・間）を混ぜると、指紋が部屋の雑音の形に寄ってしまう。
 * そこで「その区間の中で強いほう」かつ「周期がはっきりしている」コマだけを使う。
 *
 * @param samples    モノラルの波形。
 * @param sampleRate 1 秒あたりの数。
 */
export function voicePrint(samples: Float32Array, sampleRate: number): VoicePrint | null {
  const size = 1024;
  const hop = 512;
  if (samples.length < size) return null;

  const edges = bandEdges();
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));

  // まず各コマの強さを測り、静かなコマを落とす線を決める。
  const frames: { at: number; rms: number }[] = [];
  for (let at = 0; at + size <= samples.length; at += hop) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += samples[at + i] * samples[at + i];
    frames.push({ at, rms: Math.sqrt(sum / size) });
  }
  if (frames.length === 0) return null;
  const loudest = Math.max(...frames.map((f) => f.rms));
  if (loudest <= 1e-6) return null;
  const floor = loudest * 0.18;

  const bands = new Float64Array(BAND_COUNT);
  const pitches: number[] = [];
  let used = 0;

  for (const frame of frames) {
    if (frame.rms < floor) continue;
    const slice = samples.subarray(frame.at, frame.at + size);

    const pitch = framePitch(slice, sampleRate);
    if (pitch === 0) continue; // 母音の出ていないコマは音色も当てにならない
    pitches.push(pitch);

    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i += 1) re[i] = slice[i] * window[i];
    fft(re, im);

    // 帯ごとにエネルギーを足す。
    const perBand = new Float64Array(BAND_COUNT);
    for (let k = 1; k < size / 2; k += 1) {
      const hz = (k * sampleRate) / size;
      if (hz < edges[0] || hz >= edges[BAND_COUNT]) continue;
      // 境目は対数で等間隔なので、位置から帯の番号が直に出る。
      const idx = Math.min(
        BAND_COUNT - 1,
        Math.floor((Math.log(hz / BAND_LOW) / Math.log(BAND_HIGH / BAND_LOW)) * BAND_COUNT),
      );
      perBand[idx] += re[k] * re[k] + im[k] * im[k];
    }
    for (let b = 0; b < BAND_COUNT; b += 1) bands[b] += Math.log(perBand[b] + 1e-12);
    used += 1;
  }

  if (used < 3) return null;

  // 平均を引く＝全体の音量を捨てて、帯どうしの**釣り合い**だけを残す。
  const mean = bands.reduce((a, b) => a + b, 0) / used / BAND_COUNT;
  const timbre: number[] = [];
  for (let b = 0; b < BAND_COUNT; b += 1) timbre.push(bands[b] / used - mean);
  const norm = Math.sqrt(timbre.reduce((a, v) => a + v * v, 0)) || 1;

  return {
    frames: used,
    pitch: median(pitches),
    timbre: timbre.map((v) => v / norm),
  };
}

/** 音色の近さ（-1〜1）。長さを揃えてあるので内積がそのまま余弦になる。 */
export function timbreSimilarity(a: VoicePrint, b: VoicePrint): number {
  let dot = 0;
  for (let i = 0; i < a.timbre.length; i += 1) dot += a.timbre[i] * b.timbre[i];
  return dot;
}

/**
 * 声の高さの近さ（0〜1）。
 * 差は比で見る。同じ 30Hz の違いでも、低い声どうしなら大きな違いだが、
 * 高い声どうしなら誤差の範囲になるため。
 */
export function pitchSimilarity(a: VoicePrint, b: VoicePrint): number {
  if (a.pitch <= 0 || b.pitch <= 0) return 0.5; // 片方が取れていないなら、どちらとも言えない
  const ratio = Math.abs(Math.log(a.pitch / b.pitch));
  return Math.exp(-ratio / 0.18);
}

/**
 * 総合の近さ（0〜1）。
 * 音色を主、声の高さを従にしている。高さだけだと、同じくらいの高さの 2 人で
 * 総崩れになる。音色だけだと、同じ収録環境の 2 人が寄りすぎる。
 */
export function similarity(a: VoicePrint, b: VoicePrint): number {
  const timbre = (timbreSimilarity(a, b) + 1) / 2;
  return 0.65 * timbre + 0.35 * pitchSimilarity(a, b);
}

export interface Anchor<T> {
  id: T;
  print: VoicePrint;
}

export interface Decision<T> {
  id: T;
  score: number;
  /** 2 番目との差。小さいほど「どちらとも言い切れない」。 */
  margin: number;
}

/**
 * 手本のうち、いちばん近いものを選ぶ。
 * `margin` が小さいときは人に確かめてもらう想定で、判定そのものは返す。
 */
export function pickSpeaker<T>(print: VoicePrint, anchors: Anchor<T>[]): Decision<T> | null {
  if (anchors.length === 0) return null;
  const scored = anchors
    .map((anchor) => ({ id: anchor.id, score: similarity(print, anchor.print) }))
    .sort((a, b) => b.score - a.score);
  return {
    id: scored[0].id,
    score: scored[0].score,
    margin: scored.length > 1 ? scored[0].score - scored[1].score : 1,
  };
}
