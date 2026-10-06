/**
 * 合成した波形で、計算そのものが正しいかを確かめる。
 * 素材を用意しなくても壊れていないことが分かるように、画面から実行できるようにしてある。
 */

import { analyzeLoudness, toDb, type AudioLike, type LoudnessTrack } from './loudness.ts';
import {
  autoThresholdDb,
  cutSoundingSeconds,
  DEFAULT_JET_CUT,
  envelopeGateFrames,
  keepEdgeSeconds,
  keepScoreSeconds,
  lowBandDepthSeconds,
  lowBandLineDb,
  lowBandReadable,
  minimalKeepRanges,
  planJetCut,
} from './silence.ts';
import { gainAt, planDucking } from './ducking.ts';
import { toClipEdits } from './edits.ts';
import { buildPeaks } from './peaks.ts';
import {
  analyzeFeatures,
  centroidDescentRatio,
  energyModulationDepthDb,
  highBandAloneRatio,
  levelSkewness,
  MOD_SPLIT_HZ,
  modulationDepthDb,
  modulationRatio,
  modulationWindowFrames,
} from './features.ts';
import { fftScratch, magnitudes } from './fft.ts';
import {
  applyGain,
  ABSOLUTE_GATE_LUFS,
  applyKWeighting,
  applyKWeightingInto,
  DEFAULT_LOUDNESS_BLOCK_SECONDS,
  DEFAULT_NORMALIZATION,
  kWeighting,
  measureLoudness,
  measureLoudnessStream,
  newKWeightingState,
  planLoudnessNormalization,
  TP_CONTEXT,
  TP_TAPS,
  TP_BLOCK,
  TP_MARGIN,
  truePeakWindowBound,
  TP_FILTER,
  truePeakAcrossJoin,
  truePeakEnvelope,
  truePeakEnvelopeRange,
  truePeakOf,
  type LoudnessMeasurement,
} from './lufs.ts';
import {
  blockSourceOf,
  DEFAULT_LIMITER,
  DEFAULT_LIMITER_BLOCK_SECONDS,
  limitTruePeak,
  limitTruePeakInBlocks,
  limitTruePeakStream,
  type BlockSource,
} from './limiter.ts';
import {
  applyClipGains,
  applyClipGainSources,
  attachClipGains,
  clipCarryLeads,
  clipLoudnessFrom,
  combineClipCarries,
  concatRanges,
  concatRangesSource,
  concatSources,
  DEFAULT_CLIP_MATCH,
  gainSource,
  groupClips,
  joinTruePeak,
  measureClips,
  measureClipsStream,
  measureTimelineFromClips,
  planClipMatch,
  type ClipSource,
  type ClipStreamSource,
} from './clip-match.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 音量だけが指定の速さで揺れる、単一の音程の音。
 *
 * もとは「声の音節らしさを模したもの」として置いていたが、**それは間違いだった**。
 * 中身は音程が変わらないままトレモロがかかった楽器で、声ではない。
 * いまは「音量は声のように揺れるが、声ではないもの」の代表として使っている。
 */
function makeModulated(seconds: number, sampleRate: number, hz: number, amp = 0.5): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * hz * t);
    data[i] = amp * env * Math.sin(2 * Math.PI * 200 * t);
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/**
 * 声らしい音。音節の速さで揺れ、**かつ音色が移り変わる**。
 *
 * 母音が移ると倍音の並び方が変わる、というところまで模している。
 * ここを模さないと「震える楽器」と区別が付かない
 * （実際、区別できないまま `music-tremolo.wav` に満点を出していた）。
 */
function makeSpeechLike(seconds: number, sampleRate: number, hz = 4, amp = 0.5): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  // 「あ」と「い」のつもりの倍音の重みを、音節と同じ速さで行き来させる。
  //
  // 速さも差の大きさも、両方いる。跳ばして切り替えると形の変化がその瞬間だけの棘になり、
  // ゆっくり移すと 1 コマあたりの差が小さくなって、どちらも「動いていない」に見える。
  // 差が小さいときも同じで、4 倍音で 0.7→0.15 程度だと形の変化が 0.057 までしか
  // 上がらず、震える楽器（0.026）と見分けられる域に届かなかった。
  const vowels = [
    [1, 0.8, 0.3, 0.1, 0.05, 0.02],
    [0.2, 0.1, 0.4, 0.8, 0.7, 0.4],
  ];
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * hz * t);
    // 母音は音節と同じ速さで移る。ここを遅くすると 1 コマあたりの形の差が
    // 小さくなり、「連続して動いているのに動いていないように見える」ことになる。
    const blend = 0.5 + 0.5 * Math.sin(2 * Math.PI * hz * t + Math.PI / 2);
    let v = 0;
    for (let h = 0; h < vowels[0].length; h += 1) {
      const weight = vowels[0][h] * (1 - blend) + vowels[1][h] * blend;
      v += weight * Math.sin(2 * Math.PI * 200 * (h + 1) * t);
    }
    data[i] = (amp * env * v) / 2;
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/**
 * 倍音列に、対数周波数上のガウス共鳴（フォルマント）を掛けた音。
 *
 * 「口の形（共鳴の居場所）」と「音程（f0）」を**別々に動かせる**ようにしてある。
 * 包絡の動きを測る量が、そのどちらに反応しているのかを切り分けるために要る。
 * 声らしい音（makeSpeechLike）はこの 2 つが一緒に動いてしまうので、それでは分からない。
 */
function makeFormantTone(
  seconds: number,
  sampleRate: number,
  { f0 = 200, glide = 0, formant = 800, sweep = 0, rate = 4, amp = 0.5, tremolo = false } = {},
): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const f = f0 * (1 + glide * (0.5 + 0.5 * Math.sin(2 * Math.PI * rate * t)));
    // 音程を動かすので、位相は積み上げる（周波数をそのまま時刻に掛けると跳ぶ）。
    phase += (2 * Math.PI * f) / sampleRate;
    const center = formant * Math.exp(sweep * Math.sin(2 * Math.PI * rate * t));
    const env = tremolo ? 0.55 + 0.45 * Math.sin(2 * Math.PI * rate * t) : 1;
    let v = 0;
    let norm = 0;
    for (let h = 1; h <= 20; h += 1) {
      if (f * h > sampleRate / 2) break;
      const d = Math.log((f * h) / center) / 0.7;
      const gain = Math.exp(-d * d) / h;
      v += gain * Math.sin(phase * h);
      norm += gain;
    }
    data[i] = norm > 0 ? (amp * env * v) / norm : 0;
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/**
 * 和音が一定の間隔で切り替わる音楽。声は入っていない。
 *
 * **素材単位の形の判定が何を測っているのかを切り分けるためのもの。**
 * 切り替わる間隔だけを変えて、ほかは 1 つも変えない。それで判定の結論がひっくり返るなら、
 * その判定は「声があるか」ではなく「変化がどれくらいの間隔で来るか」を見ていることになる。
 */
function makeChordProgression(seconds: number, sampleRate: number, everySeconds: number, amp = 0.5): AudioLike {
  const progression = [
    [220, 277.18, 329.63],
    [246.94, 293.66, 369.99],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
  ];
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const chord = progression[Math.floor(t / everySeconds) % progression.length];
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t);
    data[i] = (amp * v) / (chord.length * 1.4);
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/** 白色雑音。音色が平坦な音の代表として使う。 */
function makeNoise(seconds: number, sampleRate: number, amp = 0.3): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/**
 * 既にある音へ、指定した実効値の白色雑音を混ぜる。
 *
 * 「雑音があるかどうか」ではなく「**どれくらい小さな雑音で結論が変わるか**」を
 * 測るために要る。手元の音楽が正弦波の和ばかりだと、平坦さの表は
 * 「声 0.8 / 音楽 0.04」のようにきれいに開くが、その開きは
 * 声があるからではなく音楽が正弦波だから出ている。
 */
function mixNoise(base: AudioLike, rms: number, seed0: number): AudioLike {
  const source = base.getChannelData(0);
  const data = new Float32Array(source.length);
  let seed = seed0;
  // 一様乱数（-1〜1）の実効値は 1/√3 なので、指定の実効値になるように割り戻す。
  const amp = rms * Math.sqrt(3);
  for (let i = 0; i < source.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = source[i] + ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return { sampleRate: base.sampleRate, numberOfChannels: 1, length: source.length, getChannelData: () => data };
}

/**
 * 既にある音へ、ハイハットのつもりの打点を重ねる。
 *
 * 打点は**減衰する広帯域の雑音**で、高い成分から先に消えるわけではないが、
 * 減衰そのものがスペクトルの重心を動かす（打点の直後は雑音が支配的で、
 * 減衰すると下の和音が表に出てくる）。包絡はそれを「形が動いた」と読む。
 * 口の動きを測っているつもりの量が、実は**打楽器の減衰でも同じだけ動く**ことを示すために置いた。
 */
function addHats(base: AudioLike, hitsPerSecond: number, rms: number): AudioLike {
  const source = base.getChannelData(0);
  const data = new Float32Array(source.length);
  const sr = base.sampleRate;
  const period = sr / hitsPerSecond;
  const amp = rms * Math.sqrt(3);
  let seed = 20260913;
  for (let i = 0; i < source.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const env = Math.exp(-(i % period) / (0.035 * sr));
    data[i] = source[i] + ((seed / 0x7fffffff) * 2 - 1) * amp * env;
  }
  return { sampleRate: sr, numberOfChannels: 1, length: source.length, getChannelData: () => data };
}

/** 一次のハイパス。ハイハットを「高い帯域だけの音」にするために使う。 */
function highpassed(source: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = rc / (rc + 1 / sampleRate);
  const out = new Float32Array(source.length);
  let previousIn = 0;
  let previousOut = 0;
  for (let i = 0; i < source.length; i += 1) {
    previousOut = a * (previousOut + source[i] - previousIn);
    previousIn = source[i];
    out[i] = previousOut;
  }
  return out;
}

/**
 * 既にある音へ、**高い帯域だけの**ハイハットを重ねる。
 *
 * `addHats` の雑音は広帯域なので、打点が低い帯域も一緒に動かす。
 * 本物のハイハット（試し用の素材でも 6kHz より上）は下の和音を動かさないので、
 * 「高い側だけが動いたか」を確かめるにはこちらが要る。
 */
function addHighHats(base: AudioLike, hitsPerSecond: number, rms: number, cutoffHz = 6000): AudioLike {
  const source = base.getChannelData(0);
  const sr = base.sampleRate;
  const period = sr / hitsPerSecond;
  const amp = rms * Math.sqrt(3);
  let seed = 20260913;
  const raw = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = ((seed / 0x7fffffff) * 2 - 1) * amp * Math.exp(-(i % period) / (0.035 * sr));
  }
  const shaped = highpassed(raw, sr, cutoffHz);
  const data = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) data[i] = source[i] + shaped[i];
  return { sampleRate: sr, numberOfChannels: 1, length: source.length, getChannelData: () => data };
}

/** 高い帯域だけに、鳴りっぱなしの雑音を敷く（打点を「覆う」役）。 */
function addHighNoise(base: AudioLike, rms: number, seed0: number, cutoffHz = 6000): AudioLike {
  const source = base.getChannelData(0);
  const sr = base.sampleRate;
  const amp = rms * Math.sqrt(3);
  let seed = seed0;
  const raw = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  const shaped = highpassed(raw, sr, cutoffHz);
  const data = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) data[i] = source[i] + shaped[i];
  return { sampleRate: sr, numberOfChannels: 1, length: source.length, getChannelData: () => data };
}

/**
 * 既にある音へ、**ぴたりと 1 つの高さにある**音を、音節の速さで揺らして重ねる。
 *
 * 「揺れを低い帯域だけで見る」手の検算に使う（2026-09-16）。
 * フィルタで帯域を寄せた雑音では確かめられない——一次のフィルタは肩が緩いので、
 * 6kHz へ寄せたつもりの打点が 2kHz より下へも大きく漏れる
 * （実際、最初はそれで検算が落ちた。**判定ではなく素材のほうが間違っていた**）。
 * サイン波なら漏れは窓のぶんだけなので、「境目のどちら側に居るか」に曖昧さが無い。
 */
function addWobbling(base: AudioLike, toneHz: number, wobbleHz: number, amp: number): AudioLike {
  const source = base.getChannelData(0);
  const sr = base.sampleRate;
  const data = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    const t = i / sr;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * wobbleHz * t);
    data[i] = source[i] + amp * env * Math.sin(2 * Math.PI * toneHz * t);
  }
  return { sampleRate: sr, numberOfChannels: 1, length: source.length, getChannelData: () => data };
}

