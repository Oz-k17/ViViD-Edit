/**
 * ラウドネス（LUFS）を測り、目標の大きさへ揃える倍率を決める。
 *
 * 無音カットが「どこを残すか」を決めるのに対して、こちらは「どれくらいの大きさで出すか」を決める。
 * ショート動画の配信先は再生時に音量を揃えてくるので、こちらが -14 LUFS あたりに
 * 合わせておかないと、**上げすぎたぶんは向こうで下げられ、下げすぎたぶんは埋もれる。**
 * ピーク（0dBFS）で合わせても揃わないのは、人が感じる大きさが瞬間の高さではなく
 * 一定時間の平均で決まるため。だからここは ITU-R BS.1770-4（EBU R128）に合わせる。
 *
 * 規格の中身は 3 つしかない:
 *   1. K 特性（高い側を +4dB 持ち上げ、低い側を落とす 2 段の IIR）に通す
 *   2. 0.4 秒の窓（0.1 秒ずつずらす）ごとに平均パワーを出す
 *   3. 静かな窓を 2 段階で捨ててから（ゲート）、残りを平均する
 *
 * 3 の「捨てる」が肝で、これが無いと**曲間の無音が長い素材ほど小さく測れてしまう。**
 *
 * DOM にも WebAudio にも依存しない（`loudness.ts` と同じ方針）。Node でそのまま検算できる。
 */

import { SILENCE_DB, type AudioLike, type BlockSource } from './loudness.ts';

/** 双 2 次フィルタ 1 段。係数は規格の並びに合わせてある（y = b0x+b1x₁+b2x₂ − a1y₁ − a2y₂）。 */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * 規格が定める定数。**書き換えるものではない**ので、由来ごとここに置く。
 *
 * `OFFSET_DB`（-0.691）は「1kHz の正弦波が両チャンネルに -23dBFS で入っているとき
 * ちょうど -23 LUFS になる」ための下駄。K 特性の 1kHz での利得が +0.691dB なので、それを打ち消している。
 * つまりこの 2 つは対になっていて、**片方だけいじると目盛りがずれる。**
 */
const OFFSET_DB = -0.691;
/** 1 段目（高い側の棚）。頭の陰で高い音が弱まるぶんを戻す。 */
const SHELF = { fc: 1681.974450955533, gainDb: 3.999843853973347, q: 0.7071752369554196 };
/** 2 段目（低い側を落とす）。耳が低い音を小さく感じるぶん。 */
const HIGHPASS = { fc: 38.13547087602444, q: 0.5003270373238773 };

/** 窓の長さ（秒）。「瞬間」の値もこの窓で測る。 */
export const BLOCK_SECONDS = 0.4;
/** 窓をずらす幅（秒）。0.4 秒の窓を 0.1 秒ずつ動かす＝ 75% 重ねる。 */
export const STEP_SECONDS = 0.1;
/** 「短期」の窓（秒）。 */
export const SHORT_TERM_SECONDS = 3;
/** 1 段目のゲート。これより静かな窓は最初から数えない（絶対値）。 */
export const ABSOLUTE_GATE_LUFS = -70;
/** 2 段目のゲート。1 段目を通った窓の平均から、この幅だけ下を切る（相対値）。 */
export const RELATIVE_GATE_LU = 10;

/**
 * K 特性の係数を、その場の標本化周波数から作る。
 *
 * 規格は 48kHz の係数表だけを載せているが、**素材が 48kHz とは限らない**
 * （読み込んだ動画が 44.1kHz なことはふつうにある）。表をそのまま当てると
 * 折れ点の周波数がずれるので、双 1 次変換で毎回作り直す。
 * 48kHz で作ったものが規格の表と一致することは検算で押さえてある（`lufsSelfTest` の①）。
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // 1 段目（高い側の棚）。Vh/Vb を使う形でないと規格の表に一致しない
  // （教科書どおりの高域棚の式では小数 2 桁目から外れる。測って確かめた）。
  const k1 = Math.tan((Math.PI * SHELF.fc) / sampleRate);
  const vh = Math.pow(10, SHELF.gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const d1 = 1 + k1 / SHELF.q + k1 * k1;
  const shelf: Biquad = {
    b0: (vh + (vb * k1) / SHELF.q + k1 * k1) / d1,
    b1: (2 * (k1 * k1 - vh)) / d1,
    b2: (vh - (vb * k1) / SHELF.q + k1 * k1) / d1,
    a1: (2 * (k1 * k1 - 1)) / d1,
    a2: (1 - k1 / SHELF.q + k1 * k1) / d1,
  };

  // 2 段目（低い側を落とす）。分子は (1, -2, 1) 固定。
  const k2 = Math.tan((Math.PI * HIGHPASS.fc) / sampleRate);
  const d2 = 1 + k2 / HIGHPASS.q + k2 * k2;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d2,
    a2: (1 - k2 / HIGHPASS.q + k2 * k2) / d2,
  };

  return [shelf, highpass];
}

/**
 * 1 段ぶんの履歴（入力 2 つ・出力 2 つ）。
 *
 * **区間に割るときはこれを持ち越す。** IIR は後ろへ無限に続くので、
 * のりしろを重ねるだけでは一括と同じ値にならない（2026-10-02 にリミッタで踏んだのと同じ形）。
 * 持ち越せば**同じ順で同じ演算**になるので、ビット単位で一致する。
 */
export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export function newBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

