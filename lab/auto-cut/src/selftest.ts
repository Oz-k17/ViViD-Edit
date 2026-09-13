/**
 * 合成した波形で、計算そのものが正しいかを確かめる。
 * 素材を用意しなくても壊れていないことが分かるように、画面から実行できるようにしてある。
 */

import { analyzeLoudness, toDb, type AudioLike, type LoudnessTrack } from './loudness.ts';
import { autoThresholdDb, DEFAULT_JET_CUT, planJetCut } from './silence.ts';
import { gainAt, planDucking } from './ducking.ts';
import { toClipEdits } from './edits.ts';
import { buildPeaks } from './peaks.ts';
import { analyzeFeatures, centroidDescentRatio, modulationRatio } from './features.ts';
import { fftScratch, magnitudes } from './fft.ts';

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
    const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0 };
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
    const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0, minKeep: 0 };
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
  }

  return results;
}