/** 指定した区間だけサイン波が鳴る、1ch の合成音を作る。 */
function makeTone(seconds: number, sampleRate: number, tones: { from: number; to: number; amp?: number }[]): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (const tone of tones) {
    const from = Math.round(tone.from * sampleRate);
    const to = Math.min(length, Math.round(tone.to * sampleRate));
    const amp = tone.amp ?? 0.5;
    for (let i = from; i < to; i += 1) data[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

export function runSelfTest(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  // --- 音量の測定 ---
  {
    const sr = 8000;
    const buffer = makeTone(1, sr, [{ from: 0, to: 1, amp: 0.5 }]);
    const track = analyzeLoudness(buffer, 0.02);
    // 振幅 0.5 のサイン波の RMS は 0.5/√2 ≒ 0.354 → 約 -9dB
    const middle = track.db[Math.floor(track.db.length / 2)];
    check('サイン波の音量が理論値と一致する', near(middle, toDb(0.5 / Math.SQRT2), 0.5), `${middle.toFixed(2)} dB`);
    check('コマ数が尺 ÷ hop と一致する', near(track.db.length, 1 / 0.02, 1), `${track.db.length} コマ`);
  }

  // --- 無音カット ---
  {
    const sr = 8000;
    // 無音 1s / 声 1s / 無音 0.5s / 声 1s / 無音 1s
    const buffer = makeTone(4.5, sr, [
      { from: 1, to: 2 },
      { from: 2.5, to: 3.5 },
    ]);
    const track = analyzeLoudness(buffer, 0.02);
    const threshold = autoThresholdDb(track, 0.25);
    check('自動しきい値が無音と声の間に来る', threshold > -100 && threshold < -12, `${threshold.toFixed(1)} dB`);

    // 0.5 秒の切れ目は minSilence(0.35) より長いので、2 本に分かれるはず。
    const split = planJetCut(track, { minSilence: 0.35, padding: 0.05 });
    check('切れ目が長ければ 2 本に分かれる', split.keep.length === 2, `${split.keep.length} 本`);
    check('前後の無音が落ちる', near(split.removed, 2.4, 0.2), `${split.removed.toFixed(2)} 秒を削減`);
    check(
      '残す区間が声の位置と合っている',
      near(split.keep[0].start, 0.95, 0.08) && near(split.keep[1].end, 3.55, 0.08),
      `${split.keep.map((r) => `${r.start.toFixed(2)}〜${r.end.toFixed(2)}`).join(' / ')}`,
    );

    // minSilence を 0.6 に上げると、0.5 秒の切れ目は繋がったままになるはず。
    const joined = planJetCut(track, { minSilence: 0.6, padding: 0.05 });
    check('切れ目が短ければ繋がったまま', joined.keep.length === 1, `${joined.keep.length} 本`);

    // 余白は語頭・語尾を食わないための保険。増やせば残る尺も増える。
    const padded = planJetCut(track, { minSilence: 0.35, padding: 0.2 });
    check('余白を増やすと残る尺が伸びる', padded.resultDuration > split.resultDuration, `${split.resultDuration.toFixed(2)} → ${padded.resultDuration.toFixed(2)} 秒`);

    // 全編無音なら 1 本も残らない。
    const quiet = planJetCut(analyzeLoudness(makeTone(2, sr, []), 0.02));
    check('全編無音なら何も残らない', quiet.keep.length === 0, `${quiet.keep.length} 本`);

    // --- 削減の中身を「無音を切ったぶん」と「鳴っているところを切ったぶん」に分ける ---
    //
    // 声の無い素材では削減率が実害の大きさを表さない（2026-09-14・3 回目）。
    // ここが狂うと、また居ない相手を追いかけることになる。
    {
      const cutSilence = cutSoundingSeconds(track, split);
      check(
        '無音だけを切ったなら、鳴っているところは切っていない',
        near(cutSilence, 0, 0.05),
        `${cutSilence.toFixed(2)} 秒`,
      );

      // 手で「鳴っているところ」を切る計画に差し替えると、その秒数がそのまま出る。
      // 音は 1.0〜2.0 と 2.5〜3.5 にあるので、1.5 秒から先を切れば 1.5 秒ぶん。
      const forced = { ...split, keep: [{ start: 0, end: 1.5 }], cut: [{ start: 1.5, end: 4.5 }] };
      const harm = cutSoundingSeconds(track, forced);
      check('鳴っているところを切れば、その秒数が出る', near(harm, 1.5, 0.06), `${harm.toFixed(2)} 秒`);

      // 全部残す計画なら、切った秒数はゼロ。
      const nothing = { ...split, keep: [{ start: 0, end: 4.5 }], cut: [] };
      check('何も切らなければゼロ', cutSoundingSeconds(track, nothing) === 0, '0.00 秒');

      // 余白のぶん、切る区間の端はコマ境界に乗らない。**コマ単位で数えると
      // 1 コマ（0.02 秒）に丸まってしまう**ので、重なりの長さで足していること。
      const sliver = { ...split, keep: [], cut: [{ start: 1.5, end: 1.505 }] };
      const part = cutSoundingSeconds(track, sliver);
      check('コマの一部しか覆わない区間は、その重なりぶんだけ数える', near(part, 0.005, 0.001), `${part.toFixed(4)} 秒`);

      // 鳴っているコマが 1 つも無い素材（尺ゼロ・全編無音）に、切る区間だけを渡された場合。
      // 画面からはこういう素材も放り込まれるので、ここで落ちないこと。
      const empty = analyzeLoudness(makeTone(0, sr, []), 0.02);
      check(
        '鳴っているコマが無ければ、どこを切ってもゼロ',
        cutSoundingSeconds(empty, { ...split, cut: [{ start: 0, end: 1 }] }) === 0,
        `${empty.db.length} コマ`,
      );

      // 区間が増えても、前へ戻らずに数え切れていること（尺に比例した手間の前提）。
      const many = {
        ...split,
        keep: [],
        cut: Array.from({ length: 50 }, (_, k) => ({ start: 1.0 + k * 0.02, end: 1.0 + k * 0.02 + 0.01 })),
      };
      const spread = cutSoundingSeconds(track, many);
      check('区間がいくつに分かれていても数え落とさない', near(spread, 0.5, 0.02), `${spread.toFixed(2)} 秒`);
    }

    // --- 余計に残した秒を、置き場所と値で分ける ---
    //
    // 精度（残したうち声だった率）は 1 つの数なので、そのままでは
    // 「頭に余白を付けすぎている」のか「発話の間を渡った」のか
    // 「関係ない所を丸ごと残した」のかが分からない。直す手はそれぞれ別（2026-09-15・2 回目）。
    {
      const truth = [
        { start: 1, end: 2 },
        { start: 3, end: 4 },
      ];

      const both = keepEdgeSeconds([{ start: 0.8, end: 2.2 }], truth);
      check(
        '発話をはみ出した前後が、頭と尻に分かれる',
        near(both.head, 0.2, 1e-9) && near(both.tail, 0.2, 1e-9) && both.bridge === 0 && both.stray === 0,
        `頭 ${both.head.toFixed(2)} / 尻 ${both.tail.toFixed(2)}`,
      );

      // 両どなりが声なら渡ったぶん。息継ぎを繋いだのはここに入るので、
      // 尻や頭と混ぜて数えると「余白を付けすぎている」と読み違える。
      const across = keepEdgeSeconds([{ start: 1.5, end: 3.5 }], truth);
      check(
        '発話と発話のあいだを渡ったぶんは、頭でも尻でもない',
        near(across.bridge, 1, 1e-9) && across.head === 0 && across.tail === 0,
        `渡った ${across.bridge.toFixed(2)} 秒`,
      );

      // **同じ切れ目でも、残し方で置き場所が変わる。** 途中で切れていれば
      // 前半は前の発話の尻、後半は次の発話の頭になる。渡ったことにはしない。
      const halves = keepEdgeSeconds(
        [
          { start: 2, end: 2.4 },
          { start: 2.6, end: 3 },
        ],
        truth,
      );
      check(
        '切れ目が途中で切れていれば、尻と頭に分かれる',
        near(halves.tail, 0.4, 1e-9) && near(halves.head, 0.4, 1e-9) && halves.bridge === 0,
        `尻 ${halves.tail.toFixed(2)} / 頭 ${halves.head.toFixed(2)}`,
      );

      // 残し方の端が、発話の端にぴたり接する場合。**その発話を残していなくても、
      // どなりが声であることは変わらない**（接している向きで頭か尻かが決まる）。
      const touching = keepEdgeSeconds(
        [
          { start: 0.5, end: 1 },
          { start: 2, end: 2.5 },
        ],
        truth,
      );
      check(
        '発話に接しているだけでも、頭と尻を見分ける',
        near(touching.head, 0.5, 1e-9) && near(touching.tail, 0.5, 1e-9) && touching.stray === 0,
        `頭 ${touching.head.toFixed(2)} / 尻 ${touching.tail.toFixed(2)}`,
      );

      // 区間が増えても、前へ戻らずに数え切れていること（尺に比例した手間の前提）。
      const manyTruth = Array.from({ length: 2000 }, (_, k) => ({ start: k * 2, end: k * 2 + 1 }));
      const manyKeep = Array.from({ length: 2000 }, (_, k) => ({ start: k * 2 - 0.1, end: k * 2 + 1.1 }));
      const startedEdges = performance.now();
      const wide = keepEdgeSeconds(manyKeep, manyTruth);
      check(
        '区間がいくつに分かれていても、尺に比例した手間で数え切る',
        performance.now() - startedEdges < 200 && near(wide.head + wide.tail, 2000 * 0.2, 0.5),
        `${(performance.now() - startedEdges).toFixed(0)}ms / 頭と尻 ${(wide.head + wide.tail).toFixed(1)} 秒`,
      );

      const away = keepEdgeSeconds([{ start: 5, end: 6 }], truth);
      check(
        'どの発話にも接していなければ、丸ごと誤りとして数える',
        near(away.stray, 1, 1e-9) && away.head === 0 && away.tail === 0 && away.bridge === 0,
        `無関係 ${away.stray.toFixed(2)} 秒`,
      );

      // 発話の中にすっぽり収まっていれば、余計に残したものは無い。
      const inside = keepEdgeSeconds([{ start: 1.2, end: 1.8 }], truth);
      check(
        '発話の中だけを残していれば、どこにも数えない',
        inside.head + inside.tail + inside.bridge + inside.stray === 0,
        '0.00 秒',
      );

      // 正解が 1 つも無い素材（声なし）。残したものは全部「無関係」に落ちる。
      const noTruth = keepEdgeSeconds([{ start: 0, end: 3 }], []);
      check('正解が空なら、残したぶんは全部が無関係', near(noTruth.stray, 3, 1e-9), `${noTruth.stray.toFixed(2)} 秒`);

      // --- 同じ秒を、声らしさの値で分ける ---
      //
      // 置き場所が分かっても、そこを残させたものが
      // 「判定そのもの」なのか「ヒステリシス」なのか「余白」なのかで手が変わる。
      const score = new Float32Array(track.db.length);
      const one = [{ start: 1, end: 2 }];
      // 0.50〜1.00（頭）は入る値の上、2.00〜2.50（尻）は入る値と出る値のあいだ。
      for (let i = 25; i < 50; i += 1) score[i] = 0.3;
      for (let i = 100; i < 125; i += 1) score[i] = 0.15;
      const bands = keepScoreSeconds(track, [{ start: 0.5, end: 2.5 }], one, score, 0.2, 0.1);
      check(
        '余計に残した秒が、声らしさの値で分かれる',
        near(bands.above, 0.5, 0.01) && near(bands.between, 0.5, 0.01) && near(bands.below, 0, 0.01),
        `以上 ${bands.above.toFixed(2)} / あいだ ${bands.between.toFixed(2)} / 未満 ${bands.below.toFixed(2)}`,
      );

      // 声に当たっているぶんは引く。**コマの途中で発話が終わる場合**、
      // 同じコマに声と余りが同居するので、多いほうへ寄せると 1 コマぶんずれる。
      const straddle = keepScoreSeconds(track, [{ start: 1, end: 2.01 }], [{ start: 1, end: 2.005 }], score, 0.2, 0.1);
      check(
        'コマの途中で発話が終わっても、はみ出したぶんだけ数える',
        near(straddle.above + straddle.between + straddle.below, 0.005, 0.001),
        `${(straddle.above + straddle.between + straddle.below).toFixed(4)} 秒`,
      );

      // **同じコマの中で「声だが残していない」と「残したが声でない」が同時に立つ場合。**
      // コマ単位で声のぶんを引くと、この 2 つが打ち消し合って 0 秒に見える。
      // 声を切ってしまっている素材では実際に起きるので、ここは残したところの中だけで引くこと。
      const crossed = keepScoreSeconds(
        track,
        [{ start: 1.01, end: 1.02 }],
        [{ start: 1, end: 1.01 }],
        score,
        0.2,
        0.1,
      );
      check(
        '同じコマで声を切り、別のところを残していても、打ち消し合わない',
        near(crossed.above + crossed.between + crossed.below, 0.01, 0.001),
        `${(crossed.above + crossed.between + crossed.below).toFixed(4)} 秒`,
      );

      // 出る値が入る値を上回っていても、planJetCut と同じく入る値まで引き下げる
      // （引き下げないと「あいだ」が負の幅になり、全部が未満に落ちる）。
      const swapped = keepScoreSeconds(track, [{ start: 0.5, end: 2.5 }], one, score, 0.2, 0.5);
      check(
        '出る値が入る値より大きくても、あいだが裏返らない',
        near(swapped.above, 0.5, 0.01) && near(swapped.below, 0.5, 0.01) && swapped.between === 0,
        `以上 ${swapped.above.toFixed(2)} / 未満 ${swapped.below.toFixed(2)}`,
      );

      // 長さの違う列を渡されたら、黙って 0 を返す（当てにならない数を出さない）。
      const mismatched = keepScoreSeconds(track, [{ start: 0.5, end: 2.5 }], one, new Float32Array(3), 0.2, 0.1);
      check(
        '長さの違う列を渡されたら数えない',
        mismatched.above + mismatched.between + mismatched.below === 0,
        '0.00 秒',
      );
    }

    // --- どう判定しても残る秒（`minimalKeepRanges`） ---
    //
    // 「余計に残した秒」を落ち度として読む前に、**取り返せない秒**を引くための下限
    // （2026-09-15・3 回目）。余白・繋ぎ・コマの粒は判定の出来と関係なく付く。
    {
      const hop = 0.02;
      const opts = { padding: 0.08, minSilence: 0.35, minKeep: 0.15 };
      const truth = [
        { start: 1, end: 2 },
        { start: 2.2, end: 3 },
        { start: 5, end: 6 },
      ];
      const minimal = minimalKeepRanges(truth, 8, hop, opts);

      // いちばん大事な性質。**下限が声を落としていたら、比べる相手にならない。**
      const covers = truth.every((u) => minimal.some((r) => r.start <= u.start + 1e-9 && r.end >= u.end - 1e-9));
      check('下限でも、声は 1 コマも落とさない', covers, minimal.map((r) => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(' / '));

      // 切れ目 0.2 秒は minSilence より短いので、下限でも繋がる。
      // **ここが「発話の間を渡った秒」のうち、落ち度でないぶん。**
      check(
        '切れ目が minSilence より短ければ、下限でも繋がる',
        minimal.length === 2 && near(minimal[0].start, 1, 1e-9) && near(minimal[0].end, 3, 1e-9),
        `${minimal.length} 本`,
      );

      // 発話の端がコマ境界に乗っているなら、**余白は 1 秒も余らない**。
      // 余白は「判定が遅れてよい幅」であって「必ず余る幅」ではない
      // （判定が 0.08 秒遅れて反応すれば、頭に付く 0.08 秒は消える）。
      const edges = keepEdgeSeconds(minimal, truth);
      check(
        'コマ境界に乗った発話なら、余白のぶんは余らない',
        near(edges.head, 0, 1e-9) && near(edges.tail, 0, 1e-9) && near(edges.bridge, 0.2, 1e-9),
        `頭 ${edges.head.toFixed(2)} / 尻 ${edges.tail.toFixed(2)} / 渡った ${edges.bridge.toFixed(2)}`,
      );

      // 端がコマ境界からずれていても覆う。余るのはコマ 1 つぶんまで。
      const offGrid = [{ start: 1.005, end: 1.995 }];
      const off = minimalKeepRanges(offGrid, 4, hop, opts);
      const slack = off[0].end - off[0].start - (offGrid[0].end - offGrid[0].start);
      check(
        '端がコマ境界からずれていても覆い、余りはコマ 1 つぶんまで',
        off[0].start <= 1.005 + 1e-9 && off[0].end >= 1.995 - 1e-9 && slack < 2 * hop,
        `${off[0].start.toFixed(3)}-${off[0].end.toFixed(3)}（余り ${slack.toFixed(3)}）`,
      );

      // 切れ目が minSilence より長ければ繋がない（繋いだら下限が甘くなる）。
      check('切れ目が長ければ、下限では繋がない', minimal.length === 2 && minimal[1].start > 4.9, `${minimal.length} 本`);

      // コマより短い発話。余白を足せば 1 コマで覆えるので、そこで止まる
      // （first > last になる枝。ここを素通りさせると区間が裏返る）。
      const blip = minimalKeepRanges([{ start: 1.001, end: 1.003 }], 4, hop, opts);
      check(
        'コマより短い発話でも、区間が裏返らない',
        blip.length === 1 && blip[0].end > blip[0].start && blip[0].start <= 1.001 && blip[0].end >= 1.003,
        `${blip[0].start.toFixed(3)}-${blip[0].end.toFixed(3)}`,
      );

      // 素材の端に寄った発話。余白は素材の外へはみ出さない。
      const atEdge = minimalKeepRanges([{ start: 0, end: 0.5 }], 0.5, hop, opts);
      check(
        '素材の端では、余白が外へはみ出さない',
        atEdge.length === 1 && near(atEdge[0].start, 0, 1e-9) && near(atEdge[0].end, 0.5, 1e-9),
        `${atEdge[0].start.toFixed(2)}-${atEdge[0].end.toFixed(2)}`,
      );

      // **道具の限界を 1 つ固定しておく。** `minKeep` が余白＋コマ 1 つ（0.18 秒）より
      // 大きいと、短い発話は下限からも落ちる。既定（0.15）では起きないが、
      // つまみを回したときに**下限が声を落とす**ことがあると知らずに読むと、
      // 精度の下限を甘く見積もる。
      const strict = minimalKeepRanges([{ start: 1, end: 1.02 }], 4, hop, { ...opts, minKeep: 0.5 });
      check('minKeep が大きいと、下限でも短い発話は落ちる（道具の限界）', strict.length === 0, `${strict.length} 本`);

      // 素材の外にはみ出した正解。数えると区間が裏返り、下限が負の幅になる。
      const outside = minimalKeepRanges([{ start: 9, end: 10 }], 8, hop, opts);
      check('素材の外の正解は、下限に数えない', outside.length === 0, `${outside.length} 本`);

      // 声の無い素材（正解が空）。下限も空でなければ、精度の下限が出せなくなる。
      check('正解が空なら、下限も空', minimalKeepRanges([], 8, hop, opts).length === 0, '0 本');
      check('尺が 0 なら、下限も空', minimalKeepRanges(truth, 0, hop, opts).length === 0, '0 本');

      // **下限は、実際の計画より狭いか同じでなければならない**（声を全部残している限り）。
      // 上回っていたら、比べる相手として使えない。合成の声で 1 本だけ確かめる。
      {
        const voiced = analyzeLoudness(makeTone(4, 8000, [{ from: 1, to: 2 }]), 0.02);
        const plan = planJetCut(voiced, { mode: 'level' });
        const truthOne = [{ start: 1, end: 2 }];
        const low = minimalKeepRanges(truthOne, voiced.duration, voiced.hop);
        const sum = (rs: { start: number; end: number }[]) => rs.reduce((t, r) => t + (r.end - r.start), 0);
        const kept = sum(plan.keep);
        check(
          '下限は、実際に残した秒を上回らない',
          sum(low) <= kept + 1e-9,
          `下限 ${sum(low).toFixed(2)}s / 実際 ${kept.toFixed(2)}s`,
        );
      }
    }

    // --- 計画 → クリップ ---
    const edits = toClipEdits(split.keep, { start: 10, duration: 4.5, sourceIn: 0 });
    check('分割後もタイムライン上で隙間なく並ぶ', edits.length === 2 && near(edits[1].start, edits[0].start + edits[0].duration, 1e-6), edits.map((e) => `${e.start.toFixed(2)}+${e.duration.toFixed(2)}`).join(' / '));
    check('置いた位置（10 秒）から始まる', near(edits[0].start, 10, 1e-6), `${edits[0].start} 秒`);

    // クリップが素材の一部しか使っていない場合は、その外は無視される。
    const trimmed = toClipEdits(split.keep, { start: 0, duration: 1.5, sourceIn: 2.5 });
    check('トリム済みクリップでは使っている範囲だけ切る', trimmed.length === 1 && trimmed[0].sourceIn >= 2.5, `${trimmed.length} 本 / sourceIn=${trimmed[0]?.sourceIn.toFixed(2)}`);
  }

  // --- ダッキング ---
  {
    const sr = 8000;
    const voice = analyzeLoudness(makeTone(4, sr, [{ from: 1, to: 2 }]), 0.02);
    const points = planDucking(voice, { duckDb: -12, attack: 0.1, release: 0.4, hold: 0.2, thresholdDb: -45 });
    check('声の前は下がっていない', near(gainAt(points, 0.5), 1, 0.02), gainAt(points, 0.5).toFixed(3));
    check('声のあいだは約 -12dB', near(gainAt(points, 1.5), 0.251, 0.02), gainAt(points, 1.5).toFixed(3));
    check('声のあとで戻る', near(gainAt(points, 3.5), 1, 0.02), gainAt(points, 3.5).toFixed(3));
    check('音量が 0〜1 に収まっている', points.every((p) => p.gain >= 0 && p.gain <= 1), `${points.length} 点`);
    check('時刻が昇順に並んでいる', points.every((p, i) => i === 0 || p.time >= points[i - 1].time), 'ok');

    const silent = planDucking(analyzeLoudness(makeTone(2, sr, []), 0.02));
    check('声が無ければ下げない', silent.length === 1 && silent[0].gain === 1, `${silent.length} 点`);
  }

  // --- 波形 ---
  {
    const peaks = buildPeaks(makeTone(1, 8000, [{ from: 0, to: 1, amp: 0.8 }]), 100);
    check('波形の山が振幅と一致する', near(Math.max(...peaks.max), 0.8, 0.02), Math.max(...peaks.max).toFixed(3));
    check('波形のバケット数が指定どおり', peaks.max.length === 100, `${peaks.max.length}`);
  }

  // --- FFT ---
  {
    // 8 周期ぶんちょうど入るサイン波を入れたら、その山だけが立つはず。
    const n = 256;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i += 1) input[i] = Math.sin((2 * Math.PI * 8 * i) / n);
    const scratch = fftScratch(n);
    magnitudes(input, scratch.re, scratch.im, scratch.mag);
    let peak = 0;
    for (let b = 1; b < scratch.mag.length; b += 1) if (scratch.mag[b] > scratch.mag[peak]) peak = b;
    check('FFT の山が入れた周波数と一致する', peak === 8, `bin ${peak}`);
    // 直流だけを入れたら、0 番以外は立たない。
    const flat = new Float32Array(n).fill(1);
    magnitudes(flat, scratch.re, scratch.im, scratch.mag);
    let others = 0;
    for (let b = 2; b < scratch.mag.length; b += 1) others = Math.max(others, scratch.mag[b]);
    check('直流だけなら他の周波数は立たない', others < 1e-6, others.toExponential(1));
  }

  // --- 声らしさ ---
  {
    const sr = 16000;
    // 4Hz で揺れる音は「音節らしい」、まったく揺れない音はそうではない。
    const modulated = analyzeLoudness(makeModulated(3, sr, 4), 0.02);
    const steady = analyzeLoudness(makeTone(3, sr, [{ from: 0, to: 3 }]), 0.02);
    const mid = (a: Float32Array) => a[Math.floor(a.length / 2)];
    const modOn = mid(modulationRatio(modulated));
    const modOff = mid(modulationRatio(steady));
    check('4Hz で揺れる音は揺れが検出される', modOn > 0.5, modOn.toFixed(3));
    check('揺れない音では検出されない', modOff < 0.2, modOff.toFixed(3));

    // --- 揺れの帯域は 1.5625Hz 刻みでしか置けない（2026-09-12・2 回目に測って分かった）---
    //
    // 窓は `MOD_WINDOW`（1.0 秒）を 2 の冪に丸めるので、実際には 32 コマ = **0.64 秒**。
    // コマが 50/秒なので、FFT の刻みは 50/32 = 1.5625Hz。つまり
    // 「3〜6Hz」と書いてある帯域は本当は bin 2〜4 = **3.125〜6.25Hz** で、
    // 下端に 2.5〜3.9 のどれを渡しても同じ帯域になる。2 を渡すと bin 1 へ落ちて
    // **1.5625Hz を巻き込む**（そこは音楽の抑揚が乗る帯で、渡すと音楽が声に見える）。
    // 「3 では狭いから 2 にしてみる」という連続な調整ができない、というのがここの要点。
    // 知らずに回すと「少しだけ広げたつもり」が「音楽を丸ごと巻き込む」になる。
    const at2 = mid(modulationRatio(modulated, 2, 6));
    const at3 = mid(modulationRatio(modulated, 3, 6));
    const at39 = mid(modulationRatio(modulated, 3.9, 6));
    check('下端 3 と 3.9 は同じ帯域になる（bin 2）', at3 === at39, at3.toFixed(4));
    check('下端 2 は bin 1 へ落ちて別物になる', at2 !== at3, `2→${at2.toFixed(4)} / 3→${at3.toFixed(4)}`);

    // --- 音節が遅い声は、そもそも帯域の下にいる ---
    //
    // 窓が 0.64 秒しかないので、音節が 1.4Hz（0.7 秒ごと）の声では
    // **窓の中に音節の切れ目が 1 つしか入らない**。つまりこの量は、遅い声に対しては
    // 「音節の速さ」を測っていない。切れ目 1 つの形を見ているだけ。
    // 伸ばした母音でしゃべる声（`speech-sustained.wav` は 0.45〜0.95 秒ごと）が
    // 苦しいのは、判定の調整のせいではなく**定義上ここに入っていない**から。
    const fast = mid(modulationRatio(analyzeLoudness(makeModulated(3, sr, 4.2), 0.02)));
    const slow = mid(modulationRatio(analyzeLoudness(makeModulated(3, sr, 1.4), 0.02)));
    check('音節が遅い声は揺れが大きく下がる', slow < fast * 0.7, `1.4Hz ${slow.toFixed(3)} / 4.2Hz ${fast.toFixed(3)}`);

    // --- 窓を伸ばしても遅い声は拾えない（2026-09-12・3 回目に測って分かった）---
    //
    // 前の回の記録には「窓を 1.28 秒（64 コマ）に伸ばせば刻みが 0.78Hz になり、
    // 3Hz より下を巻き込まずに広げられる」と書いてあった。**測ったら逆だった。**
    // 窓を伸ばすと、伸ばしたぶんだけ**いちばん遅い帯（0.78Hz）に取り分が移る**。
    // そこには音節ではなく、発話そのものの入り切りと音量の流れが乗っている。
    // `speech.wav` の声のコマで測ると 3〜6Hz の取り分は 50.9% → 27.5%、
    // いちばん遅い帯は 34.9% → 63.6%。声も音楽も一緒に下がるので、
    // 固定のしきい値に対しては**声だけが先に落ちる**（取りこぼしが増える）。
    //
    // ここでは発話の入り切りを模した列（1.2 秒鳴って 0.7 秒黙る・鳴っている間は 4Hz）で、
    // 窓を伸ばすと取り分が下がることを固定しておく。
    {
      const hop = 0.02;
      const frames = 500;
      const db = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) {
        const t = i * hop;
        const speaking = t % 1.9 < 1.2;
        db[i] = speaking ? -20 + 6 * Math.sin(2 * Math.PI * 4 * t) : -55;
      }
      const track: LoudnessTrack = { hop, db, duration: frames * hop };
      const narrow = mid(modulationRatio(track, 3, 6, 1.0));
      const wide = mid(modulationRatio(track, 3, 6, 1.28));
      check('窓を伸ばすと音節帯の取り分は下がる（上がらない）', wide < narrow, `0.64s ${narrow.toFixed(3)} → 1.28s ${wide.toFixed(3)}`);
    }

    // --- 分母に遅い揺れを敷いてあるのは、遅いうねりで音楽を弾くため ---
    //
    // 揺れの割合は「音節帯 ÷ 窓の中の揺れ全部」。分母に遅い帯が入っているので、
    // ゆっくり大きくうねる音は、上に音節と同じ速さの刻みが乗っていても割合が低く出る。
    // **これが効いている**ことを固定しておく。同じ回に「分母からいちばん遅い帯を外す」手を
    // 試したが、外すと `music-swell.wav` の声らしさの中央値が 0.229 → 0.884 に跳ね、
    // 本物の声のどれよりも高くなった（`bgm.wav` も声らしいコマが 14% → 95%）。
    // 分母は「ほかにどんな揺れがあるか」を見る場所で、削ると比べる相手が消える。
    {
      const hop = 0.02;
      const frames = 500;
      const swelling = new Float32Array(frames);
      const flat = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) {
        const t = i * hop;
        const ripple = 0.6 * Math.sin(2 * Math.PI * 4.2 * t);
        // 0.5Hz で 12dB 上下する、ゆっくり大きなうねり。
        swelling[i] = -25 + 12 * Math.sin(2 * Math.PI * 0.5 * t) + ripple;
        flat[i] = -25 + ripple;
      }
      const withSwell = mid(modulationRatio({ hop, db: swelling, duration: frames * hop }, 3, 6, 1.0));
      const without = mid(modulationRatio({ hop, db: flat, duration: frames * hop }, 3, 6, 1.0));
      check(
        'ゆっくり大きなうねりは、同じ刻みでも揺れの割合を押し下げる',
        withSwell < without * 0.5,
        `うねり有 ${withSwell.toFixed(3)} / 無 ${without.toFixed(3)}`,
      );
    }

    // 音色: 音程のある音は尖っていて、雑音は平坦。
    const toneBuffer = makeModulated(2, sr, 4);
    const noiseBuffer = makeNoise(2, sr);
    const toneFeatures = analyzeFeatures(toneBuffer, analyzeLoudness(toneBuffer, 0.02));
    const noiseFeatures = analyzeFeatures(noiseBuffer, analyzeLoudness(noiseBuffer, 0.02));
    check('音程のある音は尖っている', mid(toneFeatures.tone) > 0.9, mid(toneFeatures.tone).toFixed(3));
    check('雑音は平坦', mid(noiseFeatures.tone) < mid(toneFeatures.tone) - 0.1, mid(noiseFeatures.tone).toFixed(3));

    // --- `tone` が測っているのは「雑音の量」ではなく「純粋な正弦波かどうか」 ---
    // 2026-09-13 に素材の側で分かったことを、ここに固定しておく。
    // 音程のある音に**耳では聞こえないほど小さな**広帯域の雑音を混ぜるだけで、
    // 平坦さは一気に上がる（= `tone` が落ちる）。平坦さは帯域ごとの**幾何平均 ÷ 算術平均**なので、
    // 谷が 0 に近いほど幾何平均が潰れる。正弦波の和は倍音と倍音の間がほぼ 0 で、
    // そこへ小さな雑音を敷くと**底上げのほうが効く**。雑音の量には比例しない。
    //
    // だから「平坦さが高い＝雑音がある＝声」という読み方は成り立たない。
    // 声のほうが平坦に見えていたのは、比べる相手（手元の音楽）が正弦波だけで作られていたから。
    // 実際、雑音を持つ音楽を足したら平坦さの上位 10% は music-hats 0.685 / music-flute 0.663 まで上がり、
    // 本物の声 4 本（0.301〜0.585）を追い越した。
    {
      const dirty = mixNoise(makeModulated(2, sr, 4), 0.5 * 0.032, 4242);
      const dirtyTone = mid(analyzeFeatures(dirty, analyzeLoudness(dirty, 0.02)).tone);
      check(
        '-30dB の雑音を混ぜるだけで音色の尖りは崩れる',
        dirtyTone < mid(toneFeatures.tone) - 0.3,
        `雑音入り ${dirtyTone.toFixed(3)} / 無し ${mid(toneFeatures.tone).toFixed(3)}`,
      );
    }

    // --- 減衰する雑音の打点は、音色が移り変わらなくても包絡を動かす ---
    // ハイハットは打点のあとに**高い成分から先に減衰する**ので、鳴っている間ずっと
    // スペクトルの重心が下がり続ける。包絡（ケプストラム）はそれを「形が動いた」と読む。
    // 口の動きとは何の関係も無いのに、コマ単位の門をここで開けてしまう。
    //
    // 素材の側では `music-hats.wav`（和音＋ハイハット）が、ハイハットを足しただけで
    // 包絡の動いた秒数 1.44 → 12.98 秒（13 秒中）になった。その仕組みをここに固定する。
    {
      // 鳴り始めの過渡を避けるため、真ん中だけを見て中央値を取る。
      const median = (a: Float32Array) => {
        const from = Math.floor(a.length * 0.25);
        const values = Array.from(a.slice(from, Math.ceil(a.length * 0.75))).sort((x, y) => x - y);
        return values.length ? values[Math.floor(values.length / 2)] : 0;
      };
      const chord = makeTone(2, sr, [{ from: 0, to: 2 }]);
      // 打点の実効値は和音に対する比で置く（和音の実効値は 0.5/√2 = 0.354）。
      // 0.2 は -5dB で、素材の `music-hats.wav`（-5.3dB）とほぼ同じ。
      const loudHats = addHats(chord, 4.2, 0.2);
      // 0.05 は -17dB。**混ぜていると分かる程度でしかない量**でも、形の判定はもう破れる。
      const faintHats = addHats(chord, 4.2, 0.05);
      const plainFeatures = analyzeFeatures(chord, analyzeLoudness(chord, 0.02));
      const plain = median(plainFeatures.envelopeChange);
      const ticked = median(analyzeFeatures(loudHats, analyzeLoudness(loudHats, 0.02)).envelopeChange);
      const faintShape = median(analyzeFeatures(faintHats, analyzeLoudness(faintHats, 0.02)).shapeChange);
      check('和音だけでは包絡は動かない', plain < DEFAULT_JET_CUT.minEnvelopeChange, plain.toFixed(4));
      check(
        '減衰する雑音の打点を足すと、口が動かなくても門が開く',
        ticked >= DEFAULT_JET_CUT.minEnvelopeChange,
        `打点有 ${ticked.toFixed(4)} / 無 ${plain.toFixed(4)}`,
      );
      check(
        '-17dB の打点でも形の判定は破れる',
        faintShape >= 0.09 && median(plainFeatures.shapeChange) < 0.09,
        `薄い打点 ${faintShape.toFixed(4)} / 無 ${median(plainFeatures.shapeChange).toFixed(4)}`,
      );
    }

    // --- 打点の減衰と口の動きは、重心の「向き」で分かれる ---
    // 上の段で「減衰する打点は包絡を動かす」ことを固定した。その続きで、
    // **包絡が拾えなかった区別**をここに固定する（2026-09-13・2 回目に測った）。
    //
    // 打点は立ち上がりで重心が一気に上がり、そのあと減衰のあいだ単調に下がり続ける。
    // 口の動きは向きがばらばらなので、下がった歩みと上がった歩みがほぼ半々になる。
    // 素材の側では music-hats.wav（ハイハット単体）0.824 に対し、
    // **同じハイハットの上でしゃべる speech-hats.wav は 0.588**（声は 1 ビットも同じ）。
    {
      // まず計算そのものを、作った重心の列で確かめる（音を通さない）。
      const hop = 0.02;
      const frames = 100;
      const level = new Float32Array(frames).fill(-20);

      // ① 打点の形。1 歩で跳ね上がり、11 歩かけて下がる（4.2Hz の打点に近い周期）。
      const sawtooth = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) sawtooth[i] = 3000 - 200 * (i % 12);
      const sawRatio = centroidDescentRatio(sawtooth, level, hop)[50];
      check('跳ねて下がり続ける重心は下降率が高い', sawRatio > 0.8, sawRatio.toFixed(3));

      // ② 口の動きの形。1 歩ごとに向きが変わる。
      const zigzag = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) zigzag[i] = 1500 + (i % 2 === 0 ? 200 : -200);
      const zigRatio = centroidDescentRatio(zigzag, level, hop)[50];
      check('向きが入れ替わる重心は半々になる', near(zigRatio, 0.5, 0.1), zigRatio.toFixed(3));

      // ③ 動かない重心は「下がっていない」。迷ったら声の側（0）に倒す設計。
      const flat = new Float32Array(frames).fill(1500);
      check('動かない重心の下降率は 0', centroidDescentRatio(flat, level, hop)[50] === 0, '0.000');

      // ④ 音が出ていないコマを挟んだ歩みは数えない。
      //    ここを数えると、鳴り始めの 1 歩が巨大な向きとして混ざる。
      const gapLevel = new Float32Array(frames).fill(-20);
      for (let i = 40; i < 60; i += 1) gapLevel[i] = -100;
      const atGap = centroidDescentRatio(sawtooth, gapLevel, hop)[50];
      check('無音のあいだは歩みを数えない（足りなければ 0）', atGap === 0, atGap.toFixed(3));

      // ここから音を通して確かめる。和音 → 和音＋ハイハット → さらに声を重ねる。
      const median = (a: Float32Array) => {
        const from = Math.floor(a.length * 0.25);
        const values = Array.from(a.slice(from, Math.ceil(a.length * 0.75))).sort((x, y) => x - y);
        return values.length ? values[Math.floor(values.length / 2)] : 0;
      };
      const descentOf = (buffer: AudioLike) =>
        median(analyzeFeatures(buffer, analyzeLoudness(buffer, 0.02)).centroidDescent);
      const chord = makeTone(2, sr, [{ from: 0, to: 2 }]);
      const hats = addHats(chord, 4.2, 0.2);
      // 声を重ねる。`makeSpeechLike` は音色が移り変わるので、重心が両向きに振れる。
      const withSpeech = ((): AudioLike => {
        const a = hats.getChannelData(0);
        const b = makeSpeechLike(2, sr, 4).getChannelData(0);
        const data = new Float32Array(a.length);
        for (let i = 0; i < a.length; i += 1) data[i] = a[i] + b[i];
        return { sampleRate: sr, numberOfChannels: 1, length: a.length, getChannelData: () => data };
      })();
      const plainDescent = descentOf(chord);
      const hatsDescent = descentOf(hats);
      const speechDescent = descentOf(withSpeech);
      check('和音だけでは重心が下がり続けない', plainDescent < 0.65, plainDescent.toFixed(3));
      check(
        '減衰する打点を足すと重心が下がり続ける',
        hatsDescent >= 0.65,
        `打点有 ${hatsDescent.toFixed(3)} / 無 ${plainDescent.toFixed(3)}`,
      );
      // **ここが、この量を判定に入れなかった理由**（2026-09-13・2 回目）。
      // `makeSpeechLike` は 200Hz の倍音 6 本しか持たないので、1.2kHz より上に何も出さない。
      // そういう声を重ねても下降率は 1 ポイントも落ちない。
      // 重心はいちばん高い所にある音に引きずられるので、**声が高い帯域を覆っていなければ
      // 重心を動かしているのは打点の減衰だけ**になる。
      // 素材の側でも同じで、子音も息もある声を乗せた `speech-hats.wav` は声のコマの 29% しか
      // 打点の側に落ちないのに、子音の無い `speech-vowels-hats.wav` は **83%** が落ちる。
      check(
        '高い帯域に何も出さない声を重ねても下降率は落ちない（子音に頼っている）',
        near(speechDescent, hatsDescent, 0.05),
        `声入り ${speechDescent.toFixed(3)} / 打点だけ ${hatsDescent.toFixed(3)}`,
      );
      // 裏返すと、**声でなくてもよい**。高い帯域に雑音を敷くだけで下降率は落ちる。
      // つまりこの量が見ているのは「口が動いたか」ではなく「高い帯域が覆われているか」。
      const covered = mixNoise(hats, 0.2, 913);
      const coveredDescent = descentOf(covered);
      check(
        '声でなくても、高い帯域に雑音を敷けば下降率は落ちる',
        coveredDescent < 0.65,
        `雑音入り ${coveredDescent.toFixed(3)} / 打点だけ ${hatsDescent.toFixed(3)}`,
      );

      // ⑤ 向きしか見ていないので、音量を何倍にしても値は変わらない。
      const halved = ((): AudioLike => {
        const src = hats.getChannelData(0);
        const data = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 1) data[i] = src[i] * 0.5;
        return { sampleRate: sr, numberOfChannels: 1, length: src.length, getChannelData: () => data };
      })();
      check(
        '音量倍率を変えても下降率は変わらない',
        near(descentOf(halved), hatsDescent, 0.02),
        `×0.5 ${descentOf(halved).toFixed(3)} / ×1 ${hatsDescent.toFixed(3)}`,
      );
    }

    // --- 打点は「高い帯域だけ」が動く。声は帯域をまたいで一緒に動く ---
    // 上の重心は、スペクトルを 1 つの数へ潰してから向きを見る量だったので、
    // いちばん高い所にある弱い音に引きずられて壊れた（-34dB のハイハットで飽和する）。
    // 潰さずに、低い側の束と高い側の束を別々に見て、**高い側だけが動いた歩み**を数える。
    // 2026-09-13 の 3 回目にコマ単位の門として入れようとして、**測って捨てた**量。
    // 計算そのものは残してあるので、ここでは計算が合っていることと、
    // **どこで破れるか**（高い帯域が覆われると打点が見えなくなる）を固定する。
    {
      const hop = 0.02;
      const frames = 100;
      const bands = 26;
      const split = 14;
      const level = new Float32Array(frames).fill(-20);
      // 帯域の列を手で作る。`log(エネルギー)` のつもりなので、足し算が音量倍率にあたる。
      const build = (at: (frame: number, band: number) => number) => {
        const out = new Float32Array(frames * bands);
        for (let i = 0; i < frames; i += 1) for (let b = 0; b < bands; b += 1) out[i * bands + b] = at(i, b);
        return out;
      };

      // ① 音節の切れ目。全帯域が一緒に上下する。「高い側だけ」ではないので 0。
      const together = build((i) => (i % 2 === 0 ? 0 : 1));
      check(
        '帯域が一緒に動くときは「高い側だけ」にならない',
        highBandAloneRatio(together, bands, split, level, hop)[50] === 0,
        '0.000',
      );

      // ② 打点。高い側だけが跳ねて減衰し、低い側（和音）は動かない。
      const hatsOnly = build((i, b) => (b < split ? 0 : 2 - 0.4 * (i % 6)));
      const hatsRatio = highBandAloneRatio(hatsOnly, bands, split, level, hop)[50];
      check('高い側だけが動くときは 1 になる', hatsRatio === 1, hatsRatio.toFixed(3));

      // ③ 鳴りっぱなし。どちらも動かない歩みは**数えない**（分母にも入れない）。
      //    ここを「揃っている」と数えると、動いていないものが分けられているように見える。
      const still = build(() => 0);
      check('どの帯域も動かなければ 0（迷ったら声の側）', highBandAloneRatio(still, bands, split, level, hop)[50] === 0, '0.000');

      // ④ 音量倍率に不変。対数の列なので、音量 a 倍は全帯域・全コマに log a を足すのと同じ。
      const louder = build((i, b) => hatsOnly[i * bands + b] + 3.5);
      check(
        '音量を変えても「高い側だけ」の割合は変わらない',
        highBandAloneRatio(louder, bands, split, level, hop)[50] === hatsRatio,
        `+log a ${highBandAloneRatio(louder, bands, split, level, hop)[50].toFixed(3)} / 元 ${hatsRatio.toFixed(3)}`,
      );

      // ⑤ 境目が帯域の外に出たら（標本化周波数が低すぎて高い帯域が無いとき）門を置かない。
      //    渡されていない列を「打点だった」と読まないのと同じで、迷ったら声の側へ倒す。
      check(
        '境目が範囲外なら 0（門を置かない側に倒す）',
        highBandAloneRatio(hatsOnly, bands, bands, level, hop)[50] === 0,
        '0.000',
      );

      // ⑥ 帯域の列が足りないときは 0（配列の外を読んで NaN に化けさせない）。
      check(
        '帯域の列が足りなければ 0（黙って NaN にしない）',
        highBandAloneRatio(hatsOnly.slice(0, 10 * bands), bands, split, level, hop)[50] === 0,
        '0.000',
      );

      // ⑦ 無音を挟んだ歩みは数えない（重心の下降率と同じ理由）。
      const gapLevel = new Float32Array(frames).fill(-20);
      for (let i = 40; i < 60; i += 1) gapLevel[i] = -100;
      check(
        '無音のあいだは歩みを数えない（足りなければ 0）',
        highBandAloneRatio(hatsOnly, bands, split, gapLevel, hop)[50] === 0,
        '0.000',
      );

      // ここから音を通して確かめる。和音 → 和音＋ハイハット → 高い帯域を雑音で覆う。
      const median = (a: Float32Array) => {
        const from = Math.floor(a.length * 0.25);
        const values = Array.from(a.slice(from, Math.ceil(a.length * 0.75))).sort((x, y) => x - y);
        return values.length ? values[Math.floor(values.length / 2)] : 0;
      };
      const aloneOf = (buffer: AudioLike) =>
        median(analyzeFeatures(buffer, analyzeLoudness(buffer, 0.02)).highBandAlone);
      const chord = makeTone(2, sr, [{ from: 0, to: 2 }]);
      // ここだけ `addHats`（広帯域）ではなく高い帯域だけの打点を使う。
      // 広帯域の打点は低い帯域も一緒に動かすので、この量では「高い側だけ」にならない
      // （実測 0.300）。本物のハイハットは 6kHz より上に寄っているので、そちらを模す。
      const hats = addHighHats(chord, 4.2, 0.2);
      // 門にするなら 0.5（数えた歩みの半分より多い）だった、というだけの値。
      // **判定には入れていない**ので、silence.ts の既定値から取らずにここへ書く。
      const gate = 0.5;
      const plainAlone = aloneOf(chord);
      const hatsAlone = aloneOf(hats);
      check('和音だけでは「高い側だけ」は立たない', plainAlone < gate, plainAlone.toFixed(3));
      check(
        '減衰する打点を足すと「高い側だけ」が立つ',
        hatsAlone >= gate,
        `打点有 ${hatsAlone.toFixed(3)} / 無 ${plainAlone.toFixed(3)}`,
      );
      // **この量の限界をここに固定する。** 高い帯域を何かが覆えば、打点は「高い側だけ」に
      // 見えなくなる。声である必要は無い（雑音でよい）ので、この門は
      // 「口が動いたか」ではなく「高い帯域が覆われているか」も一緒に見ている。
      // ハミングのように高い帯域へ何も出さない声は覆えないので、その上の打点は残る。
      const covered = addHighNoise(hats, 0.2, 913);
      const coveredAlone = aloneOf(covered);
      check(
        '高い帯域を雑音が覆うと打点は見えなくなる（この門の限界）',
        coveredAlone < hatsAlone,
        `雑音入り ${coveredAlone.toFixed(3)} / 打点だけ ${hatsAlone.toFixed(3)}`,
      );
    }

    // 形の変化は行ったり来たりする量なので、1 コマだけで比べると
    // たまたま折り返し点（変化がいちばん小さい所）を掴んで結論が変わる。
    // 真ん中あたりを均して見る。
    const midMean = (a: Float32Array) => {
      const from = Math.floor(a.length * 0.25);
      const to = Math.max(from + 1, Math.ceil(a.length * 0.75));
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += a[i];
      return sum / (to - from);
    };

    // --- 形の変化（音量倍率に不変であること） ---
    // ここが不変でないと、音量が揺れているだけの音を「中身が動いている」と誤る。
    const loud = makeSpeechLike(2, sr, 4, 0.5);
    const soft = makeSpeechLike(2, sr, 4, 0.125);
    const loudShape = midMean(analyzeFeatures(loud, analyzeLoudness(loud, 0.02)).shapeFlux);
    const softShape = midMean(analyzeFeatures(soft, analyzeLoudness(soft, 0.02)).shapeFlux);
    check(
      '形の変化は音量を 1/4 にしても変わらない',
      Math.abs(loudShape - softShape) < 0.01,
      `${loudShape.toFixed(4)} vs ${softShape.toFixed(4)}`,
    );
    // 音程が変わらないままトレモロがかかった音は、音量が揺れていても形は（ほとんど）動かない。
    // ぴったり 0 にならないのは、窓の中で包絡が動くぶんの側帯波が出るため。
    check(
      '音量だけ揺れる音では形がほとんど動かない',
      midMean(toneFeatures.shapeFlux) < 0.04,
      midMean(toneFeatures.shapeFlux).toFixed(4),
    );
    const speechBuffer = makeSpeechLike(2, sr, 4);
    const speechFeatures = analyzeFeatures(speechBuffer, analyzeLoudness(speechBuffer, 0.02));
    check(
      '音色が移り変わる音では形が動く',
      midMean(speechFeatures.shapeFlux) > midMean(toneFeatures.shapeFlux) + 0.02,
      `${midMean(speechFeatures.shapeFlux).toFixed(4)} > ${midMean(toneFeatures.shapeFlux).toFixed(4)}`,
    );

    // --- 包絡（フォルマントの居場所）の動き ---
    // 形の変化（shapeFlux）は、声と背景の混ざり方が変わることで動いていた。
    // 背景の無い素材では声でも動かないので、そこを分けられるかを確かめる。
    // 同じ音を何度も測るので、一度出した値は覚えておく（解析は毎回そこそこ重い）。
    const envCache = new Map<AudioLike, number>();
    const envMean = (b: AudioLike) => {
      const found = envCache.get(b);
      if (found !== undefined) return found;
      const value = midMean(analyzeFeatures(b, analyzeLoudness(b, 0.02)).envelopeFlux);
      envCache.set(b, value);
      return value;
    };

    check(
      '包絡の動きは音量を 1/4 にしても変わらない',
      Math.abs(envMean(loud) - envMean(soft)) < 0.001,
      `${envMean(loud).toFixed(4)} vs ${envMean(soft).toFixed(4)}`,
    );
    // ここが今回の要。震える楽器は音量しか動いていないので、包絡は動かない。
    check(
      '音量だけ揺れる音では包絡がほとんど動かない',
      envMean(toneBuffer) < 0.05,
      envMean(toneBuffer).toFixed(4),
    );
    check(
      '音色が移り変わる音では包絡が大きく動く',
      envMean(speechBuffer) > envMean(toneBuffer) * 10,
      `${envMean(speechBuffer).toFixed(4)} > ${envMean(toneBuffer).toFixed(4)} の 10 倍`,
    );
    // 形の変化では、この 2 つがここまで開かない（実素材では並んでしまう）。
    check(
      '同じ 2 つを形の変化で見ると、開きはずっと小さい',
      midMean(speechFeatures.shapeFlux) < midMean(toneFeatures.shapeFlux) * 10,
      `${midMean(speechFeatures.shapeFlux).toFixed(4)} / ${midMean(toneFeatures.shapeFlux).toFixed(4)}`,
    );

    // 共鳴の居場所だけを動かす（＝口の形だけが動く）と、包絡は動く。
    const sweeping = makeFormantTone(2, sr, { sweep: Math.log(2) / 2 });
    check('共鳴の居場所が動くと包絡が動く', envMean(sweeping) > 0.2, envMean(sweeping).toFixed(4));
    // **ここは「できないこと」を固定しておくための検算。**
    // 口の形を止めたまま音程だけを動かしても、この量は同じくらい動いてしまう。
    // 「口の動きだけを見ている」と思い込むと、ビブラートのかかった楽器で足をすくわれる。
    const gliding = makeFormantTone(2, sr, { glide: 1 });
    check(
      '音程だけ動かしても包絡は動く（音程には不変ではない）',
      envMean(gliding) > envMean(sweeping) * 0.3,
      `音程 ${envMean(gliding).toFixed(4)} / 共鳴 ${envMean(sweeping).toFixed(4)}`,
    );

    // --- 声らしさ ---
    check(
      '声らしさは「揺れる音程のある音」で高い',
      mid(toneFeatures.speechScore) > mid(noiseFeatures.speechScore),
      `${mid(toneFeatures.speechScore).toFixed(3)} > ${mid(noiseFeatures.speechScore).toFixed(3)}`,
    );
    // **ここが今回いちばん大事な検算。**
    // 震える楽器は声ではないのに、声らしさ（揺れの速さ × 音色の尖り）では
    // 本物の声と同じかそれ以上に見える。だから声らしさだけでは弾けない。
    check(
      '震える楽器は、声らしさだけでは声と見分けられない',
      mid(toneFeatures.speechScore) >= mid(speechFeatures.speechScore) * 0.9,
      `震える楽器 ${mid(toneFeatures.speechScore).toFixed(3)} / 声 ${mid(speechFeatures.speechScore).toFixed(3)}`,
    );

    // --- 素材単位で「形がどこでも動かないもの」を弾く ---
    {
      // 震える楽器だけの素材。声らしさは満点に近いが、形はどこでも動かない。
      const tremoloTrack = analyzeLoudness(toneBuffer, 0.02);
      const tremoloPlan = planJetCut(
        tremoloTrack,
        { mode: 'speech' },
        toneFeatures.speechScore,
        toneFeatures.shapeChange,
      );
      check('震える楽器だけの素材では何もしない', tremoloPlan.noSpeechFound, `削った ${tremoloPlan.removed.toFixed(2)} 秒`);
      check('その理由が「形が動かない」と分かる', tremoloPlan.noSpeechReason === 'shape', String(tremoloPlan.noSpeechReason));
      check(
        'そのとき声らしさ自体は高いままである（割合では弾けていない）',
        tremoloPlan.speechRatio > 0.5,
        tremoloPlan.speechRatio.toFixed(3),
      );
      // 形の列を渡さなければ、形では判断しない。渡されないものを
      // 「動いていない」と読むと、既存の呼び出しが軒並み何もしなくなる。
      const withoutShape = planJetCut(tremoloTrack, { mode: 'speech' }, toneFeatures.speechScore);
      check('形の列を渡さなければ形では判断しない', !withoutShape.noSpeechFound, '');

      // 短い素材でも音楽は弾く（必要量を尺に比例させたせいで通ってしまわないこと）。
      const shortTone = makeModulated(1, sr, 4);
      const shortTrack = analyzeLoudness(shortTone, 0.02);
      const shortFeatures = analyzeFeatures(shortTone, shortTrack);
      const shortPlan = planJetCut(
        shortTrack,
        { mode: 'speech' },
        shortFeatures.speechScore,
        shortFeatures.shapeChange,
      );
      check('1 秒の震える楽器でも何もしない', shortPlan.noSpeechFound, String(shortPlan.noSpeechReason));

      // 逆に、短い素材で声を弾かないこと。固定の 0.5 秒だけで見ていたときは、
      // 3 秒に切り詰めた乾いた録音で声を弾いてしまっていた。
      const shortSpeech = makeSpeechLike(3, sr, 4);
      const shortSpeechTrack = analyzeLoudness(shortSpeech, 0.02);
      const shortSpeechFeatures = analyzeFeatures(shortSpeech, shortSpeechTrack);
      const shortSpeechPlan = planJetCut(
        shortSpeechTrack,
        { mode: 'speech' },
        shortSpeechFeatures.speechScore,
        shortSpeechFeatures.shapeChange,
      );
      check(
        '3 秒の声では弾かない',
        !shortSpeechPlan.noSpeechFound,
        `形が動いた ${shortSpeechPlan.shapeSeconds.toFixed(2)} 秒`,
      );

      // --- ここから下は「できないこと」を固定しておくための検算（2026-09-12） ---
      //
      // 素材単位の形の判定は「声があるか」を見ているつもりだったが、実際に見ているのは
      // **スペクトルの変化がどれくらいの間隔で来るか**だった。
      // 下の 2 つは和音の切り替わる間隔だけが違い、ほかは 1 つも変えていない。
      // それで結論がひっくり返るので、この判定は声の有無を見ていない。
      const planChords = (everySeconds: number) => {
        const music = makeChordProgression(10, sr, everySeconds);
        const chordTrack = analyzeLoudness(music, 0.02);
        const chordFeatures = analyzeFeatures(music, chordTrack);
        return planJetCut(
          chordTrack,
          { mode: 'speech' },
          chordFeatures.speechScore,
          chordFeatures.shapeChange,
          chordFeatures.envelopeChange,
        );
      };
      // 変化の間隔が均す窓（0.15 秒）より十分に広ければ、棘は均されて消える。
      const slowChords = planChords(1.5);
      check(
        '和音がゆっくり変わる音楽は、形の判定で止まる',
        slowChords.noSpeechFound && slowChords.noSpeechReason === 'shape',
        `形が動いた ${slowChords.shapeSeconds.toFixed(2)} 秒`,
      );
      // 窓より狭い間隔で変わり続けると、均しても埋まらなくなる。
      // **声が 1 つも入っていないのに、素材単位の判定を素通りする。**
      // 0.2 秒ごとは 16 分音符（BPM 150）くらいで、刻みの速い伴奏なら現実にいくらでもある。
      const fastChords = planChords(0.2);
      check(
        '和音が均す窓より速く変わると素通りする（既知の限界）',
        !fastChords.noSpeechFound && fastChords.shapeSeconds >= 0.5,
        `形が動いた ${fastChords.shapeSeconds.toFixed(2)} 秒 / 声らしい割合 ${(fastChords.speechRatio * 100).toFixed(0)}%`,
      );
    }

    // speech モードは、声らしさの列を渡さなければ level へ落ちる。黙って落ちないこと。
    const plain = analyzeLoudness(makeTone(3, sr, [{ from: 1, to: 2 }]), 0.02);
    check('声らしさを渡さなければ level に落ちる', planJetCut(plain, { mode: 'speech' }).usedMode === 'level', '');
    const withScore = analyzeFeatures(makeModulated(3, sr, 4), plain);
    check(
      '渡せば speech モードで動く',
      planJetCut(plain, { mode: 'speech' }, withScore.speechScore).usedMode === 'speech',
      '',
    );
    // 既定は level のまま。既存の結果を勝手に変えない。
    check('既定は level のまま', planJetCut(plain).usedMode === 'level', '');
  }

  // --- ヒステリシスと「声が見つからない」 ---
  {
    // 声らしさの列を直接組み立てて、判定の道筋だけを確かめる。
    const sr = 8000;
    const sounding = analyzeLoudness(makeTone(4, sr, [{ from: 0, to: 4 }]), 0.02);
    const frames = sounding.db.length;
    const fill = (fn: (t: number) => number) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) out[i] = fn(i * sounding.hop);
      return out;
    };

    // 1〜3 秒が声。ただし 2.00〜2.25 秒だけ声らしさがへこむ（言い淀み）。
    // 余白と「短い無音は残す」で埋まってしまわないよう、どちらも切って裸で見る。
    const dipped = fill((t) => {
      if (t < 1 || t >= 3) return 0.02;
      return t >= 2.0 && t < 2.25 ? 0.14 : 0.5;
    });
    // 遡り（`speechLeadIn`）は切っておく。ここで見たいのはヒステリシスだけで、
    // 遡りが入っていると「頭が戻ったから繋がった」のか「出る値で繋がった」のかが分からない。
    const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0, speechLeadIn: 0 };
    const single = planJetCut(sounding, { ...bare, speechExit: 0.2 }, dipped);
    const hyst = planJetCut(sounding, { ...bare, speechExit: 0.1 }, dipped);
    check('一瞬のへこみは、入る値だけだと切れ目になる', single.keep.length === 2, `${single.keep.length} 本`);
    check('ヒステリシスなら切れ目にならない', hyst.keep.length === 1, `${hyst.keep.length} 本`);
    check(
      'それでも声の外までは広がらない',
      hyst.keep[0].start > 0.9 && hyst.keep[0].end < 3.1,
      `${hyst.keep[0].start.toFixed(2)}〜${hyst.keep[0].end.toFixed(2)}`,
    );

    // 声らしさがどこにも無ければ、削らずに何もしない。
    const none = planJetCut(sounding, { mode: 'speech' }, fill(() => 0.01));
    check('声が見つからなければ何もしない', none.noSpeechFound && none.removed === 0, `削った ${none.removed.toFixed(2)} 秒`);
    check('そのとき全部残っている', near(none.resultDuration, none.originalDuration, 1e-6), '');

    // 割合は結果に出る（呼ぶ側が「声の少ない素材では」と判断できるように）。
    const half = planJetCut(sounding, { mode: 'speech' }, fill((t) => (t < 2 ? 0.5 : 0.01)));
    check('声らしいコマの割合が返る', near(half.speechRatio, 0.5, 0.05), half.speechRatio.toFixed(3));
    check('level のときは割合を 1 とする', planJetCut(sounding).speechRatio === 1, '');

    // --- 素材単位の判定に、どれだけ余裕があるか（2026-09-14・2 回目に測って分かったこと）---
    //
    // 「素材単位の判定は 13 秒のうち 5% 残ればよいので、2〜3 割取りこぼしても結論は変わらない」
    // という前の回の読みは、**声がたっぷり入っている素材でしか成り立たない**。
    // 割合の分母は鳴っているコマ全部なので、余裕は
    //   （声が尺に占める割合）×（その声を取りこぼさずに数えられた割合）
    // であり、**声が薄い素材では前の項が先に効いてくる。**
    //
    // 同じ取りこぼし率（声のコマの 8 割を落とす）で、声の量だけを変えて結論を見る。
    // 声の区間のうち 5 コマに 1 コマだけ声らしさを残し、残り 4 コマは落とす。
    const thinned = (voiceUntil: number) =>
      fill((t) => (t < voiceUntil && Math.round(t / sounding.hop) % 5 === 0 ? 0.5 : 0.02));
    // 声が尺の 8 割（0〜3.2 秒）。8 割取りこぼしても 16% 残るので、結論は動かない。
    const thick = planJetCut(sounding, { mode: 'speech' }, thinned(3.2));
    check(
      '声がたっぷりあれば、8 割取りこぼしても「声あり」のまま',
      !thick.noSpeechFound && thick.speechRatio > DEFAULT_JET_CUT.minSpeechRatio,
      `割合 ${(thick.speechRatio * 100).toFixed(0)}%`,
    );
    // 声が尺の 2 割（0〜0.8 秒）。取りこぼし率は同じなのに 4% しか残らず、線を割る。
    const thin = planJetCut(sounding, { mode: 'speech' }, thinned(0.8));
    check(
      '声が薄いと、同じ取りこぼし率で「声が見つからない」に落ちる（既知の限界）',
      thin.noSpeechFound && thin.noSpeechReason === 'ratio',
      `割合 ${(thin.speechRatio * 100).toFixed(0)}%`,
    );
    check(
      '素材単位の余裕は、声がどれだけ入っているかに比例する',
      near(thick.speechRatio / Math.max(1e-6, thin.speechRatio), 4, 0.5),
      `${(thick.speechRatio * 100).toFixed(0)}% 対 ${(thin.speechRatio * 100).toFixed(0)}%`,
    );
  }

  // --- 発話の頭を遡って拾う（`speechLeadIn`）---
  //
  // 2026-09-15 に足した。取りこぼしが**全部発話の頭**に出ていたのを直すためのもの。
  // ここで確かめるのは「どこまで戻るか」の境目だけ。効きの数字は bench の仕事。
  {
    const sr = 8000;
    // 0〜2 秒と 2.5〜4 秒が鳴っている（あいだの 0.5 秒は無音）。
    const track = analyzeLoudness(makeTone(4, sr, [{ from: 0, to: 2 }, { from: 2.5, to: 4 }]), 0.02);
    const frames = track.db.length;
    const fill = (fn: (t: number) => number) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) out[i] = fn(i * track.hop);
      return out;
    };
    const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0, minKeep: 0, minSpeechRatio: 0 };

    // 1.0 秒から声だと分かる。その手前 1.0 秒ぶんは鳴っているのに判定が届いていない。
    const late = fill((t) => (t >= 1.0 && t < 2.0 ? 0.5 : 0.02));
    const off = planJetCut(track, { ...bare, speechLeadIn: 0 }, late);
    const on = planJetCut(track, { ...bare, speechLeadIn: 0.32 }, late);
    check('遡らなければ、声だと分かったコマからしか残らない', near(off.keep[0].start, 1.0, 0.03), off.keep[0].start.toFixed(2));
    check(
      '遡ると、鳴っていたのに判定が届いていなかった頭が戻る',
      near(on.keep[0].start, 0.68, 0.03),
      on.keep[0].start.toFixed(2),
    );
    check('遡り幅より先へは行かない', on.keep[0].start >= 1.0 - 0.32 - 1e-6, on.keep[0].start.toFixed(2));
    check('尻は動かさない（そちらは保持とヒステリシスの持ち場）', near(on.keep[0].end, off.keep[0].end, 1e-6), '');

    // 無音の直後に声が始まる場合。遡っても無音は越えない。
    const afterSilence = fill((t) => (t >= 2.6 ? 0.5 : 0.02));
    const crossed = planJetCut(track, { ...bare, speechLeadIn: 1.0 }, afterSilence);
    check(
      '遡りは無音をまたがない',
      crossed.keep[0].start >= 2.5 - 1e-6,
      crossed.keep[0].start.toFixed(2),
    );

    // 遡って拾ったコマを「声らしいコマ」に数えてはいけない。
    // 数えると、素材に声があるかの判断が**判定していないコマ**で水増しされる。
    const ratioOff = planJetCut(track, { ...bare, speechLeadIn: 0 }, late).speechRatio;
    const ratioOn = planJetCut(track, { ...bare, speechLeadIn: 0.32 }, late).speechRatio;
    check('遡って拾ったコマは、声らしいコマの割合に数えない', near(ratioOn, ratioOff, 1e-6), `${ratioOn.toFixed(3)} 対 ${ratioOff.toFixed(3)}`);

    // 声が薄い素材で「声が見つからない」に落ちる境目も、遡りで動いてはいけない。
    const sparse = fill((t) => (t >= 1.0 && t < 1.1 ? 0.5 : 0.02));
    const guardOff = planJetCut(track, { mode: 'speech', speechLeadIn: 0 }, sparse);
    const guardOn = planJetCut(track, { mode: 'speech', speechLeadIn: 0.32 }, sparse);
    check(
      '「声が見つからない」の判断も遡りで動かない',
      guardOff.noSpeechFound === guardOn.noSpeechFound && guardOff.noSpeechReason === guardOn.noSpeechReason,
      `${String(guardOff.noSpeechReason)} 対 ${String(guardOn.noSpeechReason)}`,
    );

    // level モードには遡る理由が無い（鳴っているコマはもともと全部残る）。
    const lvlOff = planJetCut(track, { mode: 'level', speechLeadIn: 0 });
    const lvlOn = planJetCut(track, { mode: 'level', speechLeadIn: 0.5 });
    check('level モードは遡りに影響されない', near(lvlOn.resultDuration, lvlOff.resultDuration, 1e-6), '');

    // 声が切れ切れに立つ場合、遡りが前の残し区間へ食い込んで二重に数えないこと。
    // （食い込んでも mergeRanges が畳むので結果は同じに見える。ここで見るのは境目のほう。）
    const broken = fill((t) => (Math.round(t / track.hop) % 10 === 0 && t < 2 ? 0.5 : 0.02));
    const many = planJetCut(track, { ...bare, speechLeadIn: 0.32 }, broken);
    check(
      '遡りが重なっても、残す区間は増えない',
      many.keep.length === 1 && many.keep[0].start >= 0 && many.keep[0].end <= 2.02,
      `${many.keep.length} 本 / ${many.keep[0].start.toFixed(2)}〜${many.keep[0].end.toFixed(2)}`,
    );

    // 素材の頭で声が始まる場合。遡り先が無いので、負の秒へ出ない。
    const fromStart = fill((t) => (t < 1.5 ? 0.5 : 0.02));
    const edge = planJetCut(track, { ...bare, speechLeadIn: 0.32 }, fromStart);
    check('素材の頭より前へは出ない', edge.keep[0].start >= 0, edge.keep[0].start.toFixed(2));
  }

  // --- 包絡の門と保持 ---
  //
  // 声らしさの列と包絡の列を直接組み立てて、門の道筋だけを裸で確かめる。
  // 実際の音から作ると「包絡が動いたのか声らしさが動いたのか」が混ざって、
  // 門が効いているのかどうかが分からなくなる。
  {
    const sr = 8000;
    const sounding = analyzeLoudness(makeTone(4, sr, [{ from: 0, to: 4 }]), 0.02);
    const frames = sounding.db.length;
    const fill = (fn: (t: number) => number) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) out[i] = fn(i * sounding.hop);
      return out;
    };
    // 全編が声らしく見えている状態。ここから包絡の列だけを差し替えて効きを見る。
    const loudScore = fill(() => 0.5);
    const movingShape = fill(() => 0.2);
    // ここも遡りは切る（見たいのは包絡の門と保持だけ。遡りは頭を前へ広げるので混ざる）。
    const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0, minKeep: 0, speechLeadIn: 0 };
    // 門だけを見たいので、「声が少なすぎたら何もしない」は外しておく。
    // 外さないと、門がうまく閉まったときほど割合が下がって `noSpeechFound` に化け、
    // 結果が「全部残す」になって門の効きが見えなくなる（実際そうなって気づいた）。
    const onlyGate = { ...bare, minSpeechRatio: 0 };

    // 声らしくは見えるが音色がどこでも動かない = 鳴りっぱなしの音楽。門で落ちる。
    const stuck = planJetCut(sounding, bare, loudScore, movingShape, fill(() => 0.0));
    check('音色が動かなければ、声らしく見えても声とみなさない', stuck.noSpeechFound, `削った ${stuck.removed.toFixed(2)} 秒`);
    check('その理由は「声だと判断できたコマがほぼ無い」', stuck.noSpeechReason === 'ratio', String(stuck.noSpeechReason));

    // 1.0 秒で 1 回だけ音色が動く。保持 0.5 秒なら 1.0〜1.5 秒だけが通る。
    const oneMove = fill((t) => (t >= 1.0 && t < 1.02 ? 0.3 : 0.0));
    const held = planJetCut(sounding, { ...onlyGate, envelopeHold: 0.5 }, loudScore, movingShape, oneMove);
    check(
      'いったん開いたら保持のあいだは通る',
      held.keep.length === 1 && near(held.keep[0].start, 1.0, 0.05) && near(held.keep[0].end, 1.52, 0.05),
      held.keep.map((r) => `${r.start.toFixed(2)}〜${r.end.toFixed(2)}`).join(' '),
    );
    // 保持を 0 にすれば、動いたそのコマだけになる。保持が効いていることの裏取り。
    const noHold = planJetCut(sounding, { ...onlyGate, envelopeHold: 0 }, loudScore, movingShape, oneMove);
    check('保持を 0 にすると、動いたコマだけになる', noHold.resultDuration < 0.1, `${noHold.resultDuration.toFixed(2)} 秒`);

    // 保持は無音をまたがない。前の発話の余韻で、そのあとに来た音楽を通してしまわないため。
    const gap = analyzeLoudness(
      makeTone(4, sr, [
        { from: 0, to: 1.5 },
        { from: 2.5, to: 4 },
      ]),
      0.02,
    );
    const gapFill = (fn: (t: number) => number) => {
      const out = new Float32Array(gap.db.length);
      for (let i = 0; i < gap.db.length; i += 1) out[i] = fn(i * gap.hop);
      return out;
    };
    // 1.4 秒（無音の直前）で動く。保持 2 秒でも、無音の向こうには届かないはず。
    const beforeGap = planJetCut(
      { ...gap },
      { ...onlyGate, envelopeHold: 2 },
      gapFill(() => 0.5),
      gapFill(() => 0.2),
      gapFill((t) => (t >= 1.4 && t < 1.42 ? 0.3 : 0.0)),
    );
    check(
      '保持は無音をまたがない',
      beforeGap.keep.every((r) => r.end <= 1.6),
      beforeGap.keep.map((r) => `${r.start.toFixed(2)}〜${r.end.toFixed(2)}`).join(' ') || '（無し）',
    );

    // 渡されないものを「動いていない」と読まない。読むと、列を渡し忘れただけで
    // 声が 1 コマも残らなくなる（shapeChange と同じ約束）。
    const noColumn = planJetCut(sounding, bare, loudScore, movingShape);
    check('包絡の列を渡さなければ門は置かない', !noColumn.noSpeechFound && noColumn.resultDuration > 3.5, `${noColumn.resultDuration.toFixed(2)} 秒`);
    const open = planJetCut(sounding, { ...bare, minEnvelopeChange: 0 }, loudScore, movingShape, fill(() => 0));
    check('門を 0 にすれば開けっぱなしにできる', !open.noSpeechFound && open.resultDuration > 3.5, `${open.resultDuration.toFixed(2)} 秒`);

    // 門が開いていた秒数が返る（保持が音楽を引き伸ばしていないかを外から見るため）。
    check('門が開いていた秒数が返る', near(held.envelopeSeconds, 0.52, 0.05), `${held.envelopeSeconds.toFixed(2)} 秒`);

    // **これは「直すべき欠陥」ではなく「分かっている限界」を留める確認。**
    // 保持より短い間隔で音色が動き続けると、門は一度も閉まらない。
    // 実際 `music-chords-fast.wav`（和音が 0.4 秒ごとに変わる音楽・声なし）がこれで通り抜ける。
    // ここが落ちるようになったら、門か保持の設計が変わったということなので、記録を読み直すこと。
    const chained = planJetCut(
      sounding,
      { ...onlyGate, envelopeHold: 0.5 },
      loudScore,
      movingShape,
      fill((t) => (t % 0.3 < 0.02 ? 0.3 : 0.0)),
    );
    check(
      '保持より短い間隔で音色が動き続けると、門は閉まらない（既知の限界）',
      chained.resultDuration > 3.5,
      `${chained.resultDuration.toFixed(2)} 秒`,
    );

    // --- 「動きが続いたか」を数える工程（2026-09-14） ---
    //
    // 上の「既知の限界」の実害を、素材単位の判定の側で塞ぐためのもの。
    // 一瞬の動きが繰り返し来ても、**1 回ずつは続いていない**ことを見る。
    {
      const always = () => true;
      const spikes = new Float32Array(50);
      // 0.3 秒ごと（15 コマごと）に 1 コマだけ跳ねる。上の chained と同じ形。
      for (let i = 0; i < spikes.length; i += 15) spikes[i] = 0.3;
      const strict = envelopeGateFrames(spikes, always, 0.09, 4, 25);
      check(
        '一瞬の動きが繰り返し来ても、続いていなければ開かない',
        strict.every((v) => v === 0),
        `開いた ${strict.reduce((a, b) => a + b, 0)} コマ`,
      );
      // 同じ列でも、続きを 1 コマしか要求しなければ保持で繋がって開けっぱなしになる
      // （＝ 2026-09-14 以前の振る舞い）。塞いだのが「続き」の条件だと分かるように並べて留める。
      const loose = envelopeGateFrames(spikes, always, 0.09, 1, 25);
      check(
        '続きを求めなければ、同じ列でも保持で繋がってしまう',
        loose.reduce((a, b) => a + b, 0) > 40,
        `開いた ${loose.reduce((a, b) => a + b, 0)} コマ`,
      );

      // 続いた動きは通る。しかも**続きの頭から**開く。
      // ここが遅れると、声の語頭が毎回落ちる（測ったら取りこぼしが 3 倍になった）。
      const run = new Float32Array(50);
      for (let i = 10; i < 16; i += 1) run[i] = 0.3;
      const opened = envelopeGateFrames(run, always, 0.09, 4, 5);
      check(
        '続いた動きは、続きの頭まで遡って開く',
        opened[10] === 1 && opened[9] === 0,
        `10 コマ目 ${opened[10]} / 9 コマ目 ${opened[9]}`,
      );
      check(
        '保持のぶんだけ先まで開く',
        opened[20] === 1 && opened[21] === 0,
        `20 コマ目 ${opened[20]} / 21 コマ目 ${opened[21]}`,
      );

      // 無音をまたいで数えない。またぐと、別々の一瞬の動きが「続いた」ことになってしまう。
      const split = new Float32Array(50);
      for (let i = 8; i < 11; i += 1) split[i] = 0.3;
      for (let i = 12; i < 15; i += 1) split[i] = 0.3;
      const gapped = envelopeGateFrames(split, (i) => i !== 11, 0.09, 4, 0);
      check(
        '無音を挟んだら、続きは数え直す',
        gapped.every((v) => v === 0),
        `開いた ${gapped.reduce((a, b) => a + b, 0)} コマ`,
      );
      // 保持も無音をまたがない。またぐと、前の声の余韻でそのあとの音楽まで通してしまう。
      const beforeSilence = new Float32Array(50);
      for (let i = 5; i < 11; i += 1) beforeSilence[i] = 0.3;
      const stopped = envelopeGateFrames(beforeSilence, (i) => i < 14, 0.09, 4, 20);
      check(
        '保持も無音をまたがない',
        stopped[13] === 1 && stopped.slice(14).every((v) => v === 0),
        `13 コマ目 ${stopped[13]} / 14 コマ目以降 ${stopped.slice(14).reduce((a, b) => a + b, 0)} コマ`,
      );
      // 動き続ける素材でも、遡りは続きが条件を満たした 1 回だけ。
      // 毎コマ頭まで戻る書き方だと尺の 2 乗になり、長尺で刺さる。
      const moving = new Float32Array(20000).fill(0.3);
      const started = performance.now();
      const allOpen = envelopeGateFrames(moving, always, 0.09, 4, 25);
      check(
        '動き続けても、尺に比例した手間で済む',
        performance.now() - started < 200 && allOpen[19999] === 1,
        `${(performance.now() - started).toFixed(0)}ms`,
      );

      // 素材単位の判定にだけ効かせていること。コマ単位の門は動かさない約束なので、
      // ここが落ちたら「声を切らない」という前提が崩れている。
      const spikeColumn = fill((t) => (t % 0.3 < 0.02 ? 0.3 : 0.0));
      const framesKept = (minEnvelopeRun: number) =>
        planJetCut(
          sounding,
          { ...onlyGate, envelopeHold: 0.5, minEnvelopeRun },
          loudScore,
          movingShape,
          spikeColumn,
          spikeColumn,
        ).resultDuration;
      check(
        '続きの条件は、コマ単位の門の切り口を変えない',
        near(framesKept(0.08), framesKept(0), 0.01),
        `${framesKept(0).toFixed(2)} 秒 → ${framesKept(0.08).toFixed(2)} 秒`,
      );
      // そのうえで、素材単位の判定（割合）は落ちる。これが塞いだ穴そのもの。
      const withRun = planJetCut(
        sounding,
        { ...bare, envelopeHold: 0.5, minEnvelopeRun: 0.08 },
        loudScore,
        movingShape,
        spikeColumn,
        spikeColumn,
      );
      check(
        '一瞬の動きしか無い素材は「声が見つからない」で止まる',
        withRun.noSpeechFound && withRun.noSpeechReason === 'ratio',
        `割合 ${(withRun.speechRatio * 100).toFixed(0)}%`,
      );
      // 渡されないものを「続かなかった」と読まない（列を渡し忘れただけで止まらないこと）。
      const noFlux = planJetCut(sounding, { ...bare, envelopeHold: 0.5, minEnvelopeRun: 0.08 }, loudScore, movingShape, spikeColumn);
      check(
        '生の列を渡さなければ、続きは見ない',
        !noFlux.noSpeechFound,
        `割合 ${(noFlux.speechRatio * 100).toFixed(0)}%`,
      );
    }

    // --- 揺れを低い帯域だけで見る（2026-09-16） ---
    // 声の基本周波数も第 1・第 2 フォルマントも 2kHz より下に居るので、
    // 音節の揺れを見るのに高い側は要らない。逆に、上で刻む打楽器はそこにしか居ない。
    //
    // **ここで固定したいのは「効くこと」と「どこで破れるか」の両方。**
    // 効くほうだけを固定すると、次の回が「声を見分けられるようになった」と読む。
    // 見分けているのではなく、**邪魔なものが声の帯域の外に居るときだけ**外せている。
    {
      // 境目（2000Hz）の上にも下にも余裕を置きたいので、ここだけ標本化周波数を上げる。
      const sr = 32000;
      const hop = 0.02;
      // 440Hz の鳴りっぱなしの音（＝揺れの無い伴奏のつもり）。境目より下に居る。
      const chord = makeTone(2, sr, [{ from: 0, to: 2 }]);
      const middle = (a: Float32Array) => a[Math.floor(a.length / 2)];
      // **既定は全域**なので、ここでは境目を明示して渡す。
      // 既定値を書き換えただけでこの検算が黙って別のものを測り始める、という形にしない。
      const featuresOf = (buffer: AudioLike, split: number = MOD_SPLIT_HZ) =>
        analyzeFeatures(buffer, analyzeLoudness(buffer, hop), { modSplitHz: split });

      const plain = featuresOf(chord);
      // ① 境目の**上**で音節の速さに揺れるものは、全域の揺れを持ち上げる。
      //    これが `speech-sparse-hats` の切れ目 5.60 秒を渡らせていたものそのもの。
      const above = featuresOf(addWobbling(chord, 6000, 4.2, 0.35));
      check(
        '境目の上で揺れるものは、全域の揺れを持ち上げる',
        middle(above.modulation) > middle(plain.modulation) + 0.2,
        `上で揺れる ${middle(above.modulation).toFixed(3)} / 和音だけ ${middle(plain.modulation).toFixed(3)}`,
      );
      check(
        '同じものでも、低い側だけの揺れは動かない',
        near(middle(above.lowModulation), middle(plain.lowModulation), 0.05),
        `上で揺れる ${middle(above.lowModulation).toFixed(3)} / 和音だけ ${middle(plain.lowModulation).toFixed(3)}`,
      );

      // ② **同じ揺れを境目の下へ置けば、この手は丸ごと外れる。**
      //    `speech-sparse-thump.wav` が素材の側で示していることを、合成波形で固定する。
      const below = featuresOf(addWobbling(chord, 900, 4.2, 0.35));
      check(
        '同じ揺れを境目の下へ置くと、低い側の揺れも上がる（この手の破れ方）',
        middle(below.lowModulation) > middle(plain.lowModulation) + 0.2,
        `下で揺れる ${middle(below.lowModulation).toFixed(3)} / 和音だけ ${middle(plain.lowModulation).toFixed(3)}`,
      );

      // ③ 声らしさは低い側の揺れから組む。だから境目の上の揺れでは上がらない。
      check(
        '声らしさは、境目の上の揺れでは上がらない',
        near(middle(above.speechScore), middle(plain.speechScore), 0.08),
        `上で揺れる ${middle(above.speechScore).toFixed(3)} / 和音だけ ${middle(plain.speechScore).toFixed(3)}`,
      );

      // ④ 境目を 0 にすれば、入れる前の振る舞いに戻せる（A/B を並べるための約束）。
      //    ここが崩れると `LAB_LOWBAND` を外したときに「いまの数字」が出なくなる。
      const whole = featuresOf(addWobbling(chord, 6000, 4.2, 0.35), 0);
      let same = whole.lowModulation.length === whole.modulation.length;
      for (let i = 0; i < whole.modulation.length && same; i += 1) {
        if (whole.lowModulation[i] !== whole.modulation[i]) same = false;
      }
      check('境目 0 なら、低い側の揺れは全域の揺れと同じ列になる', same, `${whole.modulation.length} コマ`);

      // ⑤ 低い側の音量は**取り分として**出している（FFT の目盛りをそのまま使わない）。
      //    全部が境目より下に居るなら、低い側の音量は元の音量とほぼ同じになるはず。
      check(
        '全部が境目より下なら、低い側の音量は元の音量に揃う',
        near(middle(plain.lowLevel), middle(plain.level), 1),
        `低い側 ${middle(plain.lowLevel).toFixed(1)}dB / 全域 ${middle(plain.level).toFixed(1)}dB`,
      );

      // ⑥ 逆に、境目の上にしか音が無ければ低い側は沈む。
      //    ここが沈まないと、`modulationRatio` の無音の底を一度も踏まなくなる。
      const highOnly = featuresOf(addWobbling(makeTone(2, sr, []), 6000, 4.2, 0.35));
      check(
        '境目の上にしか音が無ければ、低い側の音量は沈む',
        middle(highOnly.lowLevel) < middle(highOnly.level) - 20,
        `低い側 ${middle(highOnly.lowLevel).toFixed(1)}dB / 全域 ${middle(highOnly.level).toFixed(1)}dB`,
      );

      // ⑦ 無音のコマで NaN や -Infinity に化けないこと。
      const quiet = featuresOf(makeTone(2, sr, []));
      check(
        '無音でも低い側の音量は底で止まる（NaN にしない）',
        Number.isFinite(middle(quiet.lowLevel)) && middle(quiet.lowLevel) <= -100 + 1e-6,
        `${middle(quiet.lowLevel).toFixed(1)}dB`,
      );
    }

    // --- 揺れを「割合」ではなく「深さ（dB）」で見る（2026-09-16・2 回目） ---
    //
    // `modulationRatio` は取り分なので、揺れの総量がいくら小さくても 1 に近づく。
    // `music-hats` の低い側が 13 秒で 0.32dB しか動いていないのに割合 37% を出し、
    // 声のある素材（28%）を追い越していたのはこれ。**見ていた量に大きさが入っていなかった。**
    //
    // 検算は音量の列を直に組んで当てる。素材から作ると、深さが何 dB になるべきかを
    // こちらが言えないので「出た値を正しいことにする」形になってしまう。
    {
      const hop = 0.02;
      const frames = 256;
      // 音量の列を式から作る。-20dB を中心に、指定の速さ・指定の深さ（片振幅 dB）で揺らす。
      const levelTrack = (amplitudeDb: number, hz: number): LoudnessTrack => {
        const db = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) db[i] = -20 + amplitudeDb * Math.sin(2 * Math.PI * hz * i * hop);
        return { hop, db, duration: frames * hop };
      };
      const middle = (a: Float32Array) => a[Math.floor(a.length / 2)];

      // ① 目盛りが合っていること。片振幅 6dB の正弦なら実効値は 6/√2 ≒ 4.24dB。
      //    ここがずれていると、下で決めた線（0.8dB）が別の量の線になる。
      const six = middle(modulationDepthDb(levelTrack(6, 4.5)));
      check('深さは実効値（片振幅 6dB なら 4.24dB）', near(six, 6 / Math.SQRT2, 0.3), `${six.toFixed(2)}dB`);

      // ② **割合と深さが別のものを見ていることを、同じ列で示す。** これが今回の全部。
      //    浅い揺れでも割合はほぼ満点、深さは浅いまま。
      const shallow = levelTrack(0.3, 4.5);
      const shallowRatio = middle(modulationRatio(shallow));
      const shallowDepth = middle(modulationDepthDb(shallow));
      check(
        '浅い揺れでも割合は満点に近い（これが music-hats を通していたもの）',
        shallowRatio > 0.9,
        `割合 ${shallowRatio.toFixed(3)}`,
      );
      check(
        '同じ列でも、深さは浅いままになる',
        shallowDepth < 0.35,
        `深さ ${shallowDepth.toFixed(2)}dB / 割合 ${shallowRatio.toFixed(3)}`,
      );

      // ③ 音量倍率に不変。dB の列では掛け算が足し算になり、平均を引く工程で消える。
      //    ここが崩れると、線が「素材の録音レベル」で動く。
      const louder = levelTrack(6, 4.5);
      for (let i = 0; i < frames; i += 1) louder.db[i] += 12;
      check(
        '素材の音量を変えても深さは動かない',
        near(middle(modulationDepthDb(louder)), six, 0.02),
        `${middle(modulationDepthDb(louder)).toFixed(2)}dB / ${six.toFixed(2)}dB`,
      );

      // ④ 音節帯（3〜6Hz）の外の揺れは拾わない。拾うと「速い刻み」を音節と読む。
      const fast = middle(modulationDepthDb(levelTrack(6, 12)));
      check('音節帯の外で揺れても深さは上がらない', fast < 0.6, `12Hz で ${fast.toFixed(2)}dB`);

      // ⑤ まったく動かない列は 0。`music-hats` の低い側がこれ。
      const flat = middle(modulationDepthDb(levelTrack(0, 4.5)));
      check('動かない列の深さは 0', flat < 0.01, `${flat.toFixed(4)}dB`);

      // ⑥ **一定の底を足すと、同じ揺れでも深さは縮む**（2026-09-18）。
      //
      //    ③ が言っているのは「**全体**を何倍しても動かない」で、
      //    **底だけを持ち上げると動く。** 深さは dB の列の揺れ幅なので、
      //    線形に直せば「窓の中の最大と最小の比」でしかない。
      //    下に一定の伴奏が敷かれるほど比は 1 に近づき、値は縮む。
      //
      //    ここが**素材単位の判定の線が素材ごとに動く理由**で、
      //    実際 `speech-bgm-loud`（1.59dB）はうねりを止めるだけで 1.09dB、
      //    伴奏を声より大きくすると 0.69dB まで落ちる。
      //    列は線形の包絡から組む（dB の列に定数を足しても「底を敷いた」ことにはならない）。
      const depthUnderFloor = (floor: number) => {
        const db = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) {
          // 音節の速さで 0.1〜0.9 に揺れる「声」に、一定の「伴奏」を足してから dB にする。
          const voice = 0.5 + 0.4 * Math.sin(2 * Math.PI * 4.5 * i * hop);
          db[i] = 20 * Math.log10(voice + floor);
        }
        return middle(modulationDepthDb({ hop, db, duration: frames * hop }));
      };
      const bare = depthUnderFloor(0);
      const onFloor = depthUnderFloor(1);
      check(
        '一定の底を足すと、同じ揺れでも深さは縮む（深さも比である）',
        onFloor < bare / 3,
        `底なし ${bare.toFixed(2)}dB → 底あり ${onFloor.toFixed(2)}dB`,
      );

      // ⑥' **縮ませているのは「比」ではなく対数だった**（2026-09-18・2 回目）。
      //
      //    ⑥ を「深さも比だから縮む」と読んでいたが、原因はもう一段手前にある。
      //    無相関の音を混ぜると**エネルギーの列には定数が足されるだけ**で、
      //    定数は窓の平均を引く工程で消える。**3〜6Hz の帯域には 1 ビットも残らない。**
      //    縮むのは、その列を dB へ直してから引き算しているからでしかない。
      //
      //    ここでは ⑥ と違って**エネルギーの列に直に定数を足す**（⑥ は線形の包絡に足していた）。
      //    包絡に足すと「声と伴奏が同じ位相で重なった」ことになり、混ぜたことにならない。
      //    無相関なら足し合わさるのはエネルギーのほうなので、こちらが実際の混ざり方に近い。
      const underEnergyFloor = (floor: number) => {
        const db = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) {
          const voice = 0.5 + 0.4 * Math.sin(2 * Math.PI * 4.5 * i * hop);
          db[i] = 10 * Math.log10(voice * voice + floor);
        }
        const t = { hop, db, duration: frames * hop };
        return { db: middle(modulationDepthDb(t)), energy: middle(energyModulationDepthDb(t)) };
      };
      const noFloor = underEnergyFloor(0);
      const withFloor = underEnergyFloor(4);
      check(
        'エネルギーの列に定数を足しても、エネルギーで測った深さは動かない',
        near(withFloor.energy, noFloor.energy, 0.01),
        `${noFloor.energy.toFixed(3)}dB → ${withFloor.energy.toFixed(3)}dB`,
      );
      check(
        '同じ定数でも、dB へ直してから測ると深さは潰れる（犯人は対数）',
        withFloor.db < noFloor.db / 3,
        `${noFloor.db.toFixed(2)}dB → ${withFloor.db.toFixed(2)}dB`,
      );

      // ⑥'' **対数を外すと、倍率への不変性がそのまま外れる。**
      //     ③ の「素材の音量を変えても動かない」がこちらでは成り立たない。
      //     エネルギーなので 2 倍で 6dB ちょうど上がる。**この量を素材単位の線に使えない理由**が
      //     ここで、素材 26 本が重なりなく割れていても隙間は 0.25dB しかない
      //     （＝ 1 本を 0.5dB 下げれば声のある素材が音楽の側へ落ちる）。
      //     3 つのうち 2 つしか取れない、というのが 2026-09-18・2 回目の結論。
      {
        const base = levelTrack(6, 4.5);
        const twice = { ...base, db: Float32Array.from(base.db, (v) => v + 6) };
        const a = middle(energyModulationDepthDb(base));
        const b = middle(energyModulationDepthDb(twice));
        check(
          'エネルギーで測ると、素材を 2 倍しただけで 6dB 動く（倍率に不変ではない）',
          near(b - a, 6, 0.1),
          `${a.toFixed(2)}dB → ${b.toFixed(2)}dB（差 ${(b - a).toFixed(2)}dB）`,
        );
      }

      // ⑦ 線の置き場所を、測った 2 つの数字で挟んで固定しておく。
      //    止めたい側の最大は `music-chords-faster` の 0.361dB（声ゼロ）、
      //    守ると決めた下限は `speech-flat-bgm-loud` の 0.688dB（声あり）。
      //    **群が分かれていない量なので、線は宣言でしかない。**
      //    ここを外れたら、それは素材が増えたのではなく線がずれたということ。
      check(
        '深さの線は、測った 0.361dB と 0.688dB の間にある',
        DEFAULT_JET_CUT.minModulationDepth > 0.361 && DEFAULT_JET_CUT.minModulationDepth < 0.688,
        `${DEFAULT_JET_CUT.minModulationDepth}dB`,
      );

      // ⑧ **対数は、もう一方向にも効いている**（2026-09-18・3 回目）。
      //
      //    ⑥' で見たのは「対数が**声の証拠を縮める**」ほう。逆向きがもう 1 つある。
      //    dB は比なので、**小さな打点の「10 倍」と、声の「10 倍」を同じ 10dB として数える。**
      //    打点は合間に底へ落ちるので、**小さい打点ほど dB の列では深く揺れて見える。**
      //
      //    ここでは「大きく鳴りながら音節の速さで 0.5〜1.0 に揺れる声」と、
      //    「うんと小さく、同じ速さで 0.01〜0.1 に落ち込む打点」を並べる。
      //    **動いた絶対量は声のほうが 5 倍以上大きい**のに、dB の列では打点のほうが深い。
      //    実測でも `speech-drums` は 声 5.52 に対して打点 6.14 で、既定の量の AUC は
      //    0.430（偶然以下）になる。エネルギーの列で測ると 0.952 まで戻る。
      const swingTrack = (high: number, low: number) => {
        const db = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) {
          // 0〜1 の三角波ではなく正弦で作る（⑥ と同じ形にして、違いを列の取り方だけに絞る）。
          const shape = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.5 * i * hop);
          const amp = low + (high - low) * shape;
          db[i] = 20 * Math.log10(amp);
        }
        return { hop, db, duration: frames * hop };
      };
      {
        const voice = swingTrack(1.0, 0.5);
        const thump = swingTrack(0.1, 0.01);
        const voiceDb = middle(modulationDepthDb(voice));
        const thumpDb = middle(modulationDepthDb(thump));
        const voiceEnergy = middle(energyModulationDepthDb(voice));
        const thumpEnergy = middle(energyModulationDepthDb(thump));
        check(
          'dB の列では、小さな打点のほうが大きな声より深く揺れて見える',
          thumpDb > voiceDb,
          `声 ${voiceDb.toFixed(2)}dB / 打点 ${thumpDb.toFixed(2)}dB`,
        );
        check(
          'エネルギーの列で測ると向きが戻る（動いた絶対量の順になる）',
          voiceEnergy > thumpEnergy,
          `声 ${voiceEnergy.toFixed(2)}dB / 打点 ${thumpEnergy.toFixed(2)}dB`,
        );
      }

      // ⑨ **基準を「その素材の深さの最大」に取ると、倍率にも底にも不変になる**
      //    （2026-09-18・3 回目）。⑥'' の「倍率に不変でない」を外せる唯一の形で、
      //    しかも 2 段階の基準と違って**声の無い素材でも作れる**。
      //
      //    **それでも入れていない。** 声の無い素材では最大そのものが背景なので、
      //    全コマが「最大の近く」に来て素材単位の判定には使えない。
      //    コマ単位でも、打点を大きくすると `lowBandReadable` が読めるコマを返さなくなり、
      //    門が自分から消える（`speech-sparse-thump-loud.wav` で 12.38s → 0.04s）。
      //    ここで固定しているのは**性質だけ**で、使ってよいという意味ではない。
      {
        const base = levelTrack(6, 4.5);
        const relative = (track: LoudnessTrack) => {
          const e = energyModulationDepthDb(track);
          let max = -Infinity;
          // 端は窓の埋め方で値が甘くなるので、ほかの検算と同じく真ん中だけを見る。
          const from = Math.floor(track.db.length / 4);
          const to = track.db.length - from;
          for (let i = from; i < to; i += 1) if (e[i] > max) max = e[i];
          return middle(e) - max;
        };
        const louder = { ...base, db: Float32Array.from(base.db, (v) => v + 6) };
        check(
          '最大を基準にすると、素材を 2 倍しても値は動かない',
          near(relative(louder), relative(base), 0.01),
          `${relative(base).toFixed(3)} → ${relative(louder).toFixed(3)}`,
        );
        // 底はエネルギーの列へ足す（⑥' と同じ理由。dB の列に足しても混ぜたことにならない）。
        const withFloor = {
          ...base,
          db: Float32Array.from(base.db, (v) => 10 * Math.log10(10 ** (v / 10) + 10 ** (base.db[0] / 10))),
        };
        check(
          '最大を基準にすると、一定の底を敷いても値は動かない',
          near(relative(withFloor), relative(base), 0.01),
          `${relative(base).toFixed(3)} → ${relative(withFloor).toFixed(3)}`,
        );
      }
    }

    // --- 深さを「読んでよいコマだけ」で集計する（lowBandDepthSeconds）---
    //
    // 窓に無音の縁が入ると、そこの段差が 3〜6Hz に漏れて深さを持ち上げる。
    // 実際 `music-hats-break`（和音が 2 回休む音楽・声ゼロ）は、
    // 縁を数えると 2.77dB で声のある素材と同じ顔になり、縁を外すと 0.32dB まで落ちる。
    // **縁は曲の切れ目であって、音節ではない。**
    {
      const hop = 0.02;
      const frames = 200;
      const windowFrames = modulationWindowFrames(hop);
      const constant = (v: number) => new Float32Array(frames).fill(v);

      // ① 低い側が丸ごと鳴っていれば、端（窓が素材の外へはみ出すぶん）を除いて全部読める。
      const all = lowBandDepthSeconds(constant(-20), constant(2), hop, -40, windowFrames, 0.8);
      check(
        '低い側が鳴り続けていれば、端を除いて読める',
        near(all.judged, (frames - windowFrames + 1) * hop, 1e-6) && all.above === all.judged,
        `読めた ${all.judged.toFixed(2)}s / 超えた ${all.above.toFixed(2)}s`,
      );

      // ② 低い側が黙っているコマがあれば、その**窓ごと**読まない。1 コマ落ちれば窓 1 つぶん消える。
      const withGap = constant(-20);
      withGap[100] = -100;
      const gapped = lowBandDepthSeconds(withGap, constant(2), hop, -40, windowFrames, 0.8);
      check(
        '低い側が切れた窓は読まない（曲の切れ目を音節と読まないため）',
        near(all.judged - gapped.judged, windowFrames * hop, 1e-6),
        `${all.judged.toFixed(2)}s → ${gapped.judged.toFixed(2)}s（窓 ${(windowFrames * hop).toFixed(2)}s）`,
      );

      // ③ 低い側がどこも鳴っていなければ、読めた秒は 0。
      //    **ここを「動かなかった」と読むと、低い側に音の無い素材を全部弾く。**
      const silent = lowBandDepthSeconds(constant(-100), constant(2), hop, -40, windowFrames, 0.8);
      check('低い側が鳴っていなければ、何も読まない', silent.judged === 0 && silent.max === 0, `${silent.judged.toFixed(2)}s`);

      // ④ 1 コマでも線を超えたら、超えたことにする（疑わしきは通す側へ倒す）。
      const oneSpike = constant(0.1);
      oneSpike[100] = 5;
      const spiked = lowBandDepthSeconds(constant(-20), oneSpike, hop, -40, windowFrames, 0.8);
      check(
        '1 コマでも線を超えたら、超えたと数える',
        near(spiked.above, hop, 1e-6) && near(spiked.max, 5, 1e-6),
        `${spiked.above.toFixed(2)}s / 最大 ${spiked.max.toFixed(2)}dB`,
      );
    }

    // --- 深さを素材単位の判定に置く（planJetCut）---
    {
      const sr = 16000;
      const sounding = analyzeLoudness(makeTone(4, sr, [{ from: 0, to: 4 }]), 0.02);
      const frames = sounding.db.length;
      const constant = (v: number) => new Float32Array(frames).fill(v);
      // 割合と形は通る側に置く。ここで見たいのは深さだけ。
      const score = constant(0.5);
      const shape = constant(0.2);
      const lowLevel = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) lowLevel[i] = sounding.db[i];
      const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0, minKeep: 0, speechLeadIn: 0 };

      // ① 低い側がどこでも深く揺れなければ、「声が無い」で止まる。これが music-hats。
      const flat = planJetCut(sounding, bare, score, shape, undefined, undefined, lowLevel, constant(0.3));
      check(
        '低い側がどこでも深く揺れない素材は「声が見つからない」で止まる',
        flat.noSpeechFound && flat.noSpeechReason === 'depth',
        `理由 ${flat.noSpeechReason} / 最大 ${flat.depthMax.toFixed(2)}dB / 読めた ${flat.depthSeconds.toFixed(2)}s`,
      );

      // ② 深く揺れていれば通る。声のある素材は 1.59dB 以上ある。
      const deep = planJetCut(sounding, bare, score, shape, undefined, undefined, lowLevel, constant(1.6));
      check('深く揺れていれば通る', !deep.noSpeechFound, `最大 ${deep.depthMax.toFixed(2)}dB`);

      // ③ **渡されないものを「動かなかった」と読まない。** 列を渡し忘れただけで
      //    どの素材も止まる、という壊れ方をしないこと。
      const noColumns = planJetCut(sounding, bare, score, shape);
      check(
        '列を渡さなければ、深さでは判断しない',
        !noColumns.noSpeechFound && noColumns.depthSeconds === 0,
        `読めた ${noColumns.depthSeconds.toFixed(2)}s`,
      );

      // ④ 読めたコマが足りなければ判断しない。乾いた声は発話ごとに無音が挟まるので、
      //    読めるコマがほとんど残らない（`speech-bgm` は 0.00 秒・`speech` は 0.14 秒）。
      //    **そこを「動かなかった」と読むと、いちばん素直な声を丸ごと弾く。**
      const shortLow = new Float32Array(frames).fill(-100);
      for (let i = 40; i < 80; i += 1) shortLow[i] = sounding.db[i];
      const tooShort = planJetCut(sounding, bare, score, shape, undefined, undefined, shortLow, constant(0.3));
      check(
        '読めたコマが足りなければ、深さでは判断しない',
        !tooShort.noSpeechFound && tooShort.depthSeconds < DEFAULT_JET_CUT.minDepthSeconds,
        `読めた ${tooShort.depthSeconds.toFixed(2)}s（線は ${DEFAULT_JET_CUT.minDepthSeconds}s）`,
      );

      // ④'' hop が 0 の列を渡されても止まらないこと（窓の長さの計算が発散しない）。
      check('コマ幅が 0 でも窓の長さは決まる', modulationWindowFrames(0) === 16, `${modulationWindowFrames(0)} コマ`);

      // ④' つまみを 0 にしても、列を渡していない素材は止めない。
      //     `judged >= minDepthSeconds` は 0 同士で立ってしまうので、そこを塞いである。
      const zeroLine = planJetCut(sounding, { ...bare, minDepthSeconds: 0 }, score, shape);
      check(
        '読める秒数の線を 0 にしても、列が無ければ止めない',
        !zeroLine.noSpeechFound,
        `読めた ${zeroLine.depthSeconds.toFixed(2)}s`,
      );

      // ⑤ **この手が見ているのは「声があるか」ではない。** 低い側で音節の速さに深く刻む音楽
      //    （`music-thump.wav` = ハイハットと同じ刻みを 700Hz より下へ置いたもの・声ゼロ）は
      //    1.88dB で、声のいちばん低い 1.59dB を追い越して素通りする。
      //    **ここを固定しておかないと、次の回が「声を見分けられた」と読む。**
      const percussive = planJetCut(sounding, bare, score, shape, undefined, undefined, lowLevel, constant(1.88));
      check(
        '低い側で深く刻む音楽は、声ゼロでも素通りする（この手の破れ方）',
        !percussive.noSpeechFound,
        `1.88dB は線（${DEFAULT_JET_CUT.minModulationDepth}dB）の上`,
      );
    }

    // --- 揺れの「向き」で打点と音節を分ける（levelSkewness・2026-09-16・3 回目） ---
    //
    // 深さでも割合でも、低い側で音節の速さに刻む打点は声と同じ顔になる（上の ⑤）。
    // 残っていたのは向きで、そこは逆を向いている。打点は鳴っていない時間のほうが長く、
    // 音節は鳴っている時間のほうが長い。**同じ 4.2Hz でもデューティ比が逆。**
    //
    // ここも音量の列を直に組んで当てる。素材から作ると、歪度が幾つになるべきかを
    // こちらが言えない（「出た値を正しいことにする」形になる）。
    {
      const hop = 0.02;
      const frames = 256;
      const middle = (a: Float32Array) => a[Math.floor(a.length / 2)];
      /** 周期 `period` コマのうち `on` コマだけ `peakDb` まで上がる列。デューティ比を直に振れる。 */
      const dutyTrack = (period: number, on: number, peakDb: number): LoudnessTrack => {
        const db = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) db[i] = i % period < on ? -20 + peakDb : -20;
        return { hop, db, duration: frames * hop };
      };

      // ① 鳴っている時間のほうが短い（＝打点）と、歪度は正になる。
      //    4.2Hz の刻みは 0.02 秒コマで周期 12 コマ。減衰 0.035 秒 ≒ 2 コマぶん鳴る。
      const hit = middle(levelSkewness(dutyTrack(12, 2, 10)));
      check('鳴っている時間のほうが短い列（打点）は歪度が正', hit > 0.5, `${hit.toFixed(3)}`);

      // ② 同じ周期・同じ深さでも、鳴っている時間のほうが長ければ歪度は負になる。
      //    **周期も深さも変えずに向きだけが入れ替わる**ので、この量が見ているものに疑いが無い。
      const syllable = middle(levelSkewness(dutyTrack(12, 9, 10)));
      check('鳴っている時間のほうが長い列（音節）は歪度が負', syllable < -0.5, `${syllable.toFixed(3)}`);

      // ③ 音量倍率に不変。標準偏差で割ってあるので、深さを変えても向きは動かない。
      //    ここが崩れると、線が「素材の録音レベル」や「打点の大きさ」で動く。
      const louder = middle(levelSkewness(dutyTrack(12, 2, 20)));
      check('打点の大きさを変えても向きは動かない', near(louder, hit, 0.02), `${louder.toFixed(3)} / ${hit.toFixed(3)}`);

      // ④ まったく動かない列は 0（＝どちらでもない）。ここで無理に値を作ると、
      //    鳴りっぱなしの和音が打点の側にも音節の側にも転ぶ。
      const flat = middle(levelSkewness(dutyTrack(12, 0, 0)));
      check('動かない列の向きは 0（どちらでもない）', flat === 0, `${flat.toFixed(4)}`);

      // ⑤ **この手が見ているのは「打点か」ではなく「どちらの時間が長いか」。**
      //    きっぱり区切ってしゃべる声（`speech-clipped-bgm.wav`）は、鳴っている時間のほうが
      //    短くなるので打点と同じ側へ落ちる（実測の中央値 1.34 は打点の 0.74 より高い）。
      //    **ここを固定しておかないと、次の回が「打点を見分けられた」と読む。**
      const clipped = middle(levelSkewness(dutyTrack(12, 4, 10)));
      check('短く区切った声も打点と同じ側へ落ちる（この手の破れ方）', clipped > 0.5, `${clipped.toFixed(3)}`);
    }

    // --- 向きを「読んでよいコマだけ」で読む（lowBandReadable・maxLowSkew） ---
    {
      const hop = 0.02;
      const windowFrames = modulationWindowFrames(hop);
      const frames = 200;
      const constant = (v: number) => new Float32Array(frames).fill(v);

      // ① 深さと**同じ規則**で読む。1 コマ黙れば窓 1 つぶん読めなくなる。
      //    2 か所に同じ規則を書くと、片方だけ直したときに静かに壊れる。
      const withGap = constant(-20);
      withGap[100] = -100;
      const readable = lowBandReadable(withGap, -40, windowFrames);
      let readableFrames = 0;
      for (let i = 0; i < frames; i += 1) readableFrames += readable[i];
      const depth = lowBandDepthSeconds(withGap, constant(2), hop, -40, windowFrames, 0.8);
      check(
        '向きと深さは、同じコマを読む',
        near(readableFrames * hop, depth.judged, 1e-6),
        `読めた ${(readableFrames * hop).toFixed(2)}s`,
      );

      // ①' **読んでよいかは、全域と同じしきい値で決めている。** だから見る帯を狭めると、
      //     その帯の音量だけが下がって一度も線を超えず、読めるコマが丸ごと無くなる。
      //     2026-09-17 に、打点（700Hz 以下）を外した 700〜2000Hz の帯で深さを読もうとして
      //     全素材が 0.00s になり、そこで初めて気づいた。**狭めた帯で測るなら、
      //     しきい値も一緒に持ち直さないと「動かなかった」ではなく「測れていない」になる。**
      const narrow = constant(-50);
      const narrowReadable = lowBandReadable(narrow, -40, windowFrames);
      let narrowFrames = 0;
      for (let i = 0; i < frames; i += 1) narrowFrames += narrowReadable[i];
      check('全域のしきい値より静かな帯は、1 コマも読めない', narrowFrames === 0, `読めた ${(narrowFrames * hop).toFixed(2)}s`);

      // ①'' **そこを 2026-09-19 に持ち直した**（`lowBandLineDb`）。線を低い側の大きさから取れば、
      //      帯ごと静かでも読める。①' の素材（一定の -50dB）がそのまま材料になる。
      const ownLine = lowBandLineDb(narrow, -40, 20, hop);
      const ownReadable = lowBandReadable(narrow, ownLine, windowFrames);
      let ownFrames = 0;
      for (let i = 0; i < frames; i += 1) ownFrames += ownReadable[i];
      check(
        '低い側の大きさから線を取れば、静かな帯でも読める',
        ownFrames === frames - (windowFrames - 1),
        `読めた ${ownFrames} コマ（縁 ${windowFrames - 1} コマを除く ${frames - (windowFrames - 1)} コマ）`,
      );

      // ①''' **直した眼目はここ。全域の線は「混ざっているものを大きくすると上がる」。**
      //       低い側が -20dB で鳴っていて、合間に -30dB までへこむ列を作る。
      //       全域の線が -25dB なら、へこみが線を割って窓ごと読めなくなる（＝素材を大きくした側）。
      //       線を低い側の大きさ（-20dB）から 20dB 下に取れば -40dB なので、へこみは割らない。
      const dips = constant(-20);
      for (let i = 20; i < frames; i += 10) dips[i] = -30;
      let fullbandFrames = 0;
      const fullband = lowBandReadable(dips, -25, windowFrames);
      for (let i = 0; i < frames; i += 1) fullbandFrames += fullband[i];
      let ownDipFrames = 0;
      const ownDip = lowBandReadable(dips, lowBandLineDb(dips, -25, 20, hop), windowFrames);
      for (let i = 0; i < frames; i += 1) ownDipFrames += ownDip[i];
      check(
        '打点の合間のへこみは、全域の線だと窓ごと落ちる',
        fullbandFrames === 0,
        `全域の線で読めた ${fullbandFrames} コマ / 低い側の線で読めた ${ownDipFrames} コマ`,
      );
      check(
        '低い側の線なら、同じへこみを読み切る',
        ownDipFrames === frames - (windowFrames - 1),
        `読めた ${ownDipFrames} コマ`,
      );

      // ①'''' **線はその場の大きさに付いてくる（素材の中で音量が動いても外れない）。**
      //        前半 -20dB / 後半 -50dB の列。素材ぜんたいの分位点で取ると後半が丸ごと落ちるが、
      //        その場の大きさから取れば後半も読める（`speech-bgm-fade.wav` がこの形）。
      // ①''''' **線を低い側から取ると、無音の素材で「全部読める」に化けないか。**
      //         線は底より下（-120dB）に下がるので、線だけを見れば全コマ通る。
      //         そこを止めているのは `SILENCE_DB` の判定で、**線と別に置いてある意味がここに出る。**
      const silent = constant(-100);
      const silentReadable = lowBandReadable(silent, lowBandLineDb(silent, -40, 20, hop), windowFrames);
      let silentFrames = 0;
      for (let i = 0; i < frames; i += 1) silentFrames += silentReadable[i];
      check('無音の素材は、線を低い側から取っても 1 コマも読めない', silentFrames === 0, `読めた ${silentFrames} コマ`);

      // 基準の幅（前後 2.5 秒）よりはっきり長い列でないと、素材ぜんたいが 1 つの窓に入って
      // 「付いてくる」を確かめられない。12 秒ぶんで作る。
      const longFrames = Math.round(12 / hop);
      const fading = new Float32Array(longFrames);
      for (let i = 0; i < longFrames; i += 1) fading[i] = i < longFrames / 2 ? -20 : -50;
      const movingLine = lowBandLineDb(fading, -40, 20, hop) as Float32Array;
      check(
        '線は、その場の低い側の大きさに付いてくる',
        near(movingLine[10], -40, 1e-6) && near(movingLine[longFrames - 10], -70, 1e-6),
        `頭 ${movingLine[10].toFixed(1)}dB / 尻 ${movingLine[longFrames - 10].toFixed(1)}dB`,
      );
      // 基準は**前後 2.5 秒の最大**なので、段差のすぐ先では大きいほうが残る（窓の幅の意味）。
      // ここが「その場」の粗さで、細かくすると窓の中の谷そのものが基準を下げてしまう。
      const atStep = movingLine[Math.round(longFrames / 2) + 10];
      check(
        '段差の先でも、前後 2.5 秒に大きい側が居れば線は下がらない',
        near(atStep, -40, 1e-6),
        `段差の 0.2 秒あと ${atStep.toFixed(1)}dB`,
      );

      const sr = 16000;
      const sounding = analyzeLoudness(makeTone(4, sr, [{ from: 0, to: 4 }]), 0.02);
      const n = sounding.db.length;
      const fill = (v: number) => new Float32Array(n).fill(v);
      const lowLevel = new Float32Array(n);
      for (let i = 0; i < n; i += 1) lowLevel[i] = sounding.db[i];
      const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0, minKeep: 0, speechLeadIn: 0 };
      const gate = { ...bare, maxLowSkew: 0.4, minModulationDepth: 0 };

      // ② 向きが線を超えたコマは、声らしさが満点でも落ちる。
      //    **前半だけを打点にしてある。** 全コマを打点にすると割合が 5% を割り、
      //    下の⑥（門を外すほう）が先に立って、門が効いたことを測れなくなる。
      const halfThump = new Float32Array(n);
      for (let i = 0; i < n; i += 1) halfThump[i] = i < n / 2 ? 1.0 : -1.0;
      const hits = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, lowLevel, undefined, halfThump);
      check(
        '向きが線を超えたコマは声だと言わない',
        hits.skewSeconds > 0 && hits.speechRatio < 0.9 && !hits.skewDropped,
        `落とした ${hits.skewSeconds.toFixed(2)}s / 割合 ${(hits.speechRatio * 100).toFixed(0)}%`,
      );

      // ③ 線の下なら素通り。門があること自体で声が減ってはいけない。
      const kept = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, lowLevel, undefined, fill(-1.0));
      check('向きが線の下なら落とさない', kept.skewSeconds === 0 && !kept.noSpeechFound, `落とした ${kept.skewSeconds.toFixed(2)}s`);

      // ④ **渡されないものを「打点だった」と読まない。** 列を渡し忘れただけで
      //    声が 1 コマも残らない、という壊れ方をしないこと（深さとは逆向きの穴）。
      const noColumn = planJetCut(sounding, gate, fill(0.5), fill(0.2));
      check('列を渡さなければ、向きでは判断しない', noColumn.skewSeconds === 0 && !noColumn.noSpeechFound, '');

      // ④' 低い側の列だけ渡し忘れても同じ。どのコマを読んでよいかがそこで決まるので、
      //     無いまま読むと**窓の縁の段差を音節と読む**コマまで落とすことになる。
      const noLow = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, undefined, undefined, fill(1.0));
      check('低い側の音量が無ければ、向きでは判断しない', noLow.skewSeconds === 0 && !noLow.noSpeechFound, '');

      // ⑤ 既定では入っていない（2026-09-16・3 回目に測って見送った）。
      //     ここが動いたら、既定を変えたということ。記録に残っているか確かめること。
      const off = planJetCut(sounding, bare, fill(0.5), fill(0.2), undefined, undefined, lowLevel, undefined, fill(1.0));
      check(
        '既定では向きの門は入っていない',
        DEFAULT_JET_CUT.maxLowSkew === 0 && off.skewSeconds === 0,
        `maxLowSkew = ${DEFAULT_JET_CUT.maxLowSkew}`,
      );

      // ⑥ **門が触れないコマの割合が、割合の下限になる。**
      //    この門は低い側が読めるコマにしか触れない。窓（0.64 秒）の両端 0.32 秒ずつは
      //    どうやっても読めないので、**全コマを打点にしても割合はそこまでしか落ちない。**
      //    4 秒の素材なら 0.64 / 4 = 16%。2026-09-17（2 回目）に、これが
      //    `music-thump`（下限 8.9%）を素材単位に止められない理由だと分かった
      //    ——7 通り測って全部駄目だったのは量の選び方ではなく、**線より下へ行けなかった**から。
      const all = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, lowLevel, undefined, fill(1.0));
      check(
        '門が触れないコマが、割合の下限になる',
        near(all.speechRatio, 0.64 / 4, 0.02) && !all.skewDropped,
        `割合 ${(all.speechRatio * 100).toFixed(0)}% ≒ 0.64s / 4s`,
      );

      // ⑥' **コマ単位の門に、素材単位の「声が見つからない」を立てさせない。**
      //     門だけを理由に止まったら、その素材では門を外す。
      //     **入れたときの根拠は「下限が線より低いのは声のある素材だけ」だったが、
      //     それは 2026-09-17（3 回目）に潰れた**（`music-thump-drop.wav`）。
      //     下限は「窓 ÷ 尺」なので、声の有無とは何の関係も無い。下の⑥''' を参照。
      const longTrack = analyzeLoudness(makeTone(16, sr, [{ from: 0, to: 16 }]), 0.02);
      const m = longTrack.db.length;
      const longLow = new Float32Array(m);
      for (let i = 0; i < m; i += 1) longLow[i] = longTrack.db[i];
      const longFill = (v: number) => new Float32Array(m).fill(v);
      const dropped = planJetCut(
        longTrack, gate, longFill(0.5), longFill(0.2), undefined, undefined, longLow, undefined, longFill(1.0),
      );
      const longOff = planJetCut(
        longTrack, bare, longFill(0.5), longFill(0.2), undefined, undefined, longLow, undefined, longFill(1.0),
      );
      check(
        '門だけで 5% を割ったら、その素材では門を外す',
        dropped.skewDropped && !dropped.noSpeechFound && dropped.skewSeconds === 0,
        `割合 ${(dropped.speechRatio * 100).toFixed(1)}%`,
      );

      // ⑥'' 外したあとは、門を渡さなかったときと**同じ計画**でなければならない。
      //      「外した」が「別の何かに落ちた」になっていないことを、秒数で突き合わせる。
      check(
        '門を外した先は、門なしとまったく同じ計画',
        near(dropped.removed, longOff.removed, 1e-9) && near(dropped.speechRatio, longOff.speechRatio, 1e-9),
        `削った ${dropped.removed.toFixed(2)}s / ${longOff.removed.toFixed(2)}s`,
      );

      // ⑦ **門と無関係な理由でも止まるなら、外しても結論は変わらない。** 形が動いていない
      //    素材（鳴りっぱなしの音楽）は、門を外しても `shape` で止まる。ここで印を立てると
      //    「門のせいで止まった」と読み違えるので、立てないこと。
      const flat = planJetCut(sounding, gate, fill(0.5), fill(0.0), undefined, undefined, lowLevel, undefined, fill(1.0));
      check(
        '形でも止まる素材は、門を外しても止まる（印は立てない）',
        flat.noSpeechFound && flat.noSpeechReason === 'shape' && !flat.skewDropped,
        `理由 ${flat.noSpeechReason}`,
      );

      // ⑦' 門が無ければ、印は立ちようが無い。既定（`maxLowSkew` 0）で立ったら、
      //     どこかで門と関係のない話が印に混ざっている。
      check('門を入れていなければ、外した印も立たない', !off.skewDropped && !kept.skewDropped, '');

      // ⑥''' **外すかどうかを決めているのは、素材の中身ではなく尺だった。**
      //      ⑥ と ⑥' に渡している列は 1 つも違わない（全コマ鳴っていて、全コマ打点向き、
      //      全コマ声らしい）。違うのは長さだけで、4 秒では下限 16% で止まらず、
      //      16 秒では 4% まで落ちて門を外す。
      //      **入れたときに書いた「下限が線を割るのは声のある素材だけ」は、
      //      13 秒という素材の都合だった**（2026-09-17・3 回目に `music-thump-drop.wav` で撃たれた）。
      check(
        '外すかどうかを決めているのは、素材の中身ではなく尺',
        !all.skewDropped && dropped.skewDropped,
        `4 秒 割合 ${(all.speechRatio * 100).toFixed(0)}% / 16 秒 外した`,
      );

      // ⑥'''' **その下限は「窓 ÷ 尺」そのもの。** 低い側が全編鳴っているなら、
      //       読めないのは窓の幅ちょうど（`windowFrames - 1` コマ）で、尺には依らない。
      //       だから割合の下限は尺に**反比例**する。長い素材ほど下限は 0 に近づき、
      //       声がゼロでも線を割れるようになる。**この門の安全弁は、短い素材の側にしか無い。**
      const unreadableFrames = (length: number) => {
        const marks = lowBandReadable(new Float32Array(length).fill(-20), -40, windowFrames);
        let count = 0;
        for (let i = 0; i < length; i += 1) if (!marks[i]) count += 1;
        return count;
      };
      check(
        '読めないコマは、尺によらず窓の幅ちょうど',
        [50, 200, 1000].every((length) => unreadableFrames(length) === windowFrames - 1),
        `${windowFrames - 1} コマ（窓 ${windowFrames} コマ）`,
      );
    }

    // ㉑ **対数を外した深さの門**（`minEnergyDepthDrop`。2026-09-19・2 回目に既定にした）。
    //
    //    この門は「その素材の最大から何 dB 下か」で声と背景を分ける。
    //    列そのものは**倍率に不変でない**ので、**差にして初めて使える**量になっている。
    //    ここで守るのはその 1 点と、門が読めるコマの外へ出ないこと。
    {
      const sr = 16000;
      const sounding = analyzeLoudness(makeTone(4, sr, [{ from: 0, to: 4 }]), 0.02);
      const n = sounding.db.length;
      const fill = (v: number) => new Float32Array(n).fill(v);
      const lowLevel = new Float32Array(n);
      for (let i = 0; i < n; i += 1) lowLevel[i] = sounding.db[i];
      const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0, minKeep: 0, speechLeadIn: 0, minEnergyDepthDrop: 0 };
      const gate = { ...bare, minEnergyDepthDrop: 6, minModulationDepth: 0 };
      // 前半を「最大」、後半を「最大から 10dB 下」にした列。線 6dB なら後半だけが落ちる。
      const half = new Float32Array(n);
      for (let i = 0; i < n; i += 1) half[i] = i < n / 2 ? -20 : -30;

      const dropped = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, lowLevel, undefined, undefined, half);
      check(
        '最大から線より下のコマは声だと言わない',
        dropped.energySeconds > 0 && dropped.energyBaseDb !== null && near(dropped.energyBaseDb as number, -20, 1e-6),
        `落とした ${dropped.energySeconds.toFixed(2)}s / 基準 ${dropped.energyBaseDb?.toFixed(2)}dB`,
      );

      // ㉑' **倍率に不変。** 列を丸ごと持ち上げても（＝素材の音量を上げても）結論は 1 ミリも動かない。
      //     この門の存在理由そのもの。ここが崩れたら、素材の録音レベルで結果が変わる道具になる。
      const lifted = new Float32Array(n);
      for (let i = 0; i < n; i += 1) lifted[i] = half[i] + 12;
      const liftedPlan = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, lowLevel, undefined, undefined, lifted);
      check(
        '列を丸ごと持ち上げても、落とすコマは変わらない',
        near(liftedPlan.energySeconds, dropped.energySeconds, 1e-9) && near(liftedPlan.removed, dropped.removed, 1e-9),
        `落とした ${liftedPlan.energySeconds.toFixed(2)}s（+12dB 前 ${dropped.energySeconds.toFixed(2)}s）`,
      );

      // ㉑'' その不変性は列の側にも要る。**素材を 2 倍すれば列は 6dB 上がる**（差は変わらない）。
      //      ここが 6dB でなければ、上の「差にすれば打ち消える」が成り立たない。
      const quiet = analyzeLoudness(makeTone(2, sr, [{ from: 0, to: 2, amp: 0.25 }]), 0.02);
      const loud = analyzeLoudness(makeTone(2, sr, [{ from: 0, to: 2, amp: 0.5 }]), 0.02);
      // 揺れの無い正弦波では深さが底に張り付くので、音量を 4.2Hz で揺らした列を直に渡す。
      const wobble = (track: LoudnessTrack, offsetDb: number) => {
        const db = new Float32Array(track.db.length);
        for (let i = 0; i < db.length; i += 1) db[i] = offsetDb + 3 * Math.sin((2 * Math.PI * 4.2 * i * track.hop));
        return energyModulationDepthDb({ hop: track.hop, db, duration: track.duration });
      };
      const mid = Math.round(quiet.db.length / 2);
      const gapDb = wobble(loud, -20)[mid] - wobble(quiet, -26)[mid];
      check(
        '素材を 2 倍すると、この列はちょうど 6dB 上がる',
        near(gapDb, 6, 0.05),
        `${gapDb.toFixed(3)}dB`,
      );

      // ㉑''' **渡されないものを背景と読まない。** 列を渡し忘れただけで声が消える壊れ方をしないこと。
      const noColumn = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, lowLevel);
      check(
        '列を渡さなければ、深さでは判断しない',
        noColumn.energySeconds === 0 && noColumn.energyBaseDb === null && !noColumn.noSpeechFound,
        '',
      );

      // ㉑'''' 低い側の音量だけ渡し忘れても同じ。**どのコマを読んでよいかがそこで決まる**ので、
      //       無いまま読むと窓の縁の段差を「よく揺れている」と読んで基準を奪われる。
      const noLow = planJetCut(sounding, gate, fill(0.5), fill(0.2), undefined, undefined, undefined, undefined, undefined, half);
      check('低い側の音量が無ければ、深さでは判断しない', noLow.energySeconds === 0 && noLow.energyBaseDb === null, '');

      // ㉑''''' **読めるコマが 1 つも無ければ、基準が作れないので門を立てない。**
      //        ここで無理に基準を作ると、縁 1 コマが基準になって門が丸ごと誤る。
      //        窓の幅より短い素材は、低い側が全編鳴っていても読めるコマを持たない（⑥'''' と同じ理由）。
      const shortTrack = analyzeLoudness(makeTone(0.3, sr, [{ from: 0, to: 0.3 }]), 0.02);
      const k = shortTrack.db.length;
      const shortLow = new Float32Array(k);
      for (let i = 0; i < k; i += 1) shortLow[i] = shortTrack.db[i];
      const shortPlan = planJetCut(
        shortTrack,
        gate,
        new Float32Array(k).fill(0.5),
        new Float32Array(k).fill(0.2),
        undefined,
        undefined,
        shortLow,
        undefined,
        undefined,
        new Float32Array(k).fill(-20),
      );
      check(
        '読めるコマが無ければ、基準を作らず門も立てない',
        shortPlan.energyBaseDb === null && shortPlan.energySeconds === 0,
        `${k} コマ（窓 ${modulationWindowFrames(shortTrack.hop)} コマ）`,
      );

      // ㉑'''''' 既定は 6dB。**ここが動いたら既定を変えたということ**で、記録に前後の数字が
      //        並んでいなければならない（24 本で 残せた率 99.6% / 精度 72.3% / 実害 2.96s）。
      check(
        '既定で深さの門が入っている（線は 6dB）',
        DEFAULT_JET_CUT.minEnergyDepthDrop === 6,
        `minEnergyDepthDrop = ${DEFAULT_JET_CUT.minEnergyDepthDrop}`,
      );
    }
  }

  // --- ラウドネス（LUFS）---
  //
  // ここは**ほかの検算とは性格が違う**。無音カットの判定は「何が正しいか」を
  // 自分たちで決めているので、検算も自分で立てた理屈と突き合わせるしかない。
  // ラウドネスには**外の正解がある**（ITU-R BS.1770-4 と EBU Tech 3341 の試験信号）ので、
  // そちらと合わせる。合わなければ、こちらが間違っている。
  {
    const sr = 48000;

    /** 区間ごとに dBFS を指定した 1kHz の正弦波。試験信号はどれもこの形。 */
    const sine = (segments: { seconds: number; db: number | null }[], rate = sr, channels = 2) => {
      const total = segments.reduce((a, s) => a + s.seconds, 0);
      const length = Math.round(total * rate);
      const data = new Float32Array(length);
      let at = 0;
      for (const seg of segments) {
        const n = Math.round(seg.seconds * rate);
        const amp = seg.db === null ? 0 : Math.pow(10, seg.db / 20);
        for (let i = 0; i < n && at + i < length; i += 1) data[at + i] = amp * Math.sin((2 * Math.PI * 1000 * (at + i)) / rate);
        at += n;
      }
      return { sampleRate: rate, numberOfChannels: channels, length, getChannelData: () => data } as AudioLike;
    };
    const lufsOf = (buffer: AudioLike, options = {}) =>
      measureLoudness(buffer, { skipTruePeak: true, ...options }).integratedLufs;

    // ① 係数を周波数から作り直したものが、規格が載せている 48kHz の表と一致すること。
    //    **ここが合っていないと、以下の数字が全部それらしく見えたまま少しずつ狂う。**
    //    教科書どおりの高域棚の式では小数 2 桁目から外れたので、Vh/Vb を使う形にしてある。
    const [shelf, highpass] = kWeighting(48000);
    const table = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
    const shelfError = Math.max(
      ...(['b0', 'b1', 'b2', 'a1', 'a2'] as const).map((k) => Math.abs(shelf[k] - table[k])),
    );
    check('K 特性の係数が規格の 48kHz の表と一致する', shelfError < 1e-10, `最大のずれ ${shelfError.toExponential(1)}`);
    check(
      '2 段目の分子は (1, -2, 1) 固定',
      highpass.b0 === 1 && highpass.b1 === -2 && highpass.b2 === 1 && near(highpass.a2, 0.99007225036621, 1e-10),
      `a1 = ${highpass.a1.toFixed(11)}`,
    );

    // ②〜⑤ EBU Tech 3341 の試験信号。許容は規格と同じ ±0.1 LU。
    const case1 = lufsOf(sine([{ seconds: 20, db: -23 }]));
    check('1kHz -23dBFS 20 秒が -23.0 LUFS になる', near(case1 as number, -23, 0.1), `${(case1 as number).toFixed(2)} LUFS`);
    const case2 = lufsOf(sine([{ seconds: 20, db: -33 }]));
    check('1kHz -33dBFS 20 秒が -33.0 LUFS になる', near(case2 as number, -33, 0.1), `${(case2 as number).toFixed(2)} LUFS`);

    // 相対ゲート: 前後に -36dBFS を足しても、真ん中の -23 のままでなければならない。
    // **ゲートが無いと、間の長い素材ほど小さく測れてしまう。**
    const case3 = lufsOf(sine([
      { seconds: 10, db: -36 },
      { seconds: 60, db: -23 },
      { seconds: 10, db: -36 },
    ]));
    check('前後に小さい音が付いても値が動かない（相対ゲート）', near(case3 as number, -23, 0.1), `${(case3 as number).toFixed(2)} LUFS`);

    // 絶対ゲート: -70 LUFS より静かなところは、相対ゲートを作る平均にも入れない。
    const case4 = lufsOf(sine([
      { seconds: 10, db: -72 },
      { seconds: 10, db: -36 },
      { seconds: 60, db: -23 },
      { seconds: 10, db: -36 },
      { seconds: 10, db: -72 },
    ]));
    check('ごく静かな区間を平均に入れない（絶対ゲート）', near(case4 as number, -23, 0.1), `${(case4 as number).toFixed(2)} LUFS`);

    // ⑥ 測れないものは測れないと言う。ここで 0 や -100 を返すと、
    //    呼ぶ側が「とても静かな素材」と読んで巨大な倍率を掛けることになる。
    check('無音は測れない（null を返す）', lufsOf(sine([{ seconds: 5, db: null }])) === null, '');
    check('窓に足りない素材は測れない（null を返す）', lufsOf(sine([{ seconds: 0.3, db: -23 }])) === null, '0.3 秒');

    // ⑦ チャンネルの数え方。規格はパワーを**足す**ので、同じ音でも 1ch は 2ch より 3.01 小さい。
    //    **どちらが正しいかは「最後に何 ch で出るか」で決まる。** 本体の書き出しは 2ch なので、
    //    1ch の素材を測るときは `monoAsDualMono` を立てる（`loudness.mjs` がそうしている）。
    const mono = sine([{ seconds: 20, db: -23 }], sr, 1);
    const monoLufs = lufsOf(mono) as number;
    check('1ch は 2ch より 3.01 小さく出る', near(monoLufs, -26.01, 0.1), `${monoLufs.toFixed(2)} LUFS`);
    const dual = lufsOf(mono, { monoAsDualMono: true }) as number;
    check('1ch を 2ch 扱いにすると一致する', near(dual, -23, 0.1), `${dual.toFixed(2)} LUFS`);

    // ⑧ 標本化周波数が変わっても同じ値になること（＝係数をその場で作り直している証拠）。
    //    48kHz の表を 44.1kHz へそのまま当てると、ここが 0.1 LU では収まらなくなる。
    const at441 = lufsOf(sine([{ seconds: 20, db: -23 }], 44100)) as number;
    check('44.1kHz でも同じ値になる', near(at441, -23, 0.1), `${at441.toFixed(2)} LUFS`);

    // ⑨ 倍率に対しては素直に動く（2 倍で +6.02 LU）。これが崩れると正規化そのものが成り立たない。
    const doubled = lufsOf(applyGain(sine([{ seconds: 20, db: -23 }]), 2)) as number;
    check('2 倍にすると 6.02 LU 上がる', near(doubled - (case1 as number), 6.02, 0.05), `${(doubled - (case1 as number)).toFixed(2)} LU`);

    // ⑩⑪ 真のピーク。**標本の間を見ないと、天井を超えていることに気づけない。**
    //     fs/4 の正弦波を π/4 ずらすと、標本は山を外して -3.01dBFS に見えるが、実際は 0dBFS。
    const n = sr;
    const missed = new Float32Array(n);
    for (let i = 0; i < n; i += 1) missed[i] = Math.sin((2 * Math.PI * i) / 4 + Math.PI / 4);
    const missedBuffer = { sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => missed } as AudioLike;
    const peaks = measureLoudness(missedBuffer);
    check('標本が山を外しても真のピークは 0dBTP を指す', near(peaks.truePeakDb, 0, 0.1), `標本 ${peaks.samplePeakDb.toFixed(2)} dBFS / 真 ${peaks.truePeakDb.toFixed(2)} dBTP`);
    check('標本のピークとの差が 3dB ほど開く', near(peaks.truePeakDb - peaks.samplePeakDb, 3.01, 0.15), `${(peaks.truePeakDb - peaks.samplePeakDb).toFixed(2)} dB`);
    // 位相 0 が δ になっていない実装だと、ここが破れる（真が標本を下回る）。
    const onPeak = new Float32Array(n);
    for (let i = 0; i < n; i += 1) onPeak[i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    check('真のピークは標本のピークを下回らない', truePeakOf(onPeak) >= 0.8 - 1e-6, `${truePeakOf(onPeak).toFixed(4)}`);

    // ⑫ 当てたら本当に目標になるか。**測り方と当て方を別々に信じないための往復。**
    const quiet = sine([{ seconds: 20, db: -30 }]);
    const plan = planLoudnessNormalization(measureLoudness(quiet));
    const after = lufsOf(applyGain(quiet, plan.gain)) as number;
    check('揃えると目標の大きさになる', near(after, DEFAULT_NORMALIZATION.targetLufs, 0.1), `${after.toFixed(2)} LUFS（倍率 ${plan.gainDb.toFixed(2)}dB）`);
    check('目標に届いたときは何にも止められていない', plan.limitedBy === 'none' && plan.shortfallDb === 0, plan.limitedBy);

    // ⑬ ピークが先に天井へ当たる素材では、**目標へ届かせない。**
    //    無理に上げれば歪むので、届かなかったことを呼ぶ側へ返すのが正しい振る舞い。
    //    12 秒の本体 + 0.1 秒だけ鳴る大きな音、という形（`speech-click.wav` と同じ形）。
    //
    //    **本体を -40dBFS にしてはいけない**（最初そう書いて落ちた）。
    //    大きな音と 37dB も開くと、相対ゲートが本体のほうを丸ごと捨てて、
    //    「短い大きな音だけの素材」として測られる。ゲートは**静かな所を捨てる**ので、
    //    こういう素材では「全体としては静か」という読みのほうが成り立たない。
    const spike = sine([
      { seconds: 6, db: -20 },
      { seconds: 0.1, db: -0.5 },
      { seconds: 6, db: -20 },
    ]);
    const spikePlan = planLoudnessNormalization(measureLoudness(spike));
    check('ピークが天井に当たるなら目標まで上げない', spikePlan.limitedBy === 'peak' && spikePlan.shortfallDb > 0, `${spikePlan.gainDb.toFixed(2)}dB / 届かなかったぶん ${spikePlan.shortfallDb.toFixed(2)}dB`);
    check(
      '止めた結果が天井ちょうどに収まる',
      near(spikePlan.resultTruePeakDb, DEFAULT_NORMALIZATION.truePeakCeilingDb, 0.01),
      `${spikePlan.resultTruePeakDb.toFixed(3)} dBTP`,
    );

    // ⑭ **持ち上げの上限は置いていない。** とても小さい素材でも目標まで上げる。
    //    上限を置く手は 2026-09-19（3 回目）に 2 通り測って両方捨てた（`lufs.ts` の注を参照）。
    //    ここが `limitedBy: 'peak'` 以外で止まるようになったら、その判断を変えたということ。
    const tiny = sine([{ seconds: 20, db: -60 }]);
    const tinyPlan = planLoudnessNormalization(measureLoudness(tiny));
    check(
      'とても小さい素材でも目標まで上げる（持ち上げの上限は置いていない）',
      tinyPlan.limitedBy === 'none' && near(tinyPlan.gainDb, 46, 1),
      `${tinyPlan.gainDb.toFixed(2)}dB`,
    );

    // ⑭' 静かなほうの窓の値は**出すだけ**（判断には使っていない）。
    //    鳴りっぱなしの素材ではここに音楽そのものが出るので、雑音の底とは読めない。
    const steadyTone = measureLoudness(sine([{ seconds: 20, db: -23 }]), { skipTruePeak: true });
    check(
      '鳴りっぱなしの素材では、静かな窓の値も本編と同じ',
      steadyTone.quietBlockLufs !== null && near(steadyTone.quietBlockLufs, -23, 0.2),
      `${(steadyTone.quietBlockLufs as number).toFixed(2)} LUFS`,
    );

    // ⑮ 測れなかった素材には倍率を掛けない。**1 倍で通す**のが唯一の安全な振る舞い。
    const nothing = planLoudnessNormalization(measureLoudness(sine([{ seconds: 5, db: null }])));
    check('測れない素材は 1 倍のまま通す', nothing.limitedBy === 'unmeasurable' && nothing.gain === 1, `${nothing.gainDb}dB`);

    // ⑯ すでに大きい素材は素直に下げる（`speech-loud-clipped.wav` と同じ向き）。
    const loud = planLoudnessNormalization(measureLoudness(sine([{ seconds: 20, db: -3 }])));
    check('大きすぎる素材は下げる', loud.gainDb < -5 && loud.limitedBy === 'none', `${loud.gainDb.toFixed(2)}dB`);
  }

  // --- 打ち直しを速くした形（2026-10-06）---
  //
  // 打ち直しは測りの時間の 8 割を持っていたので、2 つの手で速くした
  // （3 位相を 1 本の輪にまとめる／山が無いと先に分かる升を丸ごと飛ばす）。
  // **速くしたときに確かめなければならないのは速さではなく「値が 1 ビットも動いていないこと」**なので、
  // ここでは素直な形をその場で組み直して突き合わせる。
  // 素直な形は `TP_FILTER` からしか作れない（だから lufs.ts はタップを外に出している）。
  {
    /** 2026-10-06 より前の形。位相ごとに素材をなめ直し、飛ばしもしない。 */
    const plainPeak = (data: Float32Array, from = 0, to = data.length - TP_TAPS) => {
      let peak = 0;
      for (let p = 1; p < TP_FILTER.length; p += 1) {
        const taps = TP_FILTER[p];
        for (let i = from; i <= to; i += 1) {
          let acc = 0;
          for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k];
          const a = Math.abs(acc);
          if (a > peak) peak = a;
        }
      }
      return peak;
    };
    /** 2026-10-06 より前の形の `truePeakOf`（標本の最大と合わせる）。 */
    const plainOf = (data: Float32Array) => {
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      if (data.length < TP_TAPS) return peak;
      const conv = plainPeak(data);
      return conv > peak ? conv : peak;
    };
    /** 2026-10-06 より前の形の `truePeakEnvelope`。 */
    const plainEnvelope = (data: Float32Array) => {
      const env = new Float64Array(data.length);
      for (let i = 0; i < data.length; i += 1) env[i] = Math.abs(data[i]);
      if (data.length < TP_TAPS) return env;
      for (let p = 1; p < TP_FILTER.length; p += 1) {
        const taps = TP_FILTER[p];
        const at = TP_TAPS / 2 + Math.round(p / TP_FILTER.length);
        for (let i = 0; i + TP_TAPS <= data.length; i += 1) {
          let acc = 0;
          for (let k = 0; k < TP_TAPS; k += 1) acc += taps[k] * data[i + k];
          const a = Math.abs(acc);
          const j = i + at;
          if (j < env.length && a > env[j]) env[j] = a;
        }
      }
      return env;
    };

    // いじめる素材を先に並べる。**飛ばす手が効かない素材を入れておかないと、
    // 「うまくいった」の中身が「自分に都合のいい素材で試しただけ」になる。**
    const sr = 48000;
    const lcg = (n: number, amp: number) => {
      const d = new Float32Array(n);
      let s = 1;
      for (let i = 0; i < n; i += 1) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        d[i] = amp * (s / 0x40000000 - 1);
      }
      return d;
    };
    const wave = (n: number, f: number, amp: number, shape: 'sine' | 'square' = 'sine') => {
      const d = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const v = Math.sin((2 * Math.PI * f * i) / sr);
        d[i] = amp * (shape === 'sine' ? v : v >= 0 ? 1 : -1);
      }
      return d;
    };
    const flat = (n: number, v: number) => {
      const d = new Float32Array(n);
      d.fill(v);
      return d;
    };
    /**
     * **上限をちょうど満たす並び。** タップの符号に合わせて ±amp を置くと、
     * 畳み込みの値が「正のタップの和 ＋ 負のタップの和」そのものになり、
     * 窓の最大・最小から出した上限とぴったり一致する。
     * **飛ばす手がいちばん効かない形**で、同時に**上限の緩みを測る物差し**でもある
     * （この並びが無いと、境界の係数を 0.9 倍しても検査が通ってしまった）。
     */
    const worstCase = (phase: number, repeats: number, amp: number) => {
      const taps = TP_FILTER[phase];
      const d = new Float32Array(TP_TAPS * repeats);
      for (let i = 0; i < d.length; i += 1) d[i] = taps[i % TP_TAPS] > 0 ? amp : -amp;
      return d;
    };
    const cases: [string, Float32Array][] = [
      // 飛ばす手が効かない 3 本。**どれも「上限いっぱいで、窓の中が暴れている」形。**
      ['上限をちょうど満たす並び', worstCase(2, 1000, 0.9)],
      ['全振幅の雑音', lcg(20000, 1)],
      ['全振幅の 1kHz', wave(20000, 1000, 1)],
      // 飛ばす手がよく効く形
      ['静かな雑音', lcg(20000, 0.05)],
      ['全振幅の 60Hz', wave(20000, 60, 1)],
      ['全振幅の矩形波', wave(20000, 200, 0.999, 'square')],
      // 符号が片側だけ（境界の式の max(M, −m) がここで効く）
      ['正の直流', flat(5000, 0.8)],
      ['負の直流', flat(5000, -0.8)],
      ['負に寄った雑音', (() => { const d = lcg(20000, 0.4); for (let i = 0; i < d.length; i += 1) d[i] -= 0.5; return d; })(),
      ],
      // 山が端にある形（飛ばす判定は床から始まるので、端の扱いを間違えると落ちる）
      ['頭だけ大きい', (() => { const d = lcg(20000, 0.1); for (let i = 0; i < 24; i += 1) d[i] = i % 2 ? 0.9 : -0.9; return d; })()],
      ['尻だけ大きい', (() => { const d = lcg(20000, 0.1); for (let i = d.length - 24; i < d.length; i += 1) d[i] = i % 2 ? 0.9 : -0.9; return d; })()],
      ['無音', new Float32Array(5000)],
    ];
    let worstName = '';
    let bad = 0;
    for (const [name, data] of cases) {
      if (truePeakOf(data) !== plainOf(data)) {
        bad += 1;
        worstName = name;
      }
    }
    check(
      '速くした打ち直しは、素直な形とビット単位で同じ（いじめる素材 12 本）',
      bad === 0,
      bad === 0 ? `${cases.length} 本とも一致` : `${bad} 本ずれた（例 ${worstName}）`,
    );

    // 升の継ぎ目と素材の端。**長さが升の幅で割り切れるかどうかで道が変わる**ので、
    // 12 標本の前後と升 1〜3 個ぶんを 1 標本きざみで総当たりする。
    {
      let worst = 0;
      let at = -1;
      const base = lcg(200, 0.9);
      for (let n = 0; n <= 60; n += 1) {
        const data = base.subarray(0, n);
        const got = truePeakOf(data);
        const want = plainOf(data);
        if (got !== want) {
          worst += 1;
          if (at < 0) at = n;
        }
      }
      check('長さ 0〜60 標本を 1 きざみで総当たりしても一致する', worst === 0, worst === 0 ? '61 通りとも一致' : `${worst} 通りずれた（最初は ${at} 標本）`);
    }

    // 床を渡しても値は変わらない（飛ばす判定にだけ効く、が守られているか）。
    {
      let bad2 = 0;
      for (const [, data] of cases) {
        const want = truePeakOf(data);
        for (const floor of [0, want * 0.5, want * 0.999999, want, want * 2]) {
          const got = truePeakOf(data, floor);
          if (got !== Math.max(want, floor)) bad2 += 1;
        }
      }
      check('床を渡しても答えは変わらない（飛ばす判定にだけ効く）', bad2 === 0, bad2 === 0 ? `${cases.length} 本 × 5 通り` : `${bad2} 通りずれた`);
    }

    // 境界そのものが上限であること。**ここが破れていると、速い形は黙って小さい値を返す。**
    // 総当たりで、窓の中の最大・最小から出した上限が、3 つの位相のどの値も下回らないことを見る。
    {
      // 雑音（緩い側）と、上限をちょうど満たす並び（きつい側）を continue させず両方なめる。
      const data = new Float32Array(40000 + TP_TAPS * 30);
      data.set(lcg(40000, 1), 0);
      data.set(worstCase(2, 10, 0.9), 40000);
      data.set(worstCase(1, 10, 0.6), 40000 + TP_TAPS * 10);
      data.set(worstCase(3, 10, 1), 40000 + TP_TAPS * 20);
      let over = 0;
      let worstRatio = 0;
      for (let i = 0; i + TP_TAPS <= data.length; i += 1) {
        let big = -Infinity;
        let small = Infinity;
        for (let k = 0; k < TP_TAPS; k += 1) {
          const v = data[i + k];
          if (v > big) big = v;
          if (v < small) small = v;
        }
        const bound = truePeakWindowBound(big, small);
        for (let p = 1; p < TP_FILTER.length; p += 1) {
          let acc = 0;
          for (let k = 0; k < TP_TAPS; k += 1) acc += TP_FILTER[p][k] * data[i + k];
          const a = Math.abs(acc);
          // 実装が頼っているのは「上限 × 余裕」のほう。**生の上限は丸めでわずかに割られる**
          // （2026-10-06 に測ったら、ちょうど満たす並びで 19 窓が相対 2e-16 ほど超えた）。
          if (a > bound * TP_MARGIN) over += 1;
          if (a / bound > worstRatio) worstRatio = a / bound;
        }
      }
      check(
        '窓の最大・最小から出す上限を、どの位相の値も超えない（4 万窓 × 3 位相。上限をちょうど満たす並びを含む）',
        over === 0,
        over === 0
          ? `いちばん近づいたのが上限の ${(worstRatio * 100).toFixed(1)}%（余裕 ${((TP_MARGIN - 1) * 1e12).toFixed(2)}e-12 のうち使ったのは ${((worstRatio - 1) * 1e12).toFixed(5)}e-12）`
          : `${over} 回超えた`,
      );
    }

    // 升の幅。**窓が 2 升に収まらないと、上限が窓の一部しか見ていないことになる。**
    // 2026-10-06 に「幅を 1 広げる」壊し方を試したら検査が全部通ったが、
    // それは**広げるほうは安全側**だったからで、狭めるほうが落ちる。幅そのものを見る検査にした。
    {
      const span = TP_BLOCK * 2;
      check(
        '窓は必ず 2 升に収まる（升の幅 ≧ タップ数 − 1）',
        TP_BLOCK >= TP_TAPS - 1 && span >= TP_BLOCK - 1 + TP_TAPS,
        `升 ${TP_BLOCK} / タップ ${TP_TAPS} / 2 升で ${span} 標本・要る ${TP_BLOCK - 1 + TP_TAPS} 標本`,
      );
    }

    // 平らで大きい区間は、上限がちょうど標本の値そのもの＝必ず床以下になる。
    // **この性質のために `P·M − N·m` ではなく `max(M, −m) + N·(M − m)` の形を採った**
    // （前者は同じ値が丸めで上下に振れ、飛ばせるかどうかが最後の桁で決まる）。
    {
      let bad3 = 0;
      for (const v of [0.999, -0.999, 0.5, 1, -1, 0.1, -0.7]) {
        const big = Math.fround(v);
        if (truePeakWindowBound(big, big) !== Math.abs(big)) bad3 += 1;
      }
      check('平らな区間では上限がちょうど標本の値（丸めが乗らない）', bad3 === 0, bad3 === 0 ? '7 通りとも一致' : `${bad3} 通りずれた`);
    }

    // 列を返す側（リミッタが見るほう）も、まとめた輪で値が変わっていないこと。
    {
      let bad4 = 0;
      for (const [, data] of cases) {
        const got = truePeakEnvelope(data);
        const want = plainEnvelope(data);
        for (let i = 0; i < want.length; i += 1) if (got[i] !== want[i]) bad4 += 1;
      }
      check('標本ごとの列も、素直な形とビット単位で同じ', bad4 === 0, bad4 === 0 ? `${cases.length} 本の全標本で一致` : `${bad4} 標本ずれた`);
    }

    // 繋ぎ目をまたぐぶんも同じ（ここも共通の内側へ移したので、まとめて確かめる）。
    {
      let bad5 = 0;
      for (const [, data] of cases) {
        if (data.length < 2 * TP_TAPS) continue;
        const half = Math.floor(data.length / 2);
        const left = data.subarray(0, half);
        const right = data.subarray(half);
        const joined = new Float32Array(Math.min(left.length, TP_TAPS - 1) + Math.min(right.length, TP_TAPS - 1));
        const l = left.subarray(Math.max(0, left.length - (TP_TAPS - 1)));
        const r = right.subarray(0, TP_TAPS - 1);
        joined.set(l, 0);
        joined.set(r, l.length);
        const from = Math.max(0, l.length - TP_TAPS + 1);
        const to = Math.min(l.length - 1, joined.length - TP_TAPS);
        if (truePeakAcrossJoin(left, right) !== plainPeak(joined, from, to)) bad5 += 1;
      }
      check('繋ぎ目をまたぐぶんも、素直な形と同じ', bad5 === 0, bad5 === 0 ? '一致' : `${bad5} 本ずれた`);
    }
  }

  // --- 無音で IIR の履歴が非正規化数へ落ちる（2026-10-06）---
  //
  // 打ち直しを速くしたら、測りの残りの山が K 特性の側へ移った。そこを測ったら、
  // **無音のある素材では同じ仕事が 9 倍遅い**（履歴が非正規化数へ落ちて CPU の遅い道へ逸れる）。
  // 手当ては「落ちる手前で 0 へ寄せる」だけだが、**それで測りの値が動かないことが要る。**
  {
    const sr = 48000;
    const seconds = 8;
    const length = seconds * sr;
    // 1 秒鳴って 7 秒休む素材。**休みはちょうど 0**（本体の書き出しも、鳴っていない所は 0 で埋める）。
    //
    // 休みを長く取ってあるのは、**2 段目が非正規化数まで落ちるのに無音 3 秒ぶん要る**から
    // （38Hz の極は 460 標本で 1 桁しか落ちないので、307 桁で 14 万標本）。
    // 1 段目（棚）はもっと速く落ちるので、**実素材の 0.7 秒の切れ目では 1 段目だけが落ちる。**
    // 2026-10-06 に、切れ目 0.7 秒の素材で検査を書いたら 2 段目の出口だけ見ていて素通りした。
    const data = new Float32Array(length);
    for (let i = 0; i < sr; i += 1) {
      const t = i / sr;
      data[i] = 0.6 * Math.sin(2 * Math.PI * 220 * t) * Math.min(1, (sr - i) / (0.05 * sr));
    }

    /** 手当て前の形（塊に割らず、0 へ寄せない）。 */
    const plainK = (src: Float32Array) => {
      const out = new Float64Array(src.length);
      out.set(src);
      for (const f of kWeighting(sr)) {
        let x1 = 0;
        let x2 = 0;
        let y1 = 0;
        let y2 = 0;
        for (let i = 0; i < out.length; i += 1) {
          const x = out[i];
          const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
          out[i] = y;
        }
      }
      return out;
    };
    const SUBNORMAL = 2.2250738585072014e-308;
    const subnormals = (a: Float64Array) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== 0 && Math.abs(a[i]) < SUBNORMAL) n += 1;
      return n;
    };
    const before = plainK(data);
    const after = applyKWeighting(data, sr);

    // ① そもそも非正規化数へ落ちていること（**落ちていなければ、手当ての速さの話が嘘になる**）。
    check(
      '無音のある素材では、手当て前の K 特性が非正規化数へ落ちる',
      subnormals(before) > length / 10,
      `${subnormals(before)} / ${length} 標本（${((subnormals(before) / length) * 100).toFixed(0)}%）`,
    );

    // ② 手当て後は 1 標本も非正規化数が残らない。**0 へ寄せるのを外すとここが落ちる。**
    check('履歴を 0 へ寄せると、非正規化数が 1 標本も残らない', subnormals(after) === 0, `${subnormals(after)} 標本`);

    // ③ **それでいて測りの値は動かない。**
    //    0.1 秒ごとの二乗和を突き合わせると、**ぴったり同じにはならない**——
    //    無音だけの升では、手当て前が 1e-199 の桁・手当て後が 0 になる（2026-10-06 に測った）。
    //    なので主張は「升がビット単位で同じ」ではなく **「ずれる升はどれも、どちらの形でも
    //    捨てられる升」**。規格の絶対ゲートは -70 LUFS で、ずれた升はその 1000 桁下に居る。
    //    **線（`FLUSH_FLOOR`）を上げるとここが破れる**ので、線の置き所の検査になっている。
    {
      const step = Math.round(0.1 * sr);
      const lufsOf = (sum: number) => (sum === 0 ? -Infinity : -0.691 + 10 * Math.log10(sum / step));
      let differing = 0;
      let overGate = 0;
      let loudest = -Infinity;
      for (let b = 0; b * step + step <= length; b += 1) {
        let sa = 0;
        let sb = 0;
        for (let i = b * step; i < b * step + step; i += 1) {
          sa += before[i] * before[i];
          sb += after[i] * after[i];
        }
        if (sa === sb) continue;
        differing += 1;
        const level = Math.max(lufsOf(sa), lufsOf(sb));
        if (level > loudest) loudest = level;
        if (level > ABSOLUTE_GATE_LUFS) overGate += 1;
      }
      check(
        '0 へ寄せてずれる升は、どれも絶対ゲートより下（どちらの形でも捨てられる）',
        overGate === 0,
        `ずれた升 ${differing} / いちばん大きいものが ${loudest === -Infinity ? '—' : loudest.toFixed(0)} LUFS（ゲートは ${ABSOLUTE_GATE_LUFS}）`,
      );
    }

    // ④ 寄せた量そのものは -2000dB の桁。**線を上げるとここが大きくなる**ので、
    //    「値が動かない」の根拠を数字で残しておく。
    {
      let worst = 0;
      for (let i = 0; i < length; i += 1) {
        const d = Math.abs(before[i] - after[i]);
        if (d > worst) worst = d;
      }
      check('寄せたぶんは 1e-100 の桁（音として何も無い）', worst < 1e-99, `いちばん大きいずれ ${worst.toExponential(2)}`);
    }

    // ⑤ 測りぜんたい（LUFS・ピーク・静かな窓）も、無音の入った素材で前と同じ。
    //    **素材 43 本ぶんは `lab:truepeak` の 1 節で見ている**ので、ここは形だけ押さえる。
    {
      const buffer = { sampleRate: sr, numberOfChannels: 1, length, getChannelData: () => data } as AudioLike;
      const m = measureLoudness(buffer);
      check(
        '無音の入った素材でも、測りが素直な値を返す',
        m.integratedLufs !== null && m.integratedLufs > -30 && m.integratedLufs < -5 && m.truePeakDb < 0,
        `${(m.integratedLufs as number).toFixed(2)} LUFS / ${m.truePeakDb.toFixed(2)} dBTP（鳴っているのは 8 秒のうち 1 秒）`,
      );
    }
  }

  // --- リミッタ（山を均す処理）---
  //
  // ここも外に正解がある側に近い。**天井を守れているかは測れば分かる**ので、
  // 「それらしく動いている」ではなく「超えていない」を毎回確かめる。
  // 逆に「歪んでいないか」は自分で線を引くしかないので、
  // **倍率がどれだけ速く動いたか**という、目に見える量に置き換えて確かめている。
  {
    const sr = 48000;
    const ceiling = -1;

    /** f Hz の正弦波（振幅は dBFS で指定）。 */
    const sine = (f: number, seconds: number, db: number, rate = sr) => {
      const length = Math.round(seconds * rate);
      const data = new Float32Array(length);
      const amp = Math.pow(10, db / 20);
      for (let i = 0; i < length; i += 1) data[i] = amp * Math.sin((2 * Math.PI * f * i) / rate);
      return { sampleRate: rate, numberOfChannels: 1, length, getChannelData: () => data } as AudioLike;
    };
    /** 一定の音の途中に、1 発だけ天井を超える打撃を置く。 */
    const withSpike = (at: number, spike: number, baseDb = -20) => {
      const base = sine(400, 1, baseDb);
      const data = Float32Array.from(base.getChannelData(0));
      const start = Math.round(at * sr);
      for (let k = 0; k < Math.round(0.002 * sr); k += 1) {
        data[start + k] += spike * Math.exp(-k / (0.0003 * sr));
      }
      return { sampleRate: sr, numberOfChannels: 1, length: data.length, getChannelData: () => data } as AudioLike;
    };
    const peakDbOf = (buffer: AudioLike) => 20 * Math.log10(truePeakOf(buffer.getChannelData(0)));

    // ① 標本ごとの真のピークは、全体の最大と必ず一致する。
    //    **この 2 つがずれていたら、リミッタは見当違いの場所を下げている。**
    {
      const data = sine(997, 0.5, -3).getChannelData(0);
      const env = truePeakEnvelope(data);
      let max = 0;
      for (let i = 0; i < env.length; i += 1) if (env[i] > max) max = env[i];
      check('標本ごとの真のピークの最大が、全体の真のピークと一致する', near(max, truePeakOf(data), 1e-12), `${max.toFixed(9)}`);
    }

    // ② 天井の下しか鳴っていない素材は、1 ビットも触らない。
    //    **触らないことを確かめるのがいちばん大事**で、ここが崩れると全編が痩せる。
    {
      const quiet = sine(200, 0.5, -10);
      const r = limitTruePeak(quiet, { ceilingDb: ceiling });
      let same = true;
      for (let i = 0; i < quiet.length; i += 1) if (r.buffer.getChannelData(0)[i] !== quiet.getChannelData(0)[i]) same = false;
      check('天井の下の素材には手を出さない', same && r.report.maxReductionDb === 0, `作動 ${r.report.activeSeconds.toFixed(3)} 秒`);
    }

    // ③ 天井を超えていれば、通したあとは天井以下になる。
    {
      const loud = sine(200, 0.5, 0);
      const r = limitTruePeak(loud, { ceilingDb: ceiling, maxReductionDb: 12 });
      check(
        '天井を超える素材は天井以下まで下がる',
        r.report.truePeakDb <= ceiling + 0.01 && near(peakDbOf(r.buffer), ceiling, 0.05),
        `${peakDbOf(r.buffer).toFixed(2)} dBTP`,
      );
    }

    // ④ 見ているのは標本ではなく**真の**ピーク。叩き切った波形は標本 0dBFS のまま
    //    標本の間が 0 を超えるので、標本だけを見て下げると天井を守れない。
    {
      const length = sr / 2;
      const data = new Float32Array(length);
      for (let i = 0; i < length; i += 1) data[i] = Math.max(-1, Math.min(1, 3 * Math.sin((2 * Math.PI * 997 * i) / sr)));
      const clipped = { sampleRate: sr, numberOfChannels: 1, length, getChannelData: () => data } as AudioLike;
      const before = peakDbOf(clipped);
      const r = limitTruePeak(clipped, { ceilingDb: ceiling, maxReductionDb: 12 });
      check(
        '叩き切った波形でも、標本の間まで天井の下に入る',
        before > 0 && r.report.truePeakDb <= ceiling + 0.01,
        `${before.toFixed(2)} → ${r.report.truePeakDb.toFixed(2)} dBTP`,
      );
    }

    // ⑤ 山の手前から下がり始める（先読み）。山の瞬間に落とすと角を削ることになる。
    {
      const at = 0.5;
      const src = withSpike(at, 1.2).getChannelData(0);
      const out = limitTruePeak(withSpike(at, 1.2), { ceilingDb: ceiling, lookAheadMs: 10, maxReductionDb: 12 })
        .buffer.getChannelData(0);
      // **1 標本を見て割ってはいけない。** 土台は正弦波なので、その標本がたまたま
      // 零交差なら 0 ÷ 0 になる（最初そう書いて、倍率が動いていないように見えた）。
      // 前後 1ms の山どうしで比べる。
      const gainAround = (seconds: number) => {
        const i = Math.round(seconds * sr);
        let a = 0;
        let b = 0;
        for (let k = -48; k <= 48; k += 1) {
          a = Math.max(a, Math.abs(src[i + k]));
          b = Math.max(b, Math.abs(out[i + k]));
        }
        return a > 0 ? b / a : 1;
      };
      check(
        '山の手前から倍率が下がり始める（先読み）',
        gainAround(at - 0.005) < 0.999 && gainAround(at - 0.04) > 0.9999,
        `5ms 前 ${gainAround(at - 0.005).toFixed(3)} / 40ms 前 ${gainAround(at - 0.04).toFixed(3)}`,
      );
    }

    // ⑥ 倍率が 1 標本で飛ばない。**段差はそのまま歪みになる**ので、
    //    移動平均が効いていることを「隣どうしの差の最大」で押さえる。
    {
      const look = Math.round((DEFAULT_LIMITER.lookAheadMs / 1000) * sr);
      const src = withSpike(0.5, 1.2);
      const r = limitTruePeak(src, { ceilingDb: ceiling, maxReductionDb: 12 });
      const a = src.getChannelData(0);
      const b = r.buffer.getChannelData(0);
      let worst = 0;
      for (let i = 1; i < a.length; i += 1) {
        if (Math.abs(a[i]) < 1e-6 || Math.abs(a[i - 1]) < 1e-6) continue;
        worst = Math.max(worst, Math.abs(b[i] / a[i] - b[i - 1] / a[i - 1]));
      }
      // 長さ L の移動平均なので、1 標本あたりの動きは (1 − いちばん深い倍率) / L を超えない。
      check('倍率が 1 標本で飛ばない（移動平均が効いている）', worst <= 1 / look + 1e-9, `最大の段差 ${worst.toExponential(2)}（上限 ${(1 / look).toExponential(2)}）`);
    }

    // ⑦ 深さの上限を守る。**守るかわりに天井は超える**ので、そこを黙って呑まない。
    {
      // 天井を -6dB に取ると 6dB ぶん下げる必要があるので、上限 1dB では足りない。
      const r = limitTruePeak(sine(200, 0.5, 0), { ceilingDb: -6, maxReductionDb: 1 });
      check(
        '深さの上限より深くは下げない（かわりに天井を超えたと申告する）',
        r.report.maxReductionDb <= 1.0001 && r.report.clamped && r.report.truePeakDb > -6 + 0.01,
        `${r.report.maxReductionDb.toFixed(2)}dB 下げて ${r.report.truePeakDb.toFixed(2)} dBTP（天井 -6）`,
      );
    }

    // ⑧ 1 発の打撃のために、素材ぜんたいを小さくしない。
    //    **これが崩れると「均した」ではなく「小さくした」**になる。
    {
      const r = limitTruePeak(withSpike(0.5, 1.2), { ceilingDb: ceiling, maxReductionDb: 12 });
      check(
        '1 発の打撃で素材ぜんたいが小さくならない',
        r.report.activeSeconds < 0.05 && r.report.maxReductionDb > 3,
        `${r.report.maxReductionDb.toFixed(2)}dB を ${(r.report.activeSeconds * 1000).toFixed(1)}ms だけ`,
      );
    }

    // ⑨ 先読みが半周期より長ければ、低い音は歪まない。**ここが設計の要**なので、
    //    「歪まない側」と「歪む側」の両方を押さえる（片方だけだと、たまたま通ったのか分からない）。
    {
      const thd = (f: number, lookAheadMs: number) => {
        const out = limitTruePeak(sine(f, 1, 0), { ceilingDb: -6, lookAheadMs, maxReductionDb: 24 }).buffer.getChannelData(0);
        const period = sr / f;
        const total = Math.round(Math.floor((0.5 * sr) / period) * period);
        const start = Math.round((out.length - total) / 2);
        const mag = (h: number) => {
          let re = 0;
          let im = 0;
          for (let i = 0; i < total; i += 1) {
            const t = (2 * Math.PI * h * f * (i + start)) / sr;
            re += out[start + i] * Math.cos(t);
            im += out[start + i] * Math.sin(t);
          }
          return (2 * Math.hypot(re, im)) / total;
        };
        let acc = 0;
        for (let h = 2; h <= 6; h += 1) acc += mag(h) ** 2;
        return 20 * Math.log10(Math.max(Math.sqrt(acc) / mag(1), 1e-20));
      };
      // 50Hz の半周期は 10ms。既定（10ms）はそこに合わせてある。
      const clean = thd(50, 10);
      const dirty = thd(50, 2);
      check('半周期より長い先読みなら、低い音は歪まない（50Hz・10ms）', clean < -100, `${clean.toFixed(0)}dB`);
      check('先読みを半周期より短くすると歪む（50Hz・2ms）', dirty > -40, `${dirty.toFixed(0)}dB`);
    }

    // ⑩ 左右で同じ倍率を当てる。片側だけ下げると**音が左右にふらつく**。
    {
      const length = sr / 2;
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        left[i] = Math.sin((2 * Math.PI * 200 * i) / sr); // 天井を超える
        right[i] = 0.1 * Math.sin((2 * Math.PI * 200 * i) / sr); // 超えない
      }
      const stereo = {
        sampleRate: sr,
        numberOfChannels: 2,
        length,
        getChannelData: (c: number) => (c === 0 ? left : right),
      } as AudioLike;
      const r = limitTruePeak(stereo, { ceilingDb: ceiling, maxReductionDb: 12 });
      const i = Math.round(length / 2);
      const gl = r.buffer.getChannelData(0)[i] / left[i];
      const gr = r.buffer.getChannelData(1)[i] / right[i];
      check('左右に同じ倍率を当てる（定位を動かさない）', near(gl, gr, 1e-6) && gl < 0.95, `${gl.toFixed(4)} / ${gr.toFixed(4)}`);
    }

    // ⑪ 端の素材で落ちない。**空・1 標本・先読みより短い**の 3 つ。
    {
      const empty = { sampleRate: sr, numberOfChannels: 1, length: 0, getChannelData: () => new Float32Array(0) } as AudioLike;
      const one = { sampleRate: sr, numberOfChannels: 1, length: 1, getChannelData: () => Float32Array.of(1) } as AudioLike;
      const shortOne = sine(200, 0.001, 0); // 先読み 10ms より短い
      const a = limitTruePeak(empty, { ceilingDb: ceiling });
      const b = limitTruePeak(one, { ceilingDb: ceiling, maxReductionDb: 12 });
      const c = limitTruePeak(shortOne, { ceilingDb: ceiling, maxReductionDb: 12 });
      check(
        '空・1 標本・先読みより短い素材でも落ちない',
        a.buffer.length === 0 && b.report.maxReductionDb > 0 && c.report.truePeakDb <= ceiling + 0.01,
        `1 標本 ${b.report.maxReductionDb.toFixed(2)}dB / 短い素材 ${c.report.truePeakDb.toFixed(2)} dBTP`,
      );
    }

    // ⑫ 計画の側と噛み合っていること。リミッタに通す前提を渡すと、
    //    **ピークで止まっていた素材が目標へ届く。** ここが今回の狙いそのもの。
    {
      // 土台 -14dBFS ＋ 打撃 0.9 で、足りないぶんが 4.60dB（上限 6dB の内側）になる。
      const buffer = withSpike(0.5, 0.9, -14);
      const m = measureLoudness(buffer);
      const plain = planLoudnessNormalization(m, { targetLufs: -14, truePeakCeilingDb: ceiling });
      const withLimiter = planLoudnessNormalization(m, {
        targetLufs: -14,
        truePeakCeilingDb: ceiling,
        limiterHeadroomDb: 6,
      });
      const out = limitTruePeak(applyGain(buffer, withLimiter.gain), {
        ceilingDb: ceiling,
        maxReductionDb: 6,
      });
      const after = measureLoudness(out.buffer);
      check(
        'リミッタに通す前提なら、ピークで止まっていた素材が目標へ届く',
        plain.limitedBy === 'peak' && withLimiter.limitedBy === 'none' && near(after.integratedLufs as number, -14, 0.2),
        `${plain.shortfallDb.toFixed(2)}dB 足りなかったものが ${(after.integratedLufs as number).toFixed(2)} LUFS へ`,
      );
      check(
        '通したあとも天井は守られている',
        after.truePeakDb <= ceiling + 0.01,
        `${after.truePeakDb.toFixed(2)} dBTP`,
      );
    }

    // ⑬ 既定は**リミッタを前提にしない**（`limiterHeadroomDb` は 0）。
    //    ここが勝手に変わると、`lufs.ts` だけを使っている呼び出しが黙って歪む。
    {
      const m = measureLoudness(withSpike(0.5, 0.9, -14));
      const plan = planLoudnessNormalization(m, { targetLufs: -14, truePeakCeilingDb: ceiling });
      check(
        '既定ではリミッタを前提にしない（従来どおりピークで止まる）',
        DEFAULT_NORMALIZATION.limiterHeadroomDb === 0 && plan.limitedBy === 'peak' && plan.neededReductionDb === 0,
        `${plan.limitedBy}`,
      );
    }
  }

  // --- 長尺のリミッタ（区間ごとに流す形。2026-10-02）---
  //
  // ここで確かめたいのは「それらしく動くか」ではない。**一括とビット単位で同じか**だけ。
  // 一括のほうは 2026-09-19〜20 に測って既定を決めた側なので、
  // 流す形がそこから 1 ビットでも動いたら、決めた既定の根拠がそのぶん崩れる。
  // 近いかどうかではなく `!==` で数えているのは、そういう意味。
  {
    const sr = 48000;

    const mono = (length: number, fill: (i: number) => number, rate = sr) => {
      const data = new Float32Array(length);
      for (let i = 0; i < length; i += 1) data[i] = fill(i);
      return { sampleRate: rate, numberOfChannels: 1, length, getChannelData: () => data } as AudioLike;
    };
    /** 土台の正弦波に、指定の位置だけ天井を超える打点を置く。 */
    const withHits = (length: number, hits: number[], rate = sr) => {
      const data = new Float32Array(length);
      for (let i = 0; i < length; i += 1) data[i] = 0.3 * Math.sin((2 * Math.PI * 180 * i) / rate);
      for (const at of hits) for (let k = 0; k < 24 && at + k < length; k += 1) data[at + k] += 1.7 * Math.exp(-k / 8);
      return { sampleRate: rate, numberOfChannels: 1, length, getChannelData: () => data } as AudioLike;
    };
    /** 出口を 1 標本ずつ突き合わせて、違う標本の数を返す。 */
    const sampleDiff = (a: AudioLike, b: AudioLike) => {
      let n = 0;
      for (let c = 0; c < a.numberOfChannels; c += 1) {
        const A = a.getChannelData(c);
        const B = b.getChannelData(c);
        for (let i = 0; i < a.length; i += 1) if (A[i] !== B[i]) n += 1;
      }
      return n;
    };

    // ① 区間版の真のピークの列が、一括の列と**どの範囲でも**一致する。
    //    ここがずれると、以降の「同じ」は全部意味を失う（倍率の素がずれているので）。
    {
      const data = withHits(4000, [0, 7, 11, 12, 1999, 3988, 3999]).getChannelData(0);
      const whole = truePeakEnvelope(data);
      let worst = 0;
      for (const [from, to] of [
        [0, 4000],
        [0, 1],
        [0, 13],
        [11, 12],
        [12, 13],
        [1000, 1001],
        [1000, 2000],
        [3987, 4000],
        [3999, 4000],
      ] as [number, number][]) {
        const part = truePeakEnvelopeRange(data, 0, data.length, from, to);
        for (let j = from; j < to; j += 1) worst = Math.max(worst, Math.abs(part[j - from] - whole[j]));
      }
      check('真のピークの列は、区間で作っても一括と同じ', worst === 0, `いちばん大きいずれ ${worst}`);
    }

    // ② 切れ端だけを渡しても同じ（**素材ぜんたいの長さ**を渡すのが肝）。
    //    ここを切れ端の長さで判断すると、継ぎ目が全部「素材の端」になって値が下がる。
    {
      const data = withHits(4000, [500, 1500, 2500]).getChannelData(0);
      const whole = truePeakEnvelope(data);
      const from = 1200;
      const to = 1800;
      const dataFrom = from - TP_CONTEXT.back;
      const part = truePeakEnvelopeRange(data.subarray(dataFrom, to + TP_CONTEXT.forward), dataFrom, data.length, from, to);
      let worst = 0;
      for (let j = from; j < to; j += 1) worst = Math.max(worst, Math.abs(part[j - from] - whole[j]));
      // のりしろを 1 標本削ると断ること（黙って小さい値を返さない）。
      let threw = false;
      try {
        truePeakEnvelopeRange(data.subarray(dataFrom + 1, to + TP_CONTEXT.forward), dataFrom + 1, data.length, from, to);
      } catch {
        threw = true;
      }
      check('切れ端から作っても同じで、のりしろが足りなければ断る', worst === 0 && threw, `ずれ ${worst} / 断った ${threw}`);
    }

    // ③ 列の入れ物を使い回しても、前の値が残らない。
    {
      const data = withHits(2000, [100, 900]).getChannelData(0);
      const into = new Float64Array(2000);
      into.fill(99); // 前の区間の値が残っている状態を作る
      const a = truePeakEnvelopeRange(data, 0, data.length, 0, 500, into);
      const b = truePeakEnvelopeRange(data, 0, data.length, 1000, 1500, into);
      const refA = truePeakEnvelopeRange(data, 0, data.length, 0, 500);
      const refB = truePeakEnvelopeRange(data, 0, data.length, 1000, 1500);
      let ok = a.length === 500 && b.length === 500;
      for (let i = 0; i < 500; i += 1) if (b[i] !== refB[i]) ok = false;
      // a は b で上書きされている（使い回しの約束どおり）。先に写しを取れば残る。
      check('列の入れ物を使い回しても前の値が残らない', ok && refA.length === 500, `${ok}`);
    }

    // ④ **本題。** 流す形が一括とビット単位で同じ。区間を極端に振り、
    //    **打点が区間の継ぎ目に乗る位置**も混ぜる（継ぎ目は 0.25 秒ごとなので 12000 標本）。
    {
      const length = Math.round(1 * sr);
      const buffer = withHits(length, [0, 11999, 12000, 12001, 23999, length - 1]);
      const ref = limitTruePeak(buffer, { maxReductionDb: 12 });
      const tried: string[] = [];
      let diff = 0;
      let reportDiff = 0;
      for (const blockSeconds of [1 / sr, 2 / sr, 0.001, 0.01, 0.25, 0.5, 1, 10]) {
        const got = limitTruePeakInBlocks(buffer, { maxReductionDb: 12, blockSeconds });
        diff += sampleDiff(ref.buffer, got.buffer);
        if (JSON.stringify(ref.report) !== JSON.stringify(got.report)) reportDiff += 1;
        tried.push(`${blockSeconds}`);
      }
      check(
        '流す形は一括とビット単位で同じ（区間を 1 標本から素材より長くまで振る）',
        diff === 0 && reportDiff === 0,
        `${tried.length} 通り / 違う標本 ${diff} / 違う報告 ${reportDiff}`,
      );
    }

    // ⑤ 2ch でも同じ（左右に同じ倍率を当てる話が、区間に割っても崩れていないこと）。
    {
      const length = Math.round(0.4 * sr);
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        left[i] = 0.9 * Math.sin((2 * Math.PI * 120 * i) / sr);
        right[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / sr);
      }
      const stereo = {
        sampleRate: sr,
        numberOfChannels: 2,
        length,
        getChannelData: (c: number) => (c === 0 ? left : right),
      } as AudioLike;
      const ref = limitTruePeak(stereo, { maxReductionDb: 12 });
      let diff = 0;
      for (const blockSeconds of [0.003, 0.05, 0.4]) {
        diff += sampleDiff(ref.buffer, limitTruePeakInBlocks(stereo, { maxReductionDb: 12, blockSeconds }).buffer);
      }
      check('2ch でも流す形は一括と同じ', diff === 0, `違う標本 ${diff}`);
    }

    // ⑥ 標本の速さと先読み・戻りを振っても同じ（つまみごとに状態の持ち越し方が変わるので）。
    {
      let diff = 0;
      let cases = 0;
      for (const rate of [44100, 48000, 96000]) {
        for (const lookAheadMs of [0, 1, 20]) {
          for (const releaseMs of [5, 200]) {
            const length = Math.round(0.2 * rate);
            const buffer = withHits(length, [0, 37, Math.round(length / 2), length - 3], rate);
            const opt = { lookAheadMs, releaseMs, maxReductionDb: 12 };
            const ref = limitTruePeak(buffer, opt);
            diff += sampleDiff(ref.buffer, limitTruePeakInBlocks(buffer, { ...opt, blockSeconds: 0.05 }).buffer);
            cases += 1;
          }
        }
      }
      check('速さ・先読み・戻りを振っても同じ', diff === 0, `${cases} 通り / 違う標本 ${diff}`);
    }

    // ⑦ 端の素材。**空・1 標本・先読みより短い・区間が素材より長い**の 4 つ。
    {
      const empty = { sampleRate: sr, numberOfChannels: 1, length: 0, getChannelData: () => new Float32Array(0) } as AudioLike;
      const one = mono(1, () => 1);
      const shorter = mono(Math.round(0.001 * sr), (i) => 1.5 * Math.sin((2 * Math.PI * 300 * i) / sr));
      let blocks = 0;
      const emptyReport = limitTruePeakStream(blockSourceOf(empty), () => { blocks += 1; }, {});
      const refEmpty = limitTruePeak(empty, {});
      const pairs: [string, AudioLike][] = [['1 標本', one], ['先読みより短い', shorter]];
      let diff = 0;
      for (const [, buffer] of pairs) {
        const ref = limitTruePeak(buffer, { maxReductionDb: 12 });
        for (const blockSeconds of [1 / sr, 0.0005, 100]) {
          diff += sampleDiff(ref.buffer, limitTruePeakInBlocks(buffer, { maxReductionDb: 12, blockSeconds }).buffer);
        }
      }
      check(
        '空・1 標本・先読みより短い素材でも、流す形は一括と同じ',
        diff === 0 && blocks === 0 && JSON.stringify(emptyReport) === JSON.stringify(refEmpty.report),
        `違う標本 ${diff} / 空のときに渡した区間 ${blocks}`,
      );
    }

    // ⑧ 入り口が約束を破ったら断る（短く返す `read` を黙って受けると、無音を混ぜて通してしまう）。
    {
      const base = blockSourceOf(mono(Math.round(0.1 * sr), (i) => 1.4 * Math.sin((2 * Math.PI * 200 * i) / sr)));
      let threw = false;
      try {
        limitTruePeakStream({ ...base, read: (from, to) => base.read(from, Math.max(from, to - 1)) }, () => {}, {
          blockSeconds: 0.01,
        });
      } catch {
        threw = true;
      }
      check('read が頼んだ長さを返さなければ断る', threw, `${threw}`);
    }

    // ⑨ `read` は**前へ進む方向にしか呼ばれない**（デコーダをそのまま繋げる根拠）。
    //    のりしろは入れ物の中で持ち回すので、同じ標本を二度読まない。
    {
      const length = Math.round(0.5 * sr);
      const base = blockSourceOf(withHits(length, [100, 12000, 24000]));
      const calls: [number, number][] = [];
      limitTruePeakStream(
        { ...base, read: (from, to) => { calls.push([from, to]); return base.read(from, to); } },
        () => {},
        { blockSeconds: 0.02 },
      );
      let forward = true;
      let read = 0;
      for (let i = 0; i < calls.length; i += 1) {
        read += calls[i][1] - calls[i][0];
        if (i > 0 && calls[i][0] < calls[i - 1][1]) forward = false;
      }
      check('read は前へ進む方向にしか呼ばれない（同じ標本を二度読まない）', forward && read === length, `${calls.length} 回 / ${read} 標本`);
    }

    // ⑩ 渡す列は**使い回す**（持ち続けると書き換わる）。
    //    これは制約だが、黙っていると「最後の区間だけが並んでいる」形で静かに壊れるので、
    //    約束として検算で固定しておく。
    {
      const length = Math.round(0.1 * sr);
      const buffer = withHits(length, [10, 2400]);
      const held: Float32Array[] = [];
      limitTruePeakStream(blockSourceOf(buffer), (blocks) => { held.push(blocks[0]); }, { blockSeconds: 0.02 });
      // 同じ入れ物が返ってきている（最後の区間だけ短いので眺めになる）。
      const sameBuffer = held.length > 2 && held[0].buffer === held[1].buffer;
      check('渡す列は使い回す（持ち続けるなら写しを取る）', sameBuffer, `${held.length} 区間 / 同じ入れ物 ${sameBuffer}`);
    }

    // ⑪ 区間の既定が動いていないこと（動かすと書き出しの刻みと合わなくなる）。
    check('区間の既定は 5 秒', DEFAULT_LIMITER_BLOCK_SECONDS === 5, `${DEFAULT_LIMITER_BLOCK_SECONDS}s`);

    // ⑫ 流した出口も天井を守っている（報告の値と、測り直した値の両方で）。
    {
      const length = Math.round(0.5 * sr);
      const buffer = withHits(length, [0, 4000, 12000, 12001, length - 1]);
      const out = limitTruePeakInBlocks(buffer, { maxReductionDb: 24, blockSeconds: 0.02 });
      const measured = 20 * Math.log10(truePeakOf(out.buffer.getChannelData(0)));
      check(
        '区間に割っても天井を超えない',
        measured <= DEFAULT_LIMITER.ceilingDb + 0.01 && out.report.truePeakDb <= DEFAULT_LIMITER.ceilingDb + 0.01,
        `測り直し ${measured.toFixed(4)} / 報告 ${out.report.truePeakDb.toFixed(4)} dBTP`,
      );
    }
  }

  // --- 長尺のラウドネスの測り（区間ごとに流す形。2026-10-02・2 回目）---
  //
  // ここも確かめたいのは「それらしく動くか」ではない。**一括とビット単位で同じか**だけ。
  // 一括のほうは規格の試験信号と突き合わせてある側（上の「ラウドネス（LUFS）」の節）なので、
  // 流す形がそこから 1 ビットでも動いたら、規格に合っているという根拠がそのぶん崩れる。
  //
  // **返ってくる 10 個の欄をぜんぶ見る。** `integratedLufs` だけ比べると、
  // 瞬間の最大やゲートの数がずれていても気づけない（そこは倍率の決め方に効く）。
  {
    const sr = 48000;

    const mono = (length: number, fill: (i: number) => number, rate = sr) => {
      const data = new Float32Array(length);
      for (let i = 0; i < length; i += 1) data[i] = fill(i);
      return { sampleRate: rate, numberOfChannels: 1, length, getChannelData: () => data } as AudioLike;
    };
    const multi = (length: number, channels: number, fill: (i: number, c: number) => number, rate = sr) => {
      const data: Float32Array[] = [];
      for (let c = 0; c < channels; c += 1) {
        const a = new Float32Array(length);
        for (let i = 0; i < length; i += 1) a[i] = fill(i, c);
        data.push(a);
      }
      return { sampleRate: rate, numberOfChannels: channels, length, getChannelData: (c: number) => data[c] } as AudioLike;
    };
    /** 土台の正弦波に、天井を超える打点をまばらに置いた素材。 */
    const hits = (length: number, every: number, rate = sr) =>
      mono(
        length,
        (i) => 0.4 * Math.sin((2 * Math.PI * 180 * i) / rate) + (i % every < 5 ? 1.3 : 0),
        rate,
      );
    const KEYS = [
      'integratedLufs',
      'momentaryMaxLufs',
      'shortTermMaxLufs',
      'samplePeakDb',
      'truePeakDb',
      'quietBlockLufs',
      'gatedBlocks',
      'droppedBlocks',
      'duration',
      'channels',
    ] as const;
    /** 違う欄の名前を返す（`null` どうしは同じ扱い）。 */
    const diffKeys = (a: LoudnessMeasurement, b: LoudnessMeasurement) =>
      KEYS.filter((k) => !(a[k] === b[k] || (a[k] === null && b[k] === null)));

    // ① K 特性を履歴ごと持ち越せば、区間に割っても**同じ列**になる。
    //    ここがずれると以降の「同じ」は全部意味を失う（二乗和の素がずれているので）。
    {
      const data = hits(4000, 977).getChannelData(0);
      const ref = applyKWeighting(data, sr);
      let worst = 0;
      let cases = 0;
      for (const block of [1, 7, 12, 13, 97, 1000, 4000]) {
        const got = new Float64Array(data.length);
        const state = newKWeightingState();
        const filters = kWeighting(sr);
        const work = new Float64Array(block);
        for (let o = 0; o < data.length; o += block) {
          const len = Math.min(block, data.length - o);
          for (let i = 0; i < len; i += 1) work[i] = data[o + i];
          applyKWeightingInto(work, len, filters, state);
          for (let i = 0; i < len; i += 1) got[o + i] = work[i];
        }
        for (let i = 0; i < data.length; i += 1) if (got[i] !== ref[i]) worst += 1;
        cases += 1;
      }
      check('K 特性は履歴を持ち越せば区間に割っても同じ列になる', worst === 0, `${cases} 通り / 違う標本 ${worst}`);
    }

    // ①' のりしろで重ねるだけでは**どれだけ重ねても 0 にならない**。
    //
    //    最初に書いた主張（「IIR は後ろへ無限に続くから合わない」）は**半分外れていた。**
    //    2 段目の極の大きさは 0.995024 なので、ずれは 1 標本ごとに 0.498% 減る。
    //    倍精度の床（1e-16）まで減るのに要るのは **7385 標本 ＝ 0.154 秒**で、
    //    実測もそこでずれが 6.4e-11 → 3.7e-13 へ落ちる。**つまり重ねれば収束はする。**
    //    合わないのはその先で、**3e-13 で止まって下がらない。**
    //    止まる床は、極が直流のすぐ近くにあるぶん丸め誤差が `1/(1-r)²` ＝ 4 万倍に
    //    増幅される値（1e-17 × 4e4 ≈ 4e-13）で、重ね方では消せない。
    //    **持ち越す形はこれが 0 になる。** 同じ順で同じ演算をするので、増幅する相手が無い。
    //
    //    （「単精度だと 13 秒でも 0.1 LU 級の誤差が積もる」と `lufs.ts` に書いてあるのも同じ根。）
    //
    //    区間の頭が素材の頭と重なると**一括そのもの**になって「合った」と嘘をつくので、
    //    そこは数えない。一度それで通した。
    {
      const data = hits(sr * 3, 4801).getChannelData(0);
      const ref = applyKWeighting(data, sr);
      const block = Math.round(0.25 * sr);
      const worst = (overlap: number) => {
        let n = 0;
        let max = 0;
        for (let o = block; o < data.length; o += block) {
          const from = Math.max(0, o - overlap);
          if (from === 0) continue; // 一括と同じになる区間は数えない
          const to = Math.min(data.length, o + block);
          const part = applyKWeighting(data.subarray(from, to), sr);
          for (let i = o; i < to; i += 1) {
            const d = Math.abs(part[i - from] - ref[i]);
            if (d > 0) n += 1;
            if (d > max) max = d;
          }
        }
        return { n, max };
      };
      const none = worst(0);
      const settled = worst(7400); // 0.154 秒ぶん（極の大きさから出した値）
      const more = worst(48000); // 1 秒。ここから先は下がらない
      check(
        'のりしろで重ねる形は、どれだけ重ねても 0 にならない（床は丸めの増幅で決まる）',
        none.n > 0 && settled.n > 0 && more.n > 0 && settled.max < none.max * 1e-9 && more.max > settled.max * 0.1,
        `重ねない ${none.max.toExponential(1)} → 0.15s ${settled.max.toExponential(1)} → 1s ${more.max.toExponential(1)}`,
      );
    }

    // ② 素材・つまみ・区間を振って、一括と**全欄が一致**する。
    {
      const cases: [string, AudioLike][] = [
        ['打点つき 1ch', hits(sr * 2 + 1234, 38400)],
        ['同じものを 2ch', multi(sr * 2 + 1234, 2, (i, c) => (0.4 * Math.sin((2 * Math.PI * 180 * i) / sr) + (i % 38400 < 5 ? 1.3 : 0)) * (c ? 0.82 : 1))],
        ['鳴りっぱなし', mono(sr * 4, (i) => 0.2 * Math.sin((2 * Math.PI * 997 * i) / sr))],
        ['間が長い（ゲートが落とす）', mono(sr * 6, (i) => (i % sr < sr / 10 ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr) : 0))],
        ['無音', mono(sr * 2, () => 0)],
      ];
      let bad = 0;
      let n = 0;
      const names = new Set<string>();
      for (const [name, buffer] of cases) {
        for (const monoAsDualMono of [false, true]) {
          for (const skipTruePeak of [false, true]) {
            const ref = measureLoudness(buffer, { monoAsDualMono, skipTruePeak });
            for (const blockSeconds of [1 / sr, 0.01, 0.1, 1, 5, Infinity]) {
              n += 1;
              const got = measureLoudnessStream(blockSourceOf(buffer), { monoAsDualMono, skipTruePeak, blockSeconds });
              const d = diffKeys(ref, got);
              if (d.length > 0) {
                bad += 1;
                names.add(`${name}:${d.join('・')}`);
              }
            }
          }
        }
      }
      check(
        '素材 5 本 × つまみ 4 通り × 区間 6 通りで、一括と全欄が一致する',
        bad === 0,
        `${n} 通り / 違い ${bad}${names.size > 0 ? `（${[...names].join(' / ')}）` : ''}`,
      );
    }

    // ③ **継ぎ目をあらゆる位置へずらす。** 2026-10-02（1 回目）に、
    //    区間が素材の長さをちょうど割り切るときだけ落ちる穴を踏んだので、ここは必ず書く。
    //    手間を抑えるために 4.8kHz で回す（0.1 秒の格子が 480 標本になるだけで、交わり方は同じ）。
    {
      const rate = 4800;
      const sweeps: [string, AudioLike][] = [
        ['格子をまたいで端切れが出る', hits(480 * 3 + 37, 481, rate)],
        ['格子をちょうど割り切る', hits(480 * 4, 97, rate)],
        ['0.1 秒より短い', mono(479, (i) => 0.9 * Math.sin((2 * Math.PI * 997 * i) / rate), rate)],
        ['打ち直す窓ちょうど（12 標本）', mono(12, (i) => (i % 2 ? 0.95 : -0.95), rate)],
        ['窓に満たない（11 標本）', mono(11, (i) => (i % 2 ? 0.95 : -0.95), rate)],
        ['長さ 0', mono(0, () => 0, rate)],
      ];
      let bad = 0;
      let n = 0;
      for (const [, buffer] of sweeps) {
        const ref = measureLoudness(buffer);
        const src = blockSourceOf(buffer);
        for (let b = 1; b <= Math.max(1, buffer.length); b += 1) {
          n += 1;
          if (diffKeys(ref, measureLoudnessStream(src, { blockSeconds: b / rate })).length > 0) bad += 1;
        }
      }
      check('継ぎ目を 1 標本きざみで総当たりしても一致する', bad === 0, `${n} 通り / 違い ${bad}`);
    }

    // ④ 標本化周波数を振っても同じ（K 特性はその場の周波数から作り直すので、
    //    係数が変わると履歴の持ち越し方も変わる）。
    {
      let bad = 0;
      let n = 0;
      for (const rate of [8000, 44100, 48000, 96000]) {
        const buffer = hits(Math.round(0.4 * rate), Math.round(0.08 * rate), rate);
        const ref = measureLoudness(buffer);
        for (const blockSeconds of [0.001, 0.05, 1]) {
          n += 1;
          if (diffKeys(ref, measureLoudnessStream(blockSourceOf(buffer), { blockSeconds })).length > 0) bad += 1;
        }
      }
      check('標本化周波数を振っても一致する', bad === 0, `${n} 通り / 違い ${bad}`);
    }

    // ⑤ 3ch 以上（重み 0 のチャンネルがある並び）でも一致する。
    //    **LFE は二乗和には入らないが、ピークには数える**という向きが、
    //    区間に割ったときも守られているか。
    {
      const length = sr + 777;
      const buffer = multi(length, 6, (i, c) => {
        if (c === 5) return 0.99 * Math.sin((2 * Math.PI * 40 * i) / sr); // LFE。重み 0
        return 0.2 * Math.sin((2 * Math.PI * (200 + c * 50) * i) / sr);
      });
      const ref = measureLoudness(buffer);
      let bad = 0;
      for (const blockSeconds of [0.01, 0.1, 1, Infinity]) {
        if (diffKeys(ref, measureLoudnessStream(blockSourceOf(buffer), { blockSeconds })).length > 0) bad += 1;
      }
      check(
        '重み 0 のチャンネル（LFE）があっても一致する。ピークには数え、二乗和には入れない',
        bad === 0 && ref.samplePeakDb > -1,
        `違い ${bad} / 標本の最大 ${ref.samplePeakDb.toFixed(2)} dBFS`,
      );
    }

    // ⑥ 入り口が約束を破ったら断る（短く返す `read` を黙って受けると、
    //    無音を混ぜたぶん小さく測って、**倍率を上げすぎる**向きに外れる）。
    {
      const base = blockSourceOf(hits(Math.round(0.3 * sr), 4801));
      let threw = false;
      try {
        measureLoudnessStream({ ...base, read: (from, to) => base.read(from, Math.max(from, to - 1)) }, { blockSeconds: 0.01 });
      } catch {
        threw = true;
      }
      check('read が頼んだ長さを返さなければ断る', threw, `${threw}`);
    }

    // ⑦ `read` は**前へ進む方向にしか呼ばれない**（デコーダをそのまま繋げる根拠）。
    //    打ち直す窓のためのりしろが要るが、それは入れ物の中で持ち回すので読み直さない。
    {
      const length = Math.round(0.5 * sr);
      const base = blockSourceOf(hits(length, 4801));
      const calls: [number, number][] = [];
      measureLoudnessStream(
        { ...base, read: (from, to) => { calls.push([from, to]); return base.read(from, to); } },
        { blockSeconds: 0.02 },
      );
      let forward = true;
      let read = 0;
      for (let i = 0; i < calls.length; i += 1) {
        read += calls[i][1] - calls[i][0];
        if (i > 0 && calls[i][0] < calls[i - 1][1]) forward = false;
      }
      check('read は前へ進む方向にしか呼ばれない（同じ標本を二度読まない）', forward && read === length, `${calls.length} 回 / ${read} 標本`);
    }

    // ⑧ 区間の既定は、リミッタとミックスの刻みに揃えてある（動かすと書き出しの流れで合わなくなる）。
    check(
      '区間の既定は 5 秒（リミッタと同じ）',
      DEFAULT_LOUDNESS_BLOCK_SECONDS === 5 && DEFAULT_LOUDNESS_BLOCK_SECONDS === DEFAULT_LIMITER_BLOCK_SECONDS,
      `${DEFAULT_LOUDNESS_BLOCK_SECONDS}s / リミッタ ${DEFAULT_LIMITER_BLOCK_SECONDS}s`,
    );

    // ⑨ 測ったものから倍率を決めるところまで繋いでも同じ（使う側の値がずれていないこと）。
    //    **流す形は素材を 2 回読む**（倍率は測り終わるまで決まらない）。
    //    そこは得ではなく取り替えなので、約束として書いておく。
    {
      const buffer = hits(sr * 3, 24000);
      const a = planLoudnessNormalization(measureLoudness(buffer), { limiterHeadroomDb: 12 });
      const b = planLoudnessNormalization(measureLoudnessStream(blockSourceOf(buffer), { blockSeconds: 0.1 }), {
        limiterHeadroomDb: 12,
      });
      check(
        '倍率を決めるところまで繋いでも同じ',
        a.gain === b.gain && a.limitedBy === b.limitedBy && a.neededReductionDb === b.neededReductionDb,
        `${a.gainDb.toFixed(6)} / ${b.gainDb.toFixed(6)} dB（${a.limitedBy}）`,
      );
    }
  }

  // --- クリップごとの音量合わせ（2026-09-20・2 回目）---
  //
  // ここで確かめたいのは「倍率が正しく出るか」だけではない。
  // **触らないと決めたクリップ（短い・無音）が、基準の計算にまで混ざっていないか**が肝で、
  // そこが漏れると「1 本足しただけで全体の倍率が動く」という形で静かに壊れる。
  {
    const sr = 8000;
    /** 指定した振幅で鳴りっぱなしの 1ch。クリップ 1 本ぶんの代わり。 */
    const steady = (seconds: number, amp: number): AudioLike =>
      makeTone(seconds, sr, [{ from: 0, to: seconds, amp }]);
    /** 無音（雑音も入れない）。「測れない」側の代表。 */
    const silent = (seconds: number): AudioLike => makeTone(seconds, sr, []);
    const joined = (buffers: AudioLike[]): AudioLike => {
      const total = buffers.reduce((sum, b) => sum + b.length, 0);
      const out = new Float32Array(total);
      let k = 0;
      for (const b of buffers) {
        const src = b.getChannelData(0);
        for (let i = 0; i < b.length; i += 1) out[k++] = src[i];
      }
      return { sampleRate: sr, numberOfChannels: 1, length: total, getChannelData: () => out };
    };
    const opts = { skipTruePeak: true };
    const match = (clips: ClipSource[], options = {}) => planClipMatch(measureClips(clips, opts), options);

    // ① `concatRanges` の端。範囲外・逆順・長さ 0 を渡しても落ちず、
    //    拾えるものが無ければ null を返す（呼ぶ側が「測らない」を選べるように）。
    {
      const buffer = steady(2, 0.5);
      const clipped = concatRanges(buffer, [{ start: -5, end: 1 }, { start: 1.5, end: 99 }]);
      const empty = concatRanges(buffer, [{ start: 1, end: 1 }, { start: 2, end: 0.5 }]);
      const none = concatRanges(buffer, []);
      check(
        '区間を繋ぐとき、範囲外は切り詰め、拾えなければ null を返す',
        clipped !== null && near(clipped.length, 1.5 * sr, 2) && empty === null && none === null,
        `${clipped ? (clipped.length / sr).toFixed(2) : '—'}s / 長さ0は ${empty === null ? 'null' : '値'}`,
      );
    }

    // ② 6dB 違う 2 本を揃えると、**当てたあとに測り直した値**が一致する。
    //    計画の値どうしを比べても意味が無い（それは引き算をやり直しただけ）。
    {
      const clips: ClipSource[] = [
        { id: 'loud', buffer: steady(2, 0.5) },
        { id: 'quiet', buffer: steady(2, 0.25) },
      ];
      const plan = match(clips);
      const after = applyClipGains(clips, plan).map((b) => measureLoudness(b, opts).integratedLufs as number);
      check(
        '6dB 違う 2 本を揃えると、当てたあとの実測が一致する',
        near(after[0], after[1], 0.05) && near(plan.spreadAfter, 0, 0.05),
        `${after[0].toFixed(2)} / ${after[1].toFixed(2)} LUFS`,
      );
      // 偶数本のときは**静かなほうの真ん中**へ寄せる。上げる側にだけ副作用があるので、
      // 迷ったら下げる向きへ倒す（`maxBoostDb` < `maxCutDb` と同じ考え方）。
      check(
        '偶数本のときは静かなほうへ寄せる（上げずに下げる）',
        plan.gains[0].gainDb < 0 && near(plan.gains[1].gainDb, 0, 1e-9),
        `${plan.gains[0].gainDb.toFixed(2)} / ${plan.gains[1].gainDb.toFixed(2)} dB`,
      );
    }

    // ③ 同じ群のクリップには同じ倍率が当たる。
    //    **自動カットが刻んだかけらを、切れ目ごとに段にしないための肝。**
    {
      const clips: ClipSource[] = [
        { id: 'a#0', buffer: steady(2, 0.5), group: 'a' },
        { id: 'a#1', buffer: steady(2, 0.125), group: 'a' },
        { id: 'b', buffer: steady(4, 0.25) },
      ];
      const plan = match(clips);
      check(
        '同じ群のかけらには、同じ倍率が当たる',
        plan.gains[0].gainDb === plan.gains[1].gainDb && plan.gains[0].group === 'a',
        `a: ${plan.gains[0].gainDb.toFixed(2)}dB（2 本とも）／ b: ${plan.gains[2].gainDb.toFixed(2)}dB`,
      );
    }

    // ④ 群をまとめた値が、**繋いで測り直した値**とどれだけ一致するか。
    //    パワーへ戻して窓の数で重み付けしているので理屈では一致するが、
    //    2 段目のゲートが群ぜんたいから引き直されるぶんだけずれる。**その幅を固定しておく。**
    {
      const parts = [steady(2, 0.5), steady(2, 0.125)];
      const grouped = groupClips(
        measureClips(
          parts.map((buffer, i) => ({ id: `p${i}`, buffer, group: 'g' })),
          opts,
        ),
      );
      const direct = measureLoudness(joined(parts), opts).integratedLufs as number;
      const diff = Math.abs((grouped[0].lufs as number) - direct);
      check(
        '群をまとめた値は、繋いで測り直した値と一致する',
        grouped.length === 1 && diff < 0.5,
        `まとめて ${(grouped[0].lufs as number).toFixed(2)} / 繋いで ${direct.toFixed(2)} LUFS（差 ${diff.toFixed(3)}）`,
      );
    }

    // ⑤ 上限。要求が上限を超えたら `cap` で止まり、**本当に欲しかった値は残る**
    //    （ここが消えると「どれくらい外れたクリップなのか」が外から見えなくなる）。
    {
      const clips: ClipSource[] = [
        { id: 'normal-a', buffer: steady(4, 0.5) },
        { id: 'normal-b', buffer: steady(4, 0.5) },
        { id: 'far', buffer: steady(4, 0.002) },
      ];
      const plan = match(clips, { maxBoostDb: 12 });
      const far = plan.gains.find((g) => g.id === 'far') as (typeof plan.gains)[number];
      check(
        '上限を超える要求は cap で止まり、欲しかった値は残る',
        far.limitedBy === 'cap' && near(far.gainDb, 12, 1e-9) && far.wantedDb > 30,
        `欲しかった ${far.wantedDb.toFixed(2)}dB → 当てた ${far.gainDb.toFixed(2)}dB`,
      );
      check(
        '上限は上げる側のほうが狭い（持ち上げにだけ代価がある）',
        DEFAULT_CLIP_MATCH.maxBoostDb < DEFAULT_CLIP_MATCH.maxCutDb,
        `上げ ${DEFAULT_CLIP_MATCH.maxBoostDb}dB / 下げ ${DEFAULT_CLIP_MATCH.maxCutDb}dB`,
      );
    }

    // ⑥ 短いクリップ・無音のクリップは触らない。**しかも基準を動かさない。**
    //    相づち 1 つぶんのクリップに基準を決めさせると、全体が静かに傾く。
    {
      const base: ClipSource[] = [
        { id: 'a', buffer: steady(4, 0.5) },
        { id: 'b', buffer: steady(4, 0.4) },
        { id: 'c', buffer: steady(4, 0.3) },
      ];
      const before = match(base).referenceLufs as number;
      const withOddments = match([
        ...base,
        { id: 'tiny', buffer: steady(0.2, 0.001) },
        { id: 'silence', buffer: silent(4) },
      ]);
      const tiny = withOddments.gains.find((g) => g.id === 'tiny') as (typeof withOddments.gains)[number];
      const silence = withOddments.gains.find((g) => g.id === 'silence') as (typeof withOddments.gains)[number];
      check(
        '短いクリップと無音のクリップは触らない（理由も取り違えない）',
        tiny.limitedBy === 'tooShort' &&
          tiny.gainDb === 0 &&
          silence.limitedBy === 'unmeasurable' &&
          silence.gainDb === 0,
        `${tiny.limitedBy} / ${silence.limitedBy}`,
      );
      check(
        '触らないクリップは、基準の計算にも入らない',
        near(withOddments.referenceLufs as number, before, 1e-9),
        `${before.toFixed(3)} → ${(withOddments.referenceLufs as number).toFixed(3)} LUFS`,
      );
    }

    // ⑦ 基準を数値で直に渡したときは、そこへ合わせる（絶対の目標を使いたい呼び出し向け）。
    {
      const clips: ClipSource[] = [{ id: 'a', buffer: steady(4, 0.5) }];
      const plan = match(clips, { reference: -20, maxBoostDb: 48, maxCutDb: 48 });
      const after = measureLoudness(applyClipGains(clips, plan)[0], opts).integratedLufs as number;
      check(
        '基準を数値で渡すと、その LUFS へ合う',
        near(after, -20, 0.05),
        `${after.toFixed(2)} LUFS`,
      );
    }

    // ⑧ 中央値は**尺で重みを付ける**。短いクリップが 2 本あっても、長い 1 本に負けない。
    {
      const clips: ClipSource[] = [
        { id: 'short-a', buffer: steady(1, 0.5) },
        { id: 'short-b', buffer: steady(1, 0.5) },
        { id: 'long', buffer: steady(20, 0.05) },
      ];
      const plan = match(clips, { maxCutDb: 48 });
      const long = plan.gains.find((g) => g.id === 'long') as (typeof plan.gains)[number];
      check(
        '中央値は尺で重みを付ける（短い 2 本より長い 1 本）',
        near(long.gainDb, 0, 1e-9) && plan.gains[0].gainDb < -15,
        `長い 1 本 ${long.gainDb.toFixed(2)}dB ／ 短いほう ${plan.gains[0].gainDb.toFixed(2)}dB`,
      );
    }

    // ⑨ 外れ値への強さ。**引きずられるのは静かな外れ値ではなく、大きいほう**
    //    （2026-09-20・2 回目に素材で測って、書く前の見込みが外れた。ここに固定しておく）。
    {
      const plain: ClipSource[] = [0, 1, 2, 3, 4].map((i) => ({ id: `n${i}`, buffer: steady(4, 0.1) }));
      const refOf = (clips: ClipSource[], mode: 'median' | 'mean') =>
        match(clips, { reference: mode }).referenceLufs as number;
      const quiet = [...plain, { id: 'quiet', buffer: steady(4, 0.003) }];
      const loud = [...plain, { id: 'loud', buffer: steady(4, 0.9) }];
      // もっと静かな 1 本。**どれだけ静かでも動く幅は同じ**はず（下の検算）。
      const quieter = [...plain, { id: 'quieter', buffer: steady(4, 0.001) }];
      // ゲート（-70 LUFS）より下の 1 本。ここまで来ると数から外れるので、薄めることすらしない。
      const belowGate = [...plain, { id: 'below', buffer: steady(4, 0.00003) }];
      const dMedianQuiet = Math.abs(refOf(quiet, 'median') - refOf(plain, 'median'));
      const dMeanQuiet = Math.abs(refOf(quiet, 'mean') - refOf(plain, 'mean'));
      const dMeanQuieter = Math.abs(refOf(quieter, 'mean') - refOf(plain, 'mean'));
      const dMeanLoud = Math.abs(refOf(loud, 'mean') - refOf(plain, 'mean'));
      check(
        '静かな外れ値は平均をほとんど動かさない（動かすのは大きいほう）',
        dMeanQuiet < 1 && dMeanLoud > 5,
        `平均が動いた幅: 静かな 1 本 ${dMeanQuiet.toFixed(3)} LU / 大きい 1 本 ${dMeanLoud.toFixed(2)} LU`,
      );
      // **静かな 1 本が平均を動かすのは、その音の大きさのせいではない。**
      // パワーをほとんど足さずに重みの合計だけを増やすので、下がる幅は 10log₁₀((n+1)/n) ちょうど。
      // 本数だけで決まるので、**素材を 43 本並べたときの 0.10 LU も、これで説明がつく。**
      // 「声の無いクリップが混じると平均が下がる」を**大きさの話だと読んでいたのが間違い**だった。
      const dilution = 10 * Math.log10(6 / 5);
      check(
        '静かな外れ値が平均を下げる幅は、音の大きさではなく本数で決まる',
        near(dMeanQuiet, dilution, 0.01) && near(dMeanQuieter, dilution, 0.01),
        `-30dB で ${dMeanQuiet.toFixed(3)} / -40dB で ${dMeanQuieter.toFixed(3)} / 10log₁₀(6/5) = ${dilution.toFixed(3)} LU`,
      );
      // ゲートより下へ落ちると、その 1 本は**数からも外れる**ので薄めない。
      // つまり平均が動く幅は「静かさ」に対して単調ではなく、**ゲートで切れて 0 に戻る。**
      const dMeanBelow = Math.abs(refOf(belowGate, 'mean') - refOf(plain, 'mean'));
      check(
        'ゲートより下の 1 本は、平均を薄めることすらしない',
        dMeanBelow < 1e-9,
        `${dMeanBelow.toFixed(3)} LU（-70 LUFS の線より下）`,
      );
      check(
        '中央値はどちらの外れ値にも動かない',
        dMedianQuiet < 1e-9 && Math.abs(refOf(loud, 'median') - refOf(plain, 'median')) < 1e-9,
        `${dMedianQuiet.toFixed(3)} LU`,
      );
    }

    // ⑩ **中央値が守ってくれるのは「まともなクリップが過半数」のときだけ。**
    //    外れ値が過半数を占めると中央値そのものが外れ値に乗る（画面の検算で踏んだ）。
    //    直せる手が無いので、**そうなることを固定して、画面から人へ知らせる**形にしてある。
    {
      const normal = steady(4, 0.5);
      const faint = steady(4, 0.02);
      const fainter = steady(4, 0.005);
      // ふつう 1 本 ＋ 外れ値 2 本 → 中央値は外れ値の側へ乗り、**ふつうのほうが下げられる。**
      const outnumbered = match([
        { id: 'normal', buffer: normal },
        { id: 'faint', buffer: faint },
        { id: 'fainter', buffer: fainter },
      ], { maxCutDb: 48, maxBoostDb: 48 });
      // ふつう 3 本 ＋ 外れ値 2 本 → 中央値はふつうの側に乗る。
      const majority = match([
        { id: 'n1', buffer: normal },
        { id: 'n2', buffer: normal },
        { id: 'n3', buffer: normal },
        { id: 'faint', buffer: faint },
        { id: 'fainter', buffer: fainter },
      ], { maxCutDb: 48, maxBoostDb: 48 });
      const cutNormal = outnumbered.gains.find((g) => g.id === 'normal') as (typeof outnumbered.gains)[number];
      const keptNormal = majority.gains.find((g) => g.id === 'n1') as (typeof majority.gains)[number];
      check(
        '外れ値が過半数を占めると、中央値もそちらへ乗る（直せないので固定しておく）',
        cutNormal.gainDb < -20 && near(keptNormal.gainDb, 0, 1e-9),
        `外れ値が過半数: ふつうの声が ${cutNormal.gainDb.toFixed(1)}dB ／ 過半数がふつう: ${keptNormal.gainDb.toFixed(1)}dB`,
      );
      // 画面が知らせるのに使っている手がかり（「半分以上が上限に当たった」）が立つことも見ておく。
      const capped = match(
        [
          { id: 'normal', buffer: normal },
          { id: 'faint', buffer: faint },
          { id: 'fainter', buffer: fainter },
        ],
        { maxCutDb: 6, maxBoostDb: 6 },
      ).gains.filter((g) => g.limitedBy === 'cap');
      check(
        '基準がずれた並びでは、半分以上が上限に当たる（画面はこれを手がかりに知らせる）',
        capped.length * 2 >= 3,
        `3 本中 ${capped.length} 本`,
      );
    }

    // ⑪ `edits.ts` との継ぎ目。**1 本の素材から出たかけらは、全部が同じ倍率を受け取る。**
    //    ここが崩れると切れ目のたびに部屋の音が段になるので、通しで押さえておく。
    {
      const quiet = steady(6, 0.1);
      const loud = steady(6, 0.4);
      const clips: ClipSource[] = [
        { id: 'take-a', buffer: quiet },
        { id: 'take-b', buffer: loud },
      ];
      const plan = match(clips);
      // 1 本の素材を 3 つに割った体で `toClipEdits` に通す（カットの結果に相当）。
      const keep = [
        { start: 0.5, end: 2 },
        { start: 2.5, end: 4 },
        { start: 4.5, end: 5.5 },
      ];
      const edits = toClipEdits(keep, { start: 0, duration: 6, sourceIn: 0 });
      // **倍率が 0 でない側で確かめる。** 静かなほうは 0dB になるので、
      // 配れていなくても通ってしまい、検算にならない。
      const matched = attachClipGains(edits, 'take-b', plan);
      const want = plan.gains.find((g) => g.id === 'take-b') as (typeof plan.gains)[number];
      check(
        'かけらは全部、その素材ぶんの同じ倍率を受け取る（edits.ts との継ぎ目）',
        matched.length === 3 &&
          want.gainDb < -1 &&
          matched.every((m) => m.gainDb === want.gainDb && m.group === 'take-b') &&
          matched[0].from.start === 0.5,
        `${matched.length} 本とも ${matched[0].gainDb.toFixed(2)}dB`,
      );
      // **知らない群を渡されたら 1 倍にする。** 黙って別の群の倍率を当てると、
      // 画面では揃ったように見えて音だけが違う、という壊れ方をする。
      const unknown = attachClipGains(edits, 'take-z', plan);
      check(
        '計画に無い群を渡されたら、黙って他人の倍率を当てない',
        unknown.every((m) => m.gain === 1 && m.gainDb === 0 && m.limitedBy === 'unmeasurable'),
        `${unknown[0].gainDb.toFixed(2)}dB / ${unknown[0].limitedBy}`,
      );
    }

    // ⑫ 測り直さずに計画できる（画面は読み込んだときの 1 回しか測らない）。
    {
      const buffer = steady(4, 0.25);
      const direct = planClipMatch(measureClips([{ id: 'a', buffer }], opts), { reference: -20 });
      const reused = planClipMatch([clipLoudnessFrom('a', measureLoudness(buffer, opts))], { reference: -20 });
      check(
        '測ってある結果を渡しても、測り直したときと同じ倍率になる',
        near(direct.gains[0].gainDb, reused.gains[0].gainDb, 1e-9),
        `${direct.gains[0].gainDb.toFixed(3)} / ${reused.gains[0].gainDb.toFixed(3)} dB`,
      );
    }

    // ⑬ 素材が無いとき・全部測れないときでも落ちない（画面から空のまま押されることがある）。
    {
      const emptyPlan = planClipMatch([], {});
      const allSilent = match([
        { id: 'a', buffer: silent(4) },
        { id: 'b', buffer: silent(4) },
      ]);
      check(
        '空のとき・全部測れないときでも落ちず、倍率は 1 倍',
        emptyPlan.referenceLufs === null &&
          emptyPlan.gains.length === 0 &&
          allSilent.referenceLufs === null &&
          allSilent.gains.every((g) => g.gain === 1 && g.limitedBy === 'unmeasurable'),
        `空 ${emptyPlan.gains.length} 本 / 無音だけ ${allSilent.gains.length} 本`,
      );
    }
  }

  // --- 長尺のクリップごとの音量合わせ（流す形。2026-10-03）---
  //
  // 確かめたいのは「それらしく動くか」ではない。**一括とビット単位で同じか**だけ。
  // 一括の側は上の節（2026-09-20・2 回目）で振る舞いを固定してあるので、
  // 流す形がそこから 1 ビットでも動いたら、固定してある意味がそのぶん消える。
  //
  // あわせて、**流す形でしか起きない壊れ方**を 3 つ固定する——
  // 繋いだ入り口が元を後ろ向きに読むこと、倍率を元の列へ直に掛けてしまうこと、
  // 区間の切り方で値が動くこと。
  {
    const sr = 8000;
    const steady = (seconds: number, amp: number): AudioLike =>
      makeTone(seconds, sr, [{ from: 0, to: seconds, amp }]);
    /** 土台の音に、天井を超える打点をまばらに置いた素材（真のピークを動かす相手）。 */
    const hits = (seconds: number, amp: number): AudioLike => {
      const base = steady(seconds, amp);
      const data = base.getChannelData(0);
      const copy = new Float32Array(data.length);
      copy.set(data);
      for (let i = 0; i < copy.length; i += 1) if (i % 977 < 3) copy[i] += 1.1;
      return { sampleRate: sr, numberOfChannels: 1, length: copy.length, getChannelData: () => copy };
    };
    const KEYS = [
      'integratedLufs',
      'momentaryMaxLufs',
      'shortTermMaxLufs',
      'samplePeakDb',
      'truePeakDb',
      'quietBlockLufs',
      'gatedBlocks',
      'droppedBlocks',
      'duration',
      'channels',
    ] as const;
    const sameMeasurement = (a: LoudnessMeasurement | null, b: LoudnessMeasurement | null) =>
      a !== null && b !== null && KEYS.every((k) => a[k] === b[k] || (a[k] === null && b[k] === null));
    /** `BlockSource` を丸ごと起こす（波そのものを突き合わせるため）。 */
    const drain = (source: BlockSource, block: number) => {
      const out: Float32Array[] = [];
      for (let c = 0; c < source.numberOfChannels; c += 1) out.push(new Float32Array(source.length));
      for (let o = 0; o < source.length; o += block) {
        const to = Math.min(source.length, o + block);
        const got = source.read(o, to);
        for (let c = 0; c < source.numberOfChannels; c += 1) out[c].set(got[c], o);
      }
      return out;
    };

    // ① 一括と流す形で、クリップ 1 本ずつの測りが**ぜんぶの欄で**一致する。
    {
      const clips: ClipSource[] = [
        { id: 'loud', buffer: hits(2, 0.5) },
        { id: 'quiet', buffer: steady(2, 0.25) },
        { id: 'tiny', buffer: steady(0.2, 0.5) }, // 窓が 1 つも立たない短さ
        { id: 'mute', buffer: makeTone(1.5, sr, []) },
      ];
      const streamed: ClipStreamSource[] = clips.map((c) => ({ id: c.id, source: blockSourceOf(c.buffer) }));
      let bad = 0;
      let cases = 0;
      for (const blockSeconds of [0.01, 0.1, 0.37, 1, 5, Infinity]) {
        const a = measureClips(clips, {});
        const b = measureClipsStream(streamed, { blockSeconds });
        for (let i = 0; i < a.length; i += 1) {
          cases += 1;
          if (
            a[i].id !== b[i].id ||
            a[i].group !== b[i].group ||
            a[i].lufs !== b[i].lufs ||
            a[i].duration !== b[i].duration ||
            a[i].gatedBlocks !== b[i].gatedBlocks ||
            !sameMeasurement(a[i].measurement, b[i].measurement)
          ) {
            bad += 1;
          }
        }
      }
      check(
        'クリップごとの測りは、流しても一括とぜんぶの欄で一致する',
        bad === 0,
        `${cases} 通り / 違い ${bad}`,
      );
    }

    // ② 倍率も同じになる（測りが同じなら当たり前だが、**群のまとめ方を通した先**まで見る）。
    {
      const clips: ClipSource[] = [
        { id: 'a1', buffer: steady(2, 0.5), group: 'a' },
        { id: 'a2', buffer: steady(2, 0.45), group: 'a' },
        { id: 'b1', buffer: steady(2, 0.125), group: 'b' },
      ];
      const streamed: ClipStreamSource[] = clips.map((c) => ({ id: c.id, source: blockSourceOf(c.buffer), group: c.group }));
      const whole = planClipMatch(measureClips(clips, {}), {});
      const flow = planClipMatch(measureClipsStream(streamed, { blockSeconds: 0.3 }), {});
      check(
        '群をまとめた先の倍率も、流す形と一括で同じ',
        whole.referenceLufs === flow.referenceLufs &&
          whole.gains.every((g, i) => g.gainDb === flow.gains[i].gainDb && g.limitedBy === flow.gains[i].limitedBy),
        `基準 ${whole.referenceLufs?.toFixed(3)} / ${flow.referenceLufs?.toFixed(3)} LUFS`,
      );
    }

    // ③ 区間を繋いだ波そのものが、一括の `concatRanges` と**1 標本も違わない。**
    //    区間の切り方（読む幅）を振っても動かない——ここが動くと、繋ぎ目をまたぐ読みが壊れている。
    {
      const buffer = hits(3, 0.4);
      const ranges = [
        { start: 0.17, end: 0.53 },
        { start: 0.53, end: 0.54 }, // 隣とくっついた区間（長さ 1 標本に近い）
        { start: 1.1, end: 2.37 },
        { start: 2.9, end: 3.4 }, // 後ろがはみ出す
      ];
      const want = concatRanges(buffer, ranges) as AudioLike;
      const got = concatRangesSource(blockSourceOf(buffer), ranges) as BlockSource;
      let bad = 0;
      let cases = 0;
      for (const block of [1, 2, 11, 64, 999, 1 << 20]) {
        const planes = drain(got, block);
        cases += 1;
        if (planes[0].length !== want.length) bad += 1;
        else for (let i = 0; i < want.length; i += 1) if (planes[0][i] !== want.getChannelData(0)[i]) bad += 1;
      }
      check(
        '区間を繋いだ波は、流しても一括と 1 標本も違わない（読む幅を振っても）',
        bad === 0 && got.length === want.length,
        `${cases} 通り / ${want.length} 標本 / 違い ${bad}`,
      );
    }

    // ④ 繋いだ入り口の上で測った値も、一括の繋いだ列を測った値とぜんぶの欄で一致する。
    {
      const buffer = hits(4, 0.4);
      const ranges = [
        { start: 0.0, end: 1.23 },
        { start: 1.8, end: 2.0 },
        { start: 2.05, end: 3.97 },
      ];
      const want = measureLoudness(concatRanges(buffer, ranges) as AudioLike, {});
      let bad = 0;
      let cases = 0;
      for (const blockSeconds of [0.01, 0.1, 0.4, 1, Infinity]) {
        const src = concatRangesSource(blockSourceOf(buffer), ranges) as BlockSource;
        cases += 1;
        if (!sameMeasurement(want, measureLoudnessStream(src, { blockSeconds }))) bad += 1;
      }
      check(
        '繋いだ入り口の上の測りは、繋いだ列の測りと一致する',
        bad === 0,
        `${cases} 通り / 違い ${bad}`,
      );
    }

    // ⑤ **繋いだ入り口は、元を前へしか読まない。**
    //    `BlockSource` の約束（`loudness.ts`）がここで破れると、デコーダを繋いだ瞬間に壊れる。
    //    一括の列の上では絶対に出ない壊れ方なので、ここで固定しておく。
    {
      const buffer = hits(3, 0.4);
      let back = 0;
      let last = 0;
      const watched: BlockSource = {
        sampleRate: sr,
        numberOfChannels: 1,
        length: buffer.length,
        read(from, to) {
          if (from < last) back += 1;
          last = to;
          return [buffer.getChannelData(0).subarray(from, to)];
        },
      };
      const src = concatRangesSource(watched, [
        { start: 0.1, end: 0.9 },
        { start: 1.0, end: 1.05 },
        { start: 2.2, end: 3.0 },
      ]) as BlockSource;
      measureLoudnessStream(src, { blockSeconds: 0.07 });
      check('繋いだ入り口も、元を前へしか読まない', back === 0, `後ろ向きの読み ${back} 回`);
    }

    // ⑥ 後ろ向き・重なりのある並びは、**その場で落とす。**
    //    黙って並べ替えると繋ぎ目の位置が変わり、値だけが静かに違うものになる。
    //    一括の `concatRanges` はそのまま通る（列を作るので読む向きが無い）ので、逃げ道はある。
    {
      const buffer = steady(3, 0.4);
      const back = [
        { start: 2.0, end: 2.5 },
        { start: 0.5, end: 1.0 },
      ];
      const overlap = [
        { start: 0.5, end: 1.5 },
        { start: 1.0, end: 2.0 },
      ];
      const threw = (ranges: { start: number; end: number }[]) => {
        try {
          concatRangesSource(blockSourceOf(buffer), ranges);
          return false;
        } catch {
          return true;
        }
      };
      const wholeBack = concatRanges(buffer, back);
      check(
        '後ろ向き・重なりのある並びは流せないと断る（一括は通る）',
        threw(back) && threw(overlap) && wholeBack !== null && wholeBack.length === Math.round(sr),
        `流す形 ${threw(back) ? '断る' : '通す'} / 一括 ${wholeBack ? (wholeBack.length / sr).toFixed(2) : '—'}s`,
      );
    }

    // ⑥' **自動カットが返す区間は、この縛りをもともと守っている。**
    //    縛りを足した以上、実際に使う側が引っかからないことまで見ておく
    //    （引っかかるなら、縛りではなく設計のほうが間違っている）。
    {
      const voice = makeTone(6, sr, [
        { from: 0.2, to: 1.1, amp: 0.5 },
        { from: 2.0, to: 2.9, amp: 0.45 },
        { from: 4.3, to: 5.6, amp: 0.5 },
      ]);
      const ranges = planJetCut(analyzeLoudness(voice), {}).keep;
      let bad = 0;
      for (let i = 1; i < ranges.length; i += 1) if (ranges[i].start < ranges[i - 1].end) bad += 1;
      const src = concatRangesSource(blockSourceOf(voice), ranges);
      check(
        '自動カットが返す区間は昇順で重ならない（そのまま流せる）',
        ranges.length > 1 && bad === 0 && src !== null,
        `${ranges.length} 区間 / 逆転 ${bad}`,
      );
    }

    // ⑦ **倍率を当てる入り口は、元の列を書き換えない。**
    //    `blockSourceOf` は元の `Float32Array` の `subarray` を返すので、
    //    `a[i] *= gain` と書くと元の素材が静かに育つ（2 回測ると 2 回掛かる）。
    //    その場で書き換える形も並べて、**壊れることまで**見せておく。
    {
      const buffer = steady(1, 0.4);
      const base = blockSourceOf(buffer);
      const safe = gainSource(base, 0.5);
      const first = measureLoudnessStream(safe, { blockSeconds: 0.1 }).integratedLufs;
      const second = measureLoudnessStream(safe, { blockSeconds: 0.1 }).integratedLufs;
      const raw = measureLoudness(buffer, {}).integratedLufs;
      // その場で書き換える形（やってはいけないほう）。
      const unsafe: BlockSource = {
        sampleRate: sr,
        numberOfChannels: 1,
        length: buffer.length,
        read(from, to) {
          const got = base.read(from, to);
          for (const a of got) for (let i = 0; i < a.length; i += 1) a[i] *= 0.5;
          return got;
        },
      };
      const u1 = measureLoudnessStream(unsafe, { blockSeconds: 0.1 }).integratedLufs as number;
      const u2 = measureLoudnessStream(unsafe, { blockSeconds: 0.1 }).integratedLufs as number;
      check(
        '倍率の入り口は元を書き換えない（その場で掛ける形は 2 回目が 6dB 下がる）',
        first === second && near((first as number) - (raw as number), -6.0206, 0.01) && near(u2 - u1, -6.0206, 0.01),
        `安全 ${first?.toFixed(3)} → ${second?.toFixed(3)} / 危険 ${u1.toFixed(3)} → ${u2.toFixed(3)} LUFS`,
      );
    }

    // ⑧ クリップを繋いだ入り口（＝タイムライン）が、一括で繋いだ列と一致する。
    //    倍率を当ててから繋ぐ順も、一括の `applyClipGains` → `concatRanges` と同じになる。
    {
      const clips: ClipSource[] = [
        { id: 'a', buffer: hits(1.3, 0.5) },
        { id: 'b', buffer: steady(0.9, 0.2) },
        { id: 'c', buffer: hits(2.1, 0.35) },
      ];
      const streamed: ClipStreamSource[] = clips.map((c) => ({ id: c.id, source: blockSourceOf(c.buffer) }));
      const plan = planClipMatch(measureClips(clips, {}), {});
      const wholeTimeline = applyClipGains(clips, plan);
      const total = wholeTimeline.reduce((sum, b) => sum + b.length, 0);
      const wantData = new Float32Array(total);
      let k = 0;
      for (const b of wholeTimeline) {
        wantData.set(b.getChannelData(0), k);
        k += b.length;
      }
      const flow = concatSources(applyClipGainSources(streamed, plan)) as BlockSource;
      let bad = 0;
      for (const block of [1, 13, 500, 1 << 20]) {
        const planes = drain(flow, block);
        for (let i = 0; i < total; i += 1) if (planes[0][i] !== wantData[i]) bad += 1;
      }
      const wantM = measureLoudness(
        { sampleRate: sr, numberOfChannels: 1, length: total, getChannelData: () => wantData },
        {},
      );
      const gotM = measureLoudnessStream(concatSources(applyClipGainSources(streamed, plan)) as BlockSource, {
        blockSeconds: 0.3,
      });
      check(
        '倍率を当てて繋いだタイムラインが、一括と 1 標本も違わない',
        bad === 0 && flow.length === total && sameMeasurement(wantM, gotM),
        `${total} 標本 / 違い ${bad} / ${wantM.integratedLufs?.toFixed(3)} LUFS`,
      );
    }

    // ⑨ 端。拾えるものが無ければ `null`、形の違うものを繋ごうとしたら落とす、
    //    1 標本だけの区間でも落ちない（繋ぎ目が全部「端」になる形）。
    {
      const buffer = steady(1, 0.4);
      const none = concatRangesSource(blockSourceOf(buffer), []);
      const empty = concatRangesSource(blockSourceOf(buffer), [{ start: 1, end: 1 }, { start: 2, end: 0.5 }]);
      const nothing = concatSources([]);
      let mismatch = false;
      try {
        concatSources([blockSourceOf(buffer), blockSourceOf(makeTone(1, 16000, [{ from: 0, to: 1 }]))]);
      } catch {
        mismatch = true;
      }
      const single = concatRangesSource(blockSourceOf(buffer), [
        { start: 0.1, end: 0.1 + 1 / sr },
        { start: 0.5, end: 0.5 + 1 / sr },
        { start: 0.8, end: 0.8 + 1 / sr },
      ]) as BlockSource;
      const planes = drain(single, 1);
      const src0 = buffer.getChannelData(0);
      // 外へはみ出した読みは、黙って断片の列から落ちずにその場で落とす。
      const outside = (() => {
        const src = concatRangesSource(blockSourceOf(buffer), [{ start: 0.1, end: 0.2 }]) as BlockSource;
        let caught = 0;
        for (const [a, b] of [[-1, 10], [0, src.length + 1], [src.length - 1, src.length + 5]]) {
          try {
            src.read(a, b);
          } catch {
            caught += 1;
          }
        }
        return caught === 3;
      })();
      check(
        '端（空・形違い・1 標本の区間・外へはみ出した読み）でも落ちない',
        none === null &&
          empty === null &&
          nothing === null &&
          mismatch &&
          single.length === 3 &&
          outside &&
          planes[0][0] === src0[Math.round(0.1 * sr)] &&
          planes[0][2] === src0[Math.round(0.8 * sr)],
        `空 ${none === null ? 'null' : '値'} / 形違い ${mismatch ? '断る' : '通す'} / 1 標本 ×3 = ${single.length} / はみ出し ${outside ? '断る' : '通す'}`,
      );
    }

    // ⑨' **倍率で包んでも、同じ元を 2 回並べたことは見つかる。**
    //    ここを素通りさせると、**倍率がたまたま 1 倍のときだけ見つかる／見つからない**という
    //    いちばん嫌な形になる（差分を読み直していて気づいた穴）。
    {
      const buffer = steady(1, 0.4);
      const twice = (gain: number) => {
        const base = blockSourceOf(buffer);
        try {
          concatSources([gainSource(base, gain), gainSource(base, gain)]);
          return false;
        } catch {
          return true;
        }
      };
      // 包まずに 2 回並べても同じ（こちらは元から見つかる）。
      const bare = (() => {
        const base = blockSourceOf(buffer);
        try {
          concatSources([base, base]);
          return false;
        } catch {
          return true;
        }
      })();
      check(
        '倍率で包んでも、同じ元を 2 回並べたことは見つかる（1 倍でも）',
        twice(1) && twice(0.5) && bare,
        `1 倍 ${twice(1) ? '断る' : '通す'} / 0.5 倍 ${twice(0.5) ? '断る' : '通す'} / 包まない ${bare ? '断る' : '通す'}`,
      );
    }

    // ⑩ **繋ぎ目を 1 標本きざみで総当たり。** 2026-10-02（1 回目）に、区間が長さを
    //    割り切るときだけ落ちる穴を踏んだので、ここは端を疑って全部踏む。
    {
      const buffer = hits(0.5, 0.4); // 4000 標本
      const ranges = [
        { start: 0.05, end: 0.21 },
        { start: 0.3, end: 0.47 },
      ];
      const want = measureLoudness(concatRanges(buffer, ranges) as AudioLike, {});
      const wantData = (concatRanges(buffer, ranges) as AudioLike).getChannelData(0);
      let bad = 0;
      let cases = 0;
      for (let block = 1; block <= 400; block += 1) {
        const src = concatRangesSource(blockSourceOf(buffer), ranges) as BlockSource;
        cases += 1;
        if (!sameMeasurement(want, measureLoudnessStream(src, { blockSeconds: block / sr }))) bad += 1;
        const planes = drain(concatRangesSource(blockSourceOf(buffer), ranges) as BlockSource, block);
        for (let i = 0; i < wantData.length; i += 1) {
          if (planes[0][i] !== wantData[i]) {
            bad += 1;
            break;
          }
        }
      }
      check(
        '繋ぎ目を 1 標本きざみで総当たりしても、値も波も動かない',
        bad === 0,
        `${cases} 通り（幅 1〜400 標本）/ 違い ${bad}`,
      );
    }

    // ---- 0.1 秒ごとの二乗和を持ち出して、「繋いで測り直す」1 周を省く（2026-10-03・2 回目） ----
    //
    // 道すじの 3 周めを省くには、**ゲートの手前の値**を持ち出すしかない
    // （ゲートを通したあとの値からは組み立て直せないことは 1 回目に測って確定した）。
    // ここで固定するのは 4 つ——**既定を 1 欄も動かしていないこと**、
    // **繋いで測り直したのと合うこと**、**格子の手当てが実際に要ること**、
    // **残る誤差が K 特性の履歴だけで、低い帯域にしか出ないこと**。

    const step = Math.round(0.1 * sr); // 800
    /** 25Hz の正弦波。K 特性の 2 段目（38Hz）の尾がいちばん長く残る相手。 */
    const low = (seconds: number, amp: number): AudioLike => {
      const L = Math.round(seconds * sr);
      const d = new Float32Array(L);
      for (let i = 0; i < L; i += 1) d[i] = amp * Math.sin((2 * Math.PI * 25 * i) / sr + Math.PI / 2);
      return { sampleRate: sr, numberOfChannels: 1, length: L, getChannelData: () => d };
    };
    /** クリップを並べて、繋いだタイムラインを 1 本の列にする。 */
    const timelineOf = (clips: ClipSource[]) => {
      const plan = planClipMatch(measureClips(clips, {}), {});
      const gained = applyClipGains(clips, plan);
      const total = gained.reduce((sum, b) => sum + b.length, 0);
      const data = new Float32Array(total);
      let k = 0;
      for (const b of gained) {
        data.set(b.getChannelData(0), k);
        k += b.length;
      }
      return {
        plan,
        buffer: { sampleRate: sr, numberOfChannels: 1, length: total, getChannelData: () => data } as AudioLike,
      };
    };

    // ⑪ `carryForTimeline` を立てても、**クリップ単体の測りは 1 欄も動かない。**
    //    持ち出しは「ついでに数える」だけなので、ここが動いたら作りを間違えている。
    {
      const clips: ClipSource[] = [
        { id: 'a', buffer: hits(1.347, 0.5) },
        { id: 'b', buffer: steady(0.9, 0.2) },
        { id: 'c', buffer: low(2.047, 0.6) },
      ];
      const plainWhole = measureClips(clips, {});
      const carriedWhole = measureClips(clips, { carryForTimeline: true });
      const streamed: ClipStreamSource[] = clips.map((c) => ({ id: c.id, source: blockSourceOf(c.buffer) }));
      const plainStream = measureClipsStream(streamed, { blockSeconds: 0.37 });
      const carriedStream = measureClipsStream(streamed, { blockSeconds: 0.37, carryForTimeline: true });
      let bad = 0;
      for (let i = 0; i < clips.length; i += 1) {
        if (!sameMeasurement(plainWhole[i].measurement, carriedWhole[i].measurement)) bad += 1;
        if (!sameMeasurement(plainStream[i].measurement, carriedStream[i].measurement)) bad += 1;
        if (plainWhole[i].measurement?.carry !== null) bad += 1; // 既定では持ち出さない
        if (carriedWhole[i].measurement?.carry === null) bad += 1;
      }
      check(
        '二乗和を持ち出しても、クリップ単体の測りは 1 欄も動かない（既定では持ち出さない）',
        bad === 0,
        `${clips.length} 本 × 一括と流す形 / 違い ${bad}`,
      );
    }

    // ⑫ 一括と流す形で、持ち出した列が**ビット単位で同じ**。
    //    区間の切り方で足す順が変わると最後の桁が動くので、継ぎ目を踏む幅を並べる。
    {
      const clips: ClipSource[] = [
        { id: 'a', buffer: hits(1.347, 0.5) },
        { id: 'b', buffer: low(2.047, 0.6) },
      ];
      const want = measureClips(clips, { carryForTimeline: true });
      let bad = 0;
      let cases = 0;
      for (const blockSeconds of [0.01, 0.1, 0.13, 0.37, 1, Infinity]) {
        const got = measureClipsStream(
          clips.map((c) => ({ id: c.id, source: blockSourceOf(c.buffer) })),
          { blockSeconds, carryForTimeline: true },
        );
        for (let i = 0; i < clips.length; i += 1) {
          cases += 1;
          const a = want[i].measurement!.carry!;
          const b = got[i].measurement!.carry!;
          if (a.lead !== b.lead || a.length !== b.length || a.head !== b.head || a.tail !== b.tail) bad += 1;
          else if (a.full.length !== b.full.length) bad += 1;
          else for (let k = 0; k < a.full.length; k += 1) if (a.full[k] !== b.full[k]) bad += 1;
        }
      }
      check(
        '持ち出した二乗和が、一括と流す形でビット単位で同じ（区間の幅を振る）',
        bad === 0,
        `${cases} 通り / 違い ${bad}`,
      );
    }

    // ⑬ **格子を合わせれば、繋いで測り直したのと合う。**
    //    尺を半端にしても（＝升がクリップの頭で振り出しに戻る形でも）合うことが肝。
    {
      const sets: { name: string; clips: ClipSource[] }[] = [
        {
          name: '升の倍数',
          clips: [
            { id: 'a', buffer: hits(1.6, 0.5) },
            { id: 'b', buffer: steady(0.8, 0.2) },
            { id: 'c', buffer: hits(2.4, 0.35) },
          ],
        },
        {
          name: '半端',
          clips: [
            { id: 'a', buffer: hits(1.347, 0.5) },
            { id: 'b', buffer: steady(0.913, 0.2) },
            { id: 'c', buffer: hits(2.047, 0.35) },
          ],
        },
        {
          name: '1 升より短いのが混ざる',
          clips: [
            { id: 'a', buffer: hits(1.347, 0.5) },
            { id: 'tiny', buffer: steady(0.05, 0.4) },
            { id: 'b', buffer: steady(0.913, 0.2) },
            { id: 'tiny2', buffer: steady(0.03, 0.4) },
            { id: 'c', buffer: hits(2.047, 0.35) },
          ],
        },
      ];
      let worst = 0;
      const detail: string[] = [];
      for (const set of sets) {
        const { plan, buffer } = timelineOf(set.clips);
        const exact = measureLoudness(buffer, {});
        const measured = measureClips(set.clips, { carryForTimeline: true });
        const got = measureTimelineFromClips(measured, plan, {
          joinTruePeak: joinTruePeak(
            set.clips.map((c) => blockSourceOf(c.buffer)),
            plan.gains.map((g) => g.gain),
          ),
        });
        const diff = Math.abs((got.integratedLufs as number) - (exact.integratedLufs as number));
        if (diff > worst) worst = diff;
        // 升の数と真のピークも合っていること（どちらも黙ってずれる側）。
        const blocks = got.gatedBlocks + got.droppedBlocks === exact.gatedBlocks + exact.droppedBlocks;
        const peak = near(got.truePeakDb, exact.truePeakDb, 1e-9);
        if (!blocks || !peak) worst = Infinity;
        detail.push(`${set.name} ${diff.toFixed(4)} LU${blocks ? '' : '・升の数がずれ'}${peak ? '' : '・ピークがずれ'}`);
      }
      check(
        '格子を合わせて繋げば、繋いで測り直したのと 0.01 LU 以内で合う（升の数も真のピークも一致）',
        worst <= 0.01,
        detail.join(' / '),
      );
    }

    // ⑭ **格子の手当ては、実際に要る。** 手当てしない（lead を全部 0 にする）と、
    //    末尾の端切れが落ちて升が減り、値もずれる。**要らないものを足していない**ことの裏取り。
    {
      let worstLost = 0;
      let worstDiff = 0;
      /**
       * **後ろ 1 升だけ大きい**素材。落ちる端切れがちょうどそこに当たるので、
       * 「升が減る」が値にそのまま出る。平らな素材だと落ちても平均が動かないので見えない
       * （＝**ずれの大きさは素材しだい。構造として升が減ることのほうが確か**）。
       */
      const backLoud = (seconds: number, amp: number): AudioLike => {
        const L = Math.round(seconds * sr);
        const d = new Float32Array(L);
        for (let i = 0; i < L; i += 1) {
          d[i] = amp * (i >= L - step ? 1 : 0.02) * Math.sin((2 * Math.PI * 400 * i) / sr);
        }
        return { sampleRate: sr, numberOfChannels: 1, length: L, getChannelData: () => d };
      };
      // 端切れの幅で効きが変わる（升の切れ目をどこで踏み外すかで変わる）ので、何通りか振る。
      for (const extra of [0.2, 0.4, 0.6, 0.75, 0.9]) {
        const seconds = (8 * step + Math.round(extra * step)) / sr;
        const clips: ClipSource[] = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, buffer: backLoud(seconds, 0.5) }));
        const { plan, buffer } = timelineOf(clips);
        const exact = measureLoudness(buffer, {});
        const plain = measureClips(clips, { carryLead: 0 });
        const naive = combineClipCarries(
          plain.map((m, i) => ({
            carry: { ...m.measurement!.carry!, tail: 0, length: Math.floor(m.measurement!.carry!.length / step) * step },
            gain: plan.gains[i].gain,
            measurement: m.measurement!,
          })),
        );
        worstLost = Math.max(worstLost, exact.gatedBlocks + exact.droppedBlocks - (naive.gatedBlocks + naive.droppedBlocks));
        worstDiff = Math.max(worstDiff, Math.abs((naive.integratedLufs as number) - (exact.integratedLufs as number)));
      }
      check(
        '格子を合わせないと升が減り、値もずれる（＝手当ては要る）',
        worstLost > 0 && worstDiff > 0.1,
        `升が最大 ${worstLost} 個減り、最大 ${worstDiff.toFixed(3)} LU ずれる`,
      );
    }

    // ⑮ **残るのは K 特性の履歴だけで、それは低い帯域にしか出ない。**
    //    25Hz（2 段目の折れ点の下）と 500Hz を同じ刻み方で並べて、桁が変わることを固定する。
    {
      const run = (make: (seconds: number, amp: number) => AudioLike) => {
        const clips: ClipSource[] = Array.from({ length: 16 }, (_, i) => ({
          id: `c${i}`,
          buffer: make(0.4, 0.9),
        }));
        const { plan, buffer } = timelineOf(clips);
        const exact = measureLoudness(buffer, {});
        const got = measureTimelineFromClips(measureClips(clips, { carryForTimeline: true }), plan);
        return Math.abs((got.integratedLufs as number) - (exact.integratedLufs as number));
      };
      const mid = (seconds: number, amp: number): AudioLike => {
        const L = Math.round(seconds * sr);
        const d = new Float32Array(L);
        for (let i = 0; i < L; i += 1) d[i] = amp * Math.sin((2 * Math.PI * 500 * i) / sr + Math.PI / 2);
        return { sampleRate: sr, numberOfChannels: 1, length: L, getChannelData: () => d };
      };
      const lowDiff = run(low);
      const midDiff = run(mid);
      check(
        '残る誤差は低い帯域にしか出ない（25Hz と 500Hz で桁が変わる）',
        lowDiff > midDiff * 5 && midDiff < 0.01,
        `25Hz ${lowDiff.toFixed(4)} LU 対 500Hz ${midDiff.toFixed(4)} LU`,
      );
    }

    // ⑯ **繋ぎ目をまたぐ窓は、前後 11 標本だけで拾える。**
    //    クリップごとの最大では段差が入らない（位相差 0.5π で 1.07dB 低く出る）。
    {
      const tone = (seconds: number, amp: number, phase: number): AudioLike => {
        const L = Math.round(seconds * sr);
        const d = new Float32Array(L);
        for (let i = 0; i < L; i += 1) d[i] = amp * Math.sin((2 * Math.PI * 997 * i) / sr + phase);
        return { sampleRate: sr, numberOfChannels: 1, length: L, getChannelData: () => d };
      };
      let worst = 0;
      let gap = 0;
      for (const phase of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
        const clips: ClipSource[] = [
          { id: 'a', buffer: tone(1, 0.9, 0) },
          { id: 'b', buffer: tone(1, 0.9, phase) },
        ];
        const { plan, buffer } = timelineOf(clips);
        const exact = measureLoudness(buffer, {});
        const measured = measureClips(clips, { carryForTimeline: true });
        const sources = clips.map((c) => blockSourceOf(c.buffer));
        const gains = plan.gains.map((g) => g.gain);
        const withJoin = measureTimelineFromClips(measured, plan, { joinTruePeak: joinTruePeak(sources, gains) });
        const without = measureTimelineFromClips(measured, plan);
        worst = Math.max(worst, Math.abs(withJoin.truePeakDb - exact.truePeakDb));
        gap = Math.max(gap, exact.truePeakDb - without.truePeakDb);
      }
      check(
        '繋ぎ目をまたぐ窓を前後 11 標本で拾える（拾わないと真のピークが低く出る）',
        worst < 1e-9 && gap > 0.5,
        `拾えば差 ${worst.toExponential(1)} dB / 拾わないと最大 ${gap.toFixed(4)} dB 低い`,
      );
    }

    // ⑰ 端。**黙って 1 升ずれるほうが、落ちるより悪い**ので門にしてある。
    {
      const a = hits(1.347, 0.5);
      const b = steady(0.913, 0.2);
      const ma = measureLoudness(a, { carryLead: 0 });
      const mb = measureLoudness(b, { carryLead: 0 }); // 本当は a の尺から決まる lead が要る
      const part = (m: LoudnessMeasurement) => ({ carry: m.carry!, gain: 1, measurement: m });
      const threw = (fn: () => unknown) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      const wrongLead = threw(() => combineClipCarries([part(ma), part(mb)]));
      const emptyParts = threw(() => combineClipCarries([]));
      const badRate = threw(() =>
        measureClips(
          [
            { id: 'a', buffer: a },
            {
              id: 'b',
              buffer: { sampleRate: sr * 2, numberOfChannels: 1, length: 100, getChannelData: () => new Float32Array(100) },
            },
          ],
          { carryForTimeline: true },
        ),
      );
      const badLeadValue = threw(() => measureLoudness(a, { carryLead: step }));
      const noCarry = threw(() => measureTimelineFromClips(measureClips([{ id: 'a', buffer: a }], {}), planClipMatch(measureClips([{ id: 'a', buffer: a }], {}), {})));
      // 1 本だけ・lead が 0 の形は素直に通る（繋ぎ目が無いので升の手当ても要らない）。
      const one = (() => {
        const clips: ClipSource[] = [{ id: 'a', buffer: a }];
        const { plan, buffer } = timelineOf(clips);
        const exact = measureLoudness(buffer, {});
        const got = measureTimelineFromClips(measureClips(clips, { carryForTimeline: true }), plan, {
          joinTruePeak: joinTruePeak([blockSourceOf(a)], [1]),
        });
        // ピークの 2 欄は**倍率を dB で足して線形へ戻している**ので、往復ぶんの端数が出る
        // （値そのものではなく最後の桁の話なので、ここだけ `near` で見る）。
        return (
          exact.integratedLufs === got.integratedLufs &&
          exact.gatedBlocks === got.gatedBlocks &&
          exact.droppedBlocks === got.droppedBlocks &&
          near(got.samplePeakDb, exact.samplePeakDb, 1e-9) &&
          near(got.truePeakDb, exact.truePeakDb, 1e-9)
        );
      })();
      // `truePeakAcrossJoin` は 11 標本より短い列を渡しても落ちない（またぐ窓が無ければ 0）。
      const tiny = truePeakAcrossJoin(new Float32Array(3).fill(0.5), new Float32Array(0));
      check(
        '端を門にしてある（並びと合わない lead・空・周波数ちがい・範囲外・carry 無し）',
        wrongLead && emptyParts && badRate && badLeadValue && noCarry && one && Number.isFinite(tiny),
        `lead ${wrongLead ? '断る' : '通す'} / 空 ${emptyParts ? '断る' : '通す'} / Hz ${badRate ? '断る' : '通す'} / ` +
          `範囲外 ${badLeadValue ? '断る' : '通す'} / carry 無し ${noCarry ? '断る' : '通す'} / 1 本 ${one ? '一致' : 'ずれ'} / 短い列 ${tiny}`,
      );
    }

    // ⑱ `clipCarryLeads` が「前のクリップの升の残り」をそのまま返す。
    {
      // 1 本目は升ちょうど → 次も 0。2 本目は 1 標本余るので 3 本目は step-1。
      // 3 本目まで足すと余りは 4 なので、4 本目は step-4。
      const leads = clipCarryLeads([step, step + 1, 3, step * 2 - 4], step);
      const ok = leads[0] === 0 && leads[1] === 0 && leads[2] === step - 1 && leads[3] === step - 4;
      check('`clipCarryLeads` が前のクリップの升の残りを返す', ok, leads.join(' / '));
    }
  }


  return results;
}