/**
 * 1 段を**その場で**通す（`buf[0..len)` を書き換え、履歴を `s` へ残す）。
 *
 * その場で書き換えてよいのは、`buf[i]` を読んだあとに `buf[i]` しか書かないため
 * （前の入力は `x1` / `x2` が持っている）。入れ物を 1 本で済ませたいのは
 * 流す形のメモリがここで決まるから。
 *
 * 倍精度で持つのは、2 段目が直流に近いところで極めて鋭く、
 * 単精度だと 13 秒でも誤差が目に見えて積もるため（0.1 LU 級）。
 *
 * **漸化式はこの関数にしか書かない。** 一括と流す形で別々に書くと、
 * 片方だけ直したときに黙ってずれる（突き合わせの検算で気づくが、原因を探すのは高い）。
 */
function runBiquadInPlace(buf: Float64Array, len: number, f: Biquad, s: BiquadState): void {
  let { x1, x2, y1, y2 } = s;
  for (let i = 0; i < len; i += 1) {
    const x = buf[i];
    const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
  s.x1 = x1;
  s.x2 = x2;
  s.y1 = y1;
  s.y2 = y2;
}

/** K 特性 2 段ぶんの履歴。 */
export interface KWeightingState {
  shelf: BiquadState;
  highpass: BiquadState;
}

export function newKWeightingState(): KWeightingState {
  return { shelf: newBiquadState(), highpass: newBiquadState() };
}

/**
 * K 特性を**その場で**通す（履歴を持ち越す形）。
 *
 * 2 段を「区間ごとに 1 段目 → 2 段目」で通しても、
 * 「全体に 1 段目 → 全体に 2 段目」と同じ値になる。
 * 2 段目の入力は 1 段目の出力そのもので、どちらも位置 `i` の値しか見ないため。
 */
export function applyKWeightingInto(
  buf: Float64Array,
  len: number,
  filters: [Biquad, Biquad],
  state: KWeightingState,
): void {
  runBiquadInPlace(buf, len, filters[0], state.shelf);
  runBiquadInPlace(buf, len, filters[1], state.highpass);
}

/** K 特性を通したあとの列を返す（検算から中身を見たいので外に出してある）。 */
export function applyKWeighting(samples: Float32Array | Float64Array, sampleRate: number): Float64Array {
  const out = new Float64Array(samples.length);
  out.set(samples);
  applyKWeightingInto(out, out.length, kWeighting(sampleRate), newKWeightingState());
  return out;
}

export interface LoudnessMeasurement {
  /** 全体のラウドネス（LUFS）。ゲートを通る窓が 1 つも無ければ null。 */
  integratedLufs: number | null;
  /** 0.4 秒窓での最大（LUFS）。窓が 1 つも取れなければ null。 */
  momentaryMaxLufs: number | null;
  /** 3 秒窓での最大（LUFS）。素材が 3 秒に満たなければ null。 */
  shortTermMaxLufs: number | null;
  /** 標本そのものの最大（dBFS）。 */
  samplePeakDb: number;
  /**
   * 標本の間も含めた最大（dBTP）。4 倍に打ち直してから測る。
   *
   * **`skipTruePeak` を立てたときは、ここに標本の最大がそのまま入る**（打ち直さないので）。
   * 実際の天井はそれより高いことがあるので、**この値で歪むかどうかを判断してはいけない。**
   * 省略してよいのは「大きさだけ見せたい」場面だけ。
   */
  truePeakDb: number;
  /**
   * 静かなほうの窓の値（LUFS）。窓ごとの値の下から 10% の位置。
   *
   * **これは「雑音の底」ではない。** 鳴りっぱなしの素材では、いちばん静かな窓も
   * 音楽そのものなので、ここには音楽の大きさが出る（2026-09-19・3 回目に測って分かった）。
   * 底を見て持ち上げを止める手はそれで潰れた。いまは**出すだけで、判断には使っていない。**
   * 素材にどれだけ「黙っている所」があるかの目安として読むこと。
   */
  quietBlockLufs: number | null;
  /** ゲートを通った 0.4 秒窓の数。 */
  gatedBlocks: number;
  /** ゲートで落ちた 0.4 秒窓の数。**ここが大きい素材は「間」が長い。** */
  droppedBlocks: number;
  duration: number;
  channels: number;
}

export interface LoudnessOptions {
  /**
   * 1ch の素材を「左右に同じ音を流したもの」として測るか。
   *
   * 規格はチャンネルごとのパワーを**足す**ので、同じ音でも 1ch の素材は
   * 2ch にしたものより 3.01 LU 小さく出る。どちらが正しいかは
   * **その素材が最後に何 ch で出るか**で決まる（検算⑦）。
   * 既定は規格どおり（足すだけ）。書き出しが 2ch なら、1ch の素材にはこれを立てる。
   */
  monoAsDualMono?: boolean;
  /**
   * 真のピークを測らない（打ち直すぶん重い。2ch 65 秒で 1.07 秒 → 0.29 秒）。
   * **立てると `truePeakDb` は標本の最大になる。** 書き出しの倍率を決めるときは立てないこと。
   */
  skipTruePeak?: boolean;
}

/**
 * チャンネルの重み。規格では後ろの 2 本だけ 1.41 倍（後ろから来る音は大きく感じる）。
 *
 * **3ch 以上は 5.1 の並びしか想定していない。** 本体の書き出しは 2ch なので、
 * いま実際に通るのは `count <= 2` の枝だけ。4ch（L R Ls Rs）を渡されると
 * 3 本目を中央、4 本目を後ろと数えて 1 本ぶん取り違える。
 * そこを通す必要が出たら、並びを引数で受け取る形へ直すこと。
 */
function channelWeight(index: number, count: number): number {
  if (count <= 2) return 1;
  // 5.1 の並び（L R C Ls Rs LFE）を想定。LFE は数えない。
  if (index === 3 || index === 4) return 1.41;
  if (index === 5) return 0;
  return 1;
}

/** 平均パワー → LUFS。規格の式そのもの。 */
function toLufs(power: number): number {
  if (!(power > 0)) return -Infinity;
  return OFFSET_DB + 10 * Math.log10(power);
}

/**
 * ラウドネスを測る。
 *
 * 0.1 秒ずつの部分和をいったん作ってから足し合わせているのは、
 * 0.4 秒窓・3 秒窓・ゲートの 3 つが**同じ部分和を使い回せる**ため。
 * 窓ごとに数え直すと 4 倍（3 秒窓なら 30 倍）の重複になる。
 */
export function measureLoudness(buffer: AudioLike, options: LoudnessOptions = {}): LoudnessMeasurement {
  const { sampleRate, numberOfChannels, length } = buffer;
  const stepSamples = Math.max(1, Math.round(STEP_SECONDS * sampleRate));
  const subBlocks = Math.floor(length / stepSamples);
  const duration = length / sampleRate;

  // 1ch を 2ch 扱いにするのは、同じ列をもう 1 本数えるのと同じ（＝ちょうど 2 倍）。
  const dualMono = options.monoAsDualMono === true && numberOfChannels === 1;

  // --- チャンネルごとに K 特性を通し、0.1 秒ごとの二乗和を作る ---
  // 重み付きで足し込んでしまうと、あとからチャンネル別に見られなくなるので
  // ここで重みを掛けておく（見たくなったことは今のところ無い）。
  const sums = new Float64Array(Math.max(0, subBlocks));
  let samplePeak = 0;
  let truePeak = 0;
  const weightSum = dualMono ? 2 : 1;

  for (let c = 0; c < numberOfChannels; c += 1) {
    const weight = channelWeight(c, numberOfChannels);
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      const a = Math.abs(data[i]);
      if (a > samplePeak) samplePeak = a;
    }
    if (!options.skipTruePeak) {
      const tp = truePeakOf(data);
      if (tp > truePeak) truePeak = tp;
    }
    if (weight === 0) continue;
    const filtered = applyKWeighting(data, sampleRate);
    for (let b = 0; b < subBlocks; b += 1) {
      const from = b * stepSamples;
      const to = from + stepSamples;
      let acc = 0;
      for (let i = from; i < to; i += 1) acc += filtered[i] * filtered[i];
      sums[b] += weight * weightSum * (acc / stepSamples);
    }
  }

  return summarizeSubBlockSums(sums, subBlocks, {
    samplePeak,
    truePeak,
    skipTruePeak: options.skipTruePeak === true,
    duration,
    channels: numberOfChannels,
  });
}

/** `summarizeSubBlockSums` へ渡す、標本を 1 周なめた結果。 */
interface SubBlockTotals {
  /** 標本そのものの最大（線形）。 */
  samplePeak: number;
  /** 打ち直して見つけた最大（線形）。`skipTruePeak` のときは 0。 */
  truePeak: number;
  skipTruePeak: boolean;
  duration: number;
  channels: number;
}

/**
 * 0.1 秒ごとの二乗和（`sums`）から先の段を、**1 か所にまとめてある。**
 *
 * 窓・ゲート・分位点はどれも `sums` しか見ないので、
 * 一括（`measureLoudness`）と流す形（`measureLoudnessStream`）は
 * **ここを共有すれば同じ結果になることが、測るまでもなく決まる。**
 * 2 つ書いて突き合わせる形にしないのは、**片方だけ直したときに黙ってずれる**から。
 *
 * ここが尺に比例して持つものは `sums`（0.1 秒あたり 8 バイト ＝ 1 時間で 288KB）と、
 * そこから作る `blockPowers` だけ。**標本の側の列を一切持たない**ので、
 * 流す形のメモリは区間の長さで決まる。
 */
function summarizeSubBlockSums(
  sums: Float64Array,
  subBlocks: number,
  totals: SubBlockTotals,
): LoudnessMeasurement {
  const { samplePeak, truePeak, skipTruePeak, duration, channels } = totals;
  const blockSteps = Math.round(BLOCK_SECONDS / STEP_SECONDS); // 4
  const shortSteps = Math.round(SHORT_TERM_SECONDS / STEP_SECONDS); // 30

  /** 連続する n 個の部分和の平均パワー。窓が素材からはみ出すなら null。 */
  const windowPower = (start: number, n: number): number | null => {
    if (start + n > subBlocks) return null;
    let acc = 0;
    for (let i = start; i < n + start; i += 1) acc += sums[i];
    return acc / n;
  };

  // --- 0.4 秒窓（瞬間）とゲート ---
  const blockPowers: number[] = [];
  let momentaryMax = -Infinity;
  for (let s = 0; s + blockSteps <= subBlocks; s += 1) {
    const p = windowPower(s, blockSteps) as number;
    blockPowers.push(p);
    const l = toLufs(p);
    if (l > momentaryMax) momentaryMax = l;
  }

  let shortTermMax = -Infinity;
  for (let s = 0; s + shortSteps <= subBlocks; s += 1) {
    const l = toLufs(windowPower(s, shortSteps) as number);
    if (l > shortTermMax) shortTermMax = l;
  }

  // 1 段目: 静かすぎる窓を落とす（無音を数えると、間の長い素材ほど小さく出る）。
  const aboveAbsolute = blockPowers.filter((p) => toLufs(p) > ABSOLUTE_GATE_LUFS);
  let integrated: number | null = null;
  let gatedBlocks = 0;
  if (aboveAbsolute.length > 0) {
    const mean = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length;
    // 2 段目: その平均から 10 LU 下を線にして、もう一度落とす。
    // **相対ゲートがあるので、この関数は「鳴っているところの平均」に近い値を返す。**
    const relative = toLufs(mean) - RELATIVE_GATE_LU;
    const kept = blockPowers.filter((p) => toLufs(p) > ABSOLUTE_GATE_LUFS && toLufs(p) > relative);
    gatedBlocks = kept.length;
    if (kept.length > 0) {
      integrated = toLufs(kept.reduce((a, b) => a + b, 0) / kept.length);
    }
  }

  // 静かなほうの窓。ゲートを通ったものだけで見ると、静かな所はすでに捨てられているので、
  // ここでは**落とす前の**全部の窓から取る。
  let quietBlockLufs: number | null = null;
  if (blockPowers.length > 0) {
    const sorted = blockPowers.map(toLufs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length > 0) quietBlockLufs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))];
  }

  const peakDb = (v: number) => (v > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(v)) : SILENCE_DB);

  return {
    integratedLufs: integrated,
    quietBlockLufs,
    momentaryMaxLufs: Number.isFinite(momentaryMax) ? momentaryMax : null,
    shortTermMaxLufs: Number.isFinite(shortTermMax) ? shortTermMax : null,
    samplePeakDb: peakDb(samplePeak),
    truePeakDb: skipTruePeak ? peakDb(samplePeak) : peakDb(Math.max(truePeak, samplePeak)),
    gatedBlocks,
    droppedBlocks: blockPowers.length - gatedBlocks,
    duration,
    channels,
  };
}

// ---------- 真のピーク（標本の間） ----------

/** 位相の数。規格の付則と同じ 4 倍。 */
const TP_PHASES = 4;
/** 位相ごとのタップ数。合計 48 タップ。 */
const TP_TAPS = 12;

/**
 * 4 倍に打ち直すための係数。
 *
 * 規格は係数表を載せているが、ここでは同じ形（4 倍・位相ごと 12 タップ）の
 * 窓関数つき sinc をその場で作っている。**表を手で写すと、写し間違いに気づく手段が無い**ので、
 * 代わりに性質のほうを検算で押さえた（標本の最大を必ず上回る／0dBFS の正弦波で 0dBTP になる）。
 *
 * 中心を 24（= 4 の倍数）に置くのが大事で、そうすると位相 0 がちょうど δ になり、
 * **元の標本がそのまま通る。** 中心を 23.5 に置くと 4 つの位相が全部ずれた位置になり、
 * 真のピークが標本のピークを下回ることがある（それは定義からしておかしい）。
 */
function truePeakFilter(): Float64Array[] {
  const total = TP_PHASES * TP_TAPS;
  const center = total / 2; // 24
  const taps = new Float64Array(total);
  for (let n = 0; n < total; n += 1) {
    const x = (n - center) / TP_PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    // ブラックマン窓。48 タップしか無いので、窓を掛けないと裾の唸りがそのまま誤差になる。
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (total - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (total - 1));
    taps[n] = sinc * w;
  }
  // 位相ごとに分け、それぞれ和が 1 になるよう正規化する。
  // 窓を掛けたぶん各位相の和が 1 からずれていて、そのままだと直流で 0.1dB ほど痩せる。
  const phases: Float64Array[] = [];
  for (let p = 0; p < TP_PHASES; p += 1) {
    const phase = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k += 1) {
      phase[k] = taps[k * TP_PHASES + p];
      sum += phase[k];
    }
    if (Math.abs(sum) > 1e-9) for (let k = 0; k < TP_TAPS; k += 1) phase[k] /= sum;
    phases.push(phase);
  }
  return phases;
}

const TP_FILTER = truePeakFilter();

/** 48 タップの中心は 24 なので、群遅延はちょうど入力 6 標本ぶん。ここが整数になるように中心を選んである。 */
const TP_DELAY = TP_TAPS / 2;

/**
 * **標本ごと**の真のピーク（線形。dB ではない）を返す。長さは元と同じ。
 *
 * `truePeakOf` が素材ぜんたいの 1 つの数を返すのに対して、こちらは列を返す。
 * リミッタが要るのはこちら側で、**どこが天井を超えているか**が分からないと
 * そこだけ下げるということができない。
 *
 * 位相 p の出力が表しているのは時刻 `i + 6 + p/4`（位相 0 は δ なので元の標本そのもの）。
 * それをいちばん近い標本の位置へ入れているので、**この列の j 番目は
 * 「標本 j の前後半分のあいだに起きる最大の高さ」**になる。
 * リミッタはこの列を見て倍率を決めるが、倍率は 1 標本では動かない（なめらかに動かす）ので、
 * 半標本のずれは倍率にほとんど効かない。
 *
 * 先頭 6 標本と末尾 11 標本は窓が収まらないので、標本の値そのものを入れている
 * （`truePeakOf` と同じ割り切り。素材の端 0.2ms ほどだけ標本の粗さで見ていることになる）。
 */
export function truePeakEnvelope(data: Float32Array): Float64Array {
  const env = new Float64Array(data.length);
  for (let i = 0; i < data.length; i += 1) env[i] = Math.abs(data[i]);
  if (data.length < TP_TAPS) return env;
  for (let p = 1; p < TP_PHASES; p += 1) {
    const taps = TP_FILTER[p];
    // 時刻 i+6+p/4 をいちばん近い標本へ丸める（p=1 は手前、p=2,3 は 1 つ先）。
    const at = TP_DELAY + Math.round(p / TP_PHASES);
    for (let i = 0; i + TP_TAPS <= data.length; i += 1) {
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k];
      const a = Math.abs(acc);
      const j = i + at;
      if (j < env.length && a > env[j]) env[j] = a;
    }
  }
  return env;
}

/**
 * `truePeakEnvelope` が後ろ／先へ何標本ぶん覗くか。**長尺を区間に割るときに要る。**
 *
 * 位相 p の出力は時刻 `i + TP_DELAY + round(p/4)` の位置へ入るので、
 * 列の j 番目は入力の `[j - back, j + forward]` から作られる。
 * 区間の継ぎ目でここを渡し忘れると、継ぎ目の前後だけ値が小さく出る
 * （＝そこだけ天井を超えたまま通る）。**数で書かずに係数から出しているのは、
 * タップ数や群遅延を動かしたときに黙ってずれないようにするため。**
 */
export const TP_CONTEXT: { back: number; forward: number } = (() => {
  let back = 0;
  let forward = 0;
  for (let p = 1; p < TP_PHASES; p += 1) {
    const at = TP_DELAY + Math.round(p / TP_PHASES);
    if (at > back) back = at;
    if (TP_TAPS - 1 - at > forward) forward = TP_TAPS - 1 - at;
  }
  return { back, forward };
})();

/**
 * `truePeakEnvelope` の一部だけを、**同じ値になるように**作る（長尺を区間に割るため）。
 *
 * - `data` は絶対位置 `dataFrom` から始まる切れ端。
 * - `totalLength` は**素材ぜんたい**の長さ。端の扱い（先頭 6 標本・末尾 11 標本は
 *   標本の値そのまま／`TP_TAPS` より短い素材は畳み込まない）が素材の端でしか起きないので、
 *   切れ端の長さではなくこちらを見る必要がある。**ここを切れ端の長さで判断すると、
 *   区間の継ぎ目が全部「素材の端」として扱われて値が下がる。**
 * - 返すのは絶対位置 `[from, to)` ぶんの列（長さ `to - from`）。
 *
 * 呼ぶ側は `data` に `[from - TP_CONTEXT.back, to + TP_CONTEXT.forward)` を
 * （素材の外にはみ出すぶんを除いて）入れておくこと。足りなければ投げる。
 * **足りないまま黙って小さい値を返すほうが、落ちるより悪い**ので門にしてある。
 *
 * `into` を渡すとそこへ書く（返るのはその先頭 `to - from` ぶんの眺め）。
 * **区間ごとに呼ぶ側のために置いてある**——毎回確保すると、
 * 捨てた列が溜まってメモリの山がそこで決まってしまう（実測で 2 倍以上動いた）。
 * 列は頭から全部上書きするので、使い回しても前の値は残らない。
 */
export function truePeakEnvelopeRange(
  data: Float32Array,
  dataFrom: number,
  totalLength: number,
  from: number,
  to: number,
  into?: Float64Array,
): Float64Array {
  const want = Math.max(0, to - from);
  if (into !== undefined && into.length < want) {
    throw new Error(`真のピークの列の入れ物が足りません（要 ${want} / 渡された ${into.length}）`);
  }
  const env = into === undefined ? new Float64Array(want) : into.subarray(0, want);
  if (env.length === 0) return env;
  const needFrom = Math.max(0, from - TP_CONTEXT.back);
  const needTo = Math.min(totalLength, to + TP_CONTEXT.forward);
  if (dataFrom > needFrom || dataFrom + data.length < needTo) {
    throw new Error(
      `真のピークの列を区間で作るには前後のりしろが要ります（要 [${needFrom}, ${needTo}) / 渡された [${dataFrom}, ${dataFrom + data.length})）`,
    );
  }
  for (let j = from; j < to; j += 1) env[j - from] = Math.abs(data[j - dataFrom]);
  if (totalLength < TP_TAPS) return env;
  for (let p = 1; p < TP_PHASES; p += 1) {
    const taps = TP_FILTER[p];
    const at = TP_DELAY + Math.round(p / TP_PHASES);
    // 一括版は i を 0..totalLength-TP_TAPS で回して env[i+at] へ入れる。
    // ここで要るのは i+at が [from, to) に入るぶんだけ。
    const iFrom = Math.max(0, from - at);
    const iTo = Math.min(totalLength - TP_TAPS, to - 1 - at);
    for (let i = iFrom; i <= iTo; i += 1) {
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k - dataFrom];
      const a = Math.abs(acc);
      const j = i + at - from;
      if (a > env[j]) env[j] = a;
    }
  }
  return env;
}

/**
 * 標本の間も含めた最大の絶対値を返す（線形。dB ではない）。
 *
 * 位相 0 は δ なので元の標本そのもの。残り 3 つだけを畳み込めばよい。
 *
 * 末尾の 11 標本は窓が収まらないので、位相を当てずに標本の値だけで見ている
 * （最初に標本の最大を取ってあるので、そこが抜け落ちることはない）。
 * 素材の終わりぎわ 0.2ms ほどだけ、標本の粗さで見ていることになる。
 *
 * **`truePeakEnvelope` の最大と必ず一致する**（同じ位相・同じタップを見ているため）。
 * 列を作らずに済むぶんこちらのほうが軽いので、1 つの数で足りる場面はこちらを使う。
 */
export function truePeakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (data.length < TP_TAPS) return peak;
  for (let p = 1; p < TP_PHASES; p += 1) {
    const taps = TP_FILTER[p];
    for (let i = 0; i + TP_TAPS <= data.length; i += 1) {
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k];
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/**
 * 窓の**始点**が `[iFrom, iTo]` に入るぶんだけ打ち直して、その最大を返す（線形）。
 *
 * `data` は絶対位置 `dataFrom` から始まる切れ端。`truePeakOf` の内側そのもので、
 * **区間に割るときに「どの窓を誰が数えるか」を呼ぶ側に決めさせる**ために外に出してある。
 * 最大なので数える順は値に効かないが、**数え落とすと黙って小さく出る**ので、
 * 呼ぶ側は区間どうしで隙間を作らないこと（`measureLoudnessStream` の注を参照）。
 */
function truePeakOverWindows(data: Float32Array, dataFrom: number, iFrom: number, iTo: number): number {
  let peak = 0;
  for (let p = 1; p < TP_PHASES; p += 1) {
    const taps = TP_FILTER[p];
    for (let i = iFrom; i <= iTo; i += 1) {
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k - dataFrom];
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// ---------- 長尺（区間ごとに流す形。2026-10-02・2 回目） ----------

export interface StreamLoudnessOptions extends LoudnessOptions {
  /**
   * 1 区間の長さ（秒）。**標本の側のメモリはここで決まり、尺では決まらない。**
   *
   * 既定の 5 秒は、リミッタ（`limiter.ts`）とミックスを窓に割ったとき（2026-09-26・3 回目）と
   * 同じ刻み。書き出しの流れの中で、同じ刻みで回せるように揃えてある。
   * 測った表は `README.md` の「長尺のラウドネスの測り」。
   */
  blockSeconds?: number;
}

/** 区間の既定（秒）。リミッタの `DEFAULT_LIMITER_BLOCK_SECONDS` と同じ値に揃えてある。 */
export const DEFAULT_LOUDNESS_BLOCK_SECONDS = 5;

/**
 * ラウドネスを測る。**区間ごとに流すので、標本の側のメモリが尺に比例しない。**
 *
 * 一括の `measureLoudness` と**ビット単位で同じ値**を返す（検算で素材 6 本 × 区間 6 通りを固定）。
 * 同じになる根拠は 3 つで、どれも「重ねる」ではなく「持ち越す」から来ている:
 *
 *   1. **K 特性（IIR）は履歴を持ち越す。** 後ろへ無限に続くので、のりしろを重ねる形では
 *      近似にしかならない（2026-10-02 にリミッタの戻りで踏んだのと同じ形）。
 *      持ち越せば一括と同じ順で同じ演算になる。
 *   2. **0.1 秒ごとの二乗和は、継ぎ目で部分和を持ち越す。** 足し算の順が変わると最後の桁が動くので、
 *      区間がどこで切れても同じ順を踏む。
 *   3. **真のピークだけは、のりしろで足りる**（打ち直す窓は 12 標本の幅しか持たない）。
 *      ここは「窓の終わりが入る区間がその窓を数える」形にしてあるので、要るのは手前 11 標本だけ。
 *
 * ## まだ尺に比例して持つもの
 *
 * `sums`（0.1 秒ごとの二乗和）は**ぜんぶ持つ。** 相対ゲートが「全部の窓の平均から 10 LU 下」を
 * 線にするので、**1 周めの終わりまで線が決まらない**（＝捨てる窓を決められない）。
 * ただし 0.1 秒あたり 8 バイト ＝ **1 時間で 288KB** なので、標本の側（1 時間 2ch で 5.5GB）
 * とは桁が違う。**2 周読めば消せるが、読み直しはデコードをやり直すことなので高い。**
 *
 * `read` は前へ進む方向にしか呼ばない。ここが読むのは `[0, length)` を 1 回ずつで、
 * 真のピークのための手前 11 標本は**こちらで持ち回す**（読み直さない）。
 */
export function measureLoudnessStream(
  source: BlockSource,
  options: StreamLoudnessOptions = {},
): LoudnessMeasurement {
  const { sampleRate, numberOfChannels, length } = source;
  const stepSamples = Math.max(1, Math.round(STEP_SECONDS * sampleRate));
  const subBlocks = Math.floor(length / stepSamples);
  const duration = length / sampleRate;
  const dualMono = options.monoAsDualMono === true && numberOfChannels === 1;
  const weightSum = dualMono ? 2 : 1;
  const skipTruePeak = options.skipTruePeak === true;

  const sums = new Float64Array(Math.max(0, subBlocks));
  let samplePeak = 0;
  let truePeak = 0;

  // 素材より長い区間を頼まれても、素材のぶんしか入れ物を作らない
  // （`blockSeconds: Infinity` ＝「一括と同じに」が素直に通るようにしてある）。
  const asked = Math.round((options.blockSeconds ?? DEFAULT_LOUDNESS_BLOCK_SECONDS) * sampleRate);
  const block = Math.max(1, Math.min(Number.isFinite(asked) ? asked : Math.max(1, length), Math.max(1, length)));

  // 打ち直す窓の幅ぶんだけ手前を残す。**素材が 12 標本に満たないときは一括も畳み込まない**ので
  // そこも 0 にする（切れ端の長さで判断すると、継ぎ目が全部「素材の端」になる）。
  const back = skipTruePeak || length < TP_TAPS ? 0 : TP_TAPS - 1;

  const filters = kWeighting(sampleRate);
  const inBuf: Float32Array[] = [];
  const kState: KWeightingState[] = [];
  // 継ぎ目をまたいだ部分和（チャンネルごと）。**ここが「重ねる」では作れないもの。**
  const partial = new Float64Array(numberOfChannels);
  for (let c = 0; c < numberOfChannels; c += 1) {
    inBuf.push(new Float32Array(back + block));
    kState.push(newKWeightingState());
  }
  // K 特性を通す入れ物は 1 本でよい（その場で書き換え、チャンネルごとに使い回す）。
  const work = new Float64Array(block);

  let bufFrom = 0; // inBuf[*][0] の絶対位置
  let filled = 0; // inBuf に入っている標本数

  for (let o = 0; o < length; o = Math.min(length, o + block)) {
    const oEnd = Math.min(length, o + block);
    const bLen = oEnd - o;
    const keepFrom = Math.max(0, o - back);

    // 入力を左へ寄せて、足りないぶんだけ読む。**読むのは前へ進む方向だけ。**
    if (bufFrom < keepFrom) {
      const shift = keepFrom - bufFrom;
      if (shift < filled) {
        for (let c = 0; c < numberOfChannels; c += 1) inBuf[c].copyWithin(0, shift, filled);
        filled -= shift;
      } else {
        filled = 0;
      }
      bufFrom = keepFrom;
    }
    if (bufFrom + filled < oEnd) {
      const from = bufFrom + filled;
      const got = source.read(from, oEnd);
      for (let c = 0; c < numberOfChannels; c += 1) {
        if (got[c].length !== oEnd - from) {
          throw new Error(`read が頼んだ長さを返しません（要 ${oEnd - from} / 返り ${got[c].length}）`);
        }
        inBuf[c].set(got[c], filled);
      }
      filled = oEnd - bufFrom;
    }

    const off = o - bufFrom;
    for (let c = 0; c < numberOfChannels; c += 1) {
      const src = inBuf[c];
      // 標本そのものの最大。**重み 0 のチャンネル（LFE）も数える**のは一括と同じ。
      for (let i = 0; i < bLen; i += 1) {
        const a = Math.abs(src[off + i]);
        if (a > samplePeak) samplePeak = a;
      }
      if (back > 0) {
        // 窓の**終わり**がこの区間に入るものを、この区間で数える
        // ＝ 始点が [o - 11, oEnd - 12]。前の区間は `o - 12` までを数えているので、
        // **隙間も重なりも出ない**（重なっても最大なので値は同じだが、無駄に重い）。
        const iFrom = Math.max(0, o - TP_TAPS + 1);
        const iTo = Math.min(length - TP_TAPS, oEnd - TP_TAPS);
        if (iTo >= iFrom) {
          const tp = truePeakOverWindows(src, bufFrom, iFrom, iTo);
          if (tp > truePeak) truePeak = tp;
        }
      }
      const weight = channelWeight(c, numberOfChannels);
      if (weight === 0) continue;
      for (let i = 0; i < bLen; i += 1) work[i] = src[off + i];
      applyKWeightingInto(work, bLen, filters, kState[c]);
      // 0.1 秒ごとの二乗和。部分和を持ち越すので、**区間がどこで切れても足す順が同じ。**
      let acc = partial[c];
      let i = 0;
      while (i < bLen) {
        const b = Math.floor((o + i) / stepSamples);
        if (b >= subBlocks) break; // 末尾の端切れは一括も数えていない
        const end = Math.min(bLen, (b + 1) * stepSamples - o);
        for (; i < end; i += 1) acc += work[i] * work[i];
        if (o + i === (b + 1) * stepSamples) {
          sums[b] += weight * weightSum * (acc / stepSamples);
          acc = 0;
        }
      }
      partial[c] = acc;
    }

    if (oEnd === length) break;
  }

  return summarizeSubBlockSums(sums, subBlocks, {
    samplePeak,
    truePeak,
    skipTruePeak,
    duration,
    channels: numberOfChannels,
  });
}

// ---------- 目標へ揃える ----------

export interface NormalizationOptions {
  /** 目標のラウドネス（LUFS）。ショート動画の配信先はだいたい -14。 */
  targetLufs?: number;
  /** 真のピークの上限（dBTP）。0 ちょうどにしないのは、変換先の符号化で少し膨らむため。 */
  truePeakCeilingDb?: number;
  /**
   * このあとリミッタ（`limiter.ts`）に通す前提で、**天井をこれだけ超える倍率まで許す**（dB）。
   *
   * 既定は 0 ＝ リミッタを通さない前提（倍率ひとつで、ピークの天井を素直に守る）。
   * 値を入れると、超えたぶんはリミッタが均す前提で倍率を伸ばせる。
   * **ここに入れてよいのはリミッタが実際に下げられる深さ**（`maxReductionDb`）までで、
   * 大きくしても均しきれず天井を超えたまま出る。
   */
  limiterHeadroomDb?: number;
}

/**
 * **持ち上げの上限は置いていない。** 2026-09-19（3 回目）に 2 通り測って、どちらも捨てた。
 *
 * ①倍率で止める（20dB まで）: `speech-quiet` を止める一方、
 *   もっと雑音の多い `speech-noisy` は素通りさせる。**止める向きが逆だった**
 *   （上げたあとの底は前者 -49dBFS・後者 -33dBFS で、止まったほうが静か）。
 * ②静かな窓の値で止める: 鳴りっぱなしの素材では、その値が雑音ではなく音楽そのものなので、
 *   音楽をほぼ全部止めてしまう（素材どうしの開きが 7.54 → 12.50 LU と**悪化した**）。
 *
 * 守りたいのは「部屋鳴りやヒスが聞こえてくること」だが、
 * **手持ちの素材では、そこを分ける量が見つからなかった。**
 * 止めているのはピークの天井だけで、いまはそれで足りている。
 */

export const DEFAULT_NORMALIZATION: Required<NormalizationOptions> = {
  targetLufs: -14,
  truePeakCeilingDb: -1,
  limiterHeadroomDb: 0,
};

export interface NormalizationPlan {
  /** 当てる倍率（線形）。 */
  gain: number;
  /** 当てる倍率（dB）。 */
  gainDb: number;
  /** 当てたあとのラウドネス（LUFS）。目標に届かなかったならここで分かる。 */
  resultLufs: number | null;
  /** 当てたあとの真のピーク（dBTP）。 */
  resultTruePeakDb: number;
  /**
   * 何に止められたか。
   * - `none`  目標ちょうどに揃った
   * - `peak`  ピークの上限が先に来た（これ以上上げると歪む）
   * - `limiter` リミッタが均せる深さが足りなかった（`limiterHeadroomDb` を入れたときだけ出る）
   * - `unmeasurable` ゲートを通る窓が無く、測れなかった（倍率は 1 倍）
   */
  limitedBy: 'none' | 'peak' | 'limiter' | 'unmeasurable';
  /**
   * リミッタに要求する深さ（dB）。0 なら通す必要が無い。
   * **`limiterHeadroomDb` を超えることはない**（超える前に倍率のほうを抑える）。
   */
  neededReductionDb: number;
  /** 目標に届かなかったぶん（dB）。届いていれば 0。 */
  shortfallDb: number;
  targetLufs: number;
}

/**
 * 測った結果から、当てる倍率を決める。
 *
 * **倍率を 1 つ掛けるだけ**にしてあるのは、圧縮（山を潰す）を混ぜると
 * 「揃える」と「歪ませる」が同じつまみになってしまうため。
 * 目標まで上げるとピークが天井を超える素材では、**ピークのほうを優先して届かせない。**
 * 届かなかったことは `limitedBy` と `shortfallDb` に出るので、
 * 呼ぶ側が「ここは諦める／圧縮を掛ける」を選べる。
 */
export function planLoudnessNormalization(
  measurement: LoudnessMeasurement,
  options: NormalizationOptions = {},
): NormalizationPlan {
  const { targetLufs, truePeakCeilingDb, limiterHeadroomDb } = { ...DEFAULT_NORMALIZATION, ...options };

  if (measurement.integratedLufs === null) {
    return {
      gain: 1,
      gainDb: 0,
      resultLufs: null,
      resultTruePeakDb: measurement.truePeakDb,
      limitedBy: 'unmeasurable',
      shortfallDb: 0,
      neededReductionDb: 0,
      targetLufs,
    };
  }

  const wanted = targetLufs - measurement.integratedLufs;
  // ピークの余地。素材がすでに天井を超えているなら負（＝下げる向き）になる。
  const peakRoom = truePeakCeilingDb - measurement.truePeakDb;
  // リミッタに通す前提なら、その深さだけ天井を超える倍率まで許せる。
  const headroom = Math.max(0, limiterHeadroomDb);
  let gainDb = wanted;
  let limitedBy: NormalizationPlan['limitedBy'] = 'none';

  if (gainDb > peakRoom + headroom) {
    gainDb = peakRoom + headroom;
    // 均す前提が無いなら従来どおり「ピークで止まった」。あるなら「均しきれなかった」。
    limitedBy = headroom > 0 ? 'limiter' : 'peak';
  }

  const gain = Math.pow(10, gainDb / 20);
  return {
    gain,
    gainDb,
    resultLufs: measurement.integratedLufs + gainDb,
    // **リミッタに通す前**の値。通したあとは天井まで下がる（そちらは `LimiterReport` に出る）。
    resultTruePeakDb: measurement.truePeakDb + gainDb,
    limitedBy,
    // 下げる側で天井に当たることもあるので、絶対値ではなく「目標との差」を素直に出す。
    shortfallDb: Math.abs(wanted - gainDb) < 1e-9 ? 0 : wanted - gainDb,
    neededReductionDb: Math.max(0, measurement.truePeakDb + gainDb - truePeakCeilingDb),
    targetLufs,
  };
}

/** 倍率を当てた新しい音を作る（元は壊さない）。検算で「当てたら本当に目標になるか」を見るのに要る。 */
export function applyGain(buffer: AudioLike, gain: number): AudioLike {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 1) out[i] = src[i] * gain;
    channels.push(out);
  }
  return {
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    getChannelData: (c: number) => channels[c],
  };
}
