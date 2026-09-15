/**
 * 試し用の音を作る。
 *
 *   npm run lab:fixtures          # 短いものを一式
 *   npm run lab:fixtures -- long  # 長尺（10 分）も作る
 *
 * 素材を手で用意しなくても試せるようにするため、そして
 * **毎回まったく同じ音が出る**ようにするために置いている。
 * 乱数に種を固定してあるので、「昨日は 38% 削れた／今日は 41% 削れた」を
 * そのまま比べられる。Math.random を使うとそれができない。
 *
 * 出力は lab/fixtures/out/（git には入れない）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORT_FIXTURES, SHORT_LENGTH, SPARSE_UTTERANCES, UTTERANCES } from './spec.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const SR = 44100;

/** 種を固定した擬似乱数（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeWav(name, samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SR, 24);
  bytes.writeUInt32LE(SR * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  const file = path.join(OUT, name);
  fs.writeFileSync(file, bytes);
  const seconds = samples.length / SR;
  console.log(`${name}  ${seconds.toFixed(1)} 秒  ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
  return file;
}

/**
 * 母音のつもりの共鳴（フォルマント）の居場所（Hz）。あ・い・う・え・お。
 *
 * 数字は日本語の母音のおおよその実測値から取った。正確さそのものより、
 * **母音どうしが F1・F2 の面の上で十分に離れている**ことが要る。
 * 近い所に固まっていると、母音が移り変わっても包絡がほとんど動かず、
 * 「声は音色が動く」という素材の狙いが立たない。
 */
const VOWELS = [
  [800, 1200, 2800], // あ
  [300, 2300, 3000], // い
  [350, 1250, 2200], // う
  [500, 1900, 2600], // え
  [500, 900, 2600], // お
];
/** 共鳴の幅（対数周波数での標準偏差）と高さ。高い共鳴ほど浅く、広く。 */
const FORMANT_WIDTH = [0.3, 0.35, 0.45];
const FORMANT_LEVEL = [1, 0.7, 0.35];

/** その周波数が共鳴でどれだけ持ち上がるか。対数周波数上のガウスを 3 つ重ねる。 */
function formantGain(hz, formants) {
  let gain = 0;
  for (let k = 0; k < formants.length; k += 1) {
    const d = Math.log(hz / formants[k]) / FORMANT_WIDTH[k];
    gain += FORMANT_LEVEL[k] * Math.exp(-d * d);
  }
  // 共鳴から外れた帯域も完全には消えない（息の成分）。0 にすると倍音が虫食いになる。
  return gain + 0.02;
}

/**
 * 一次の高域通過。子音の雑音を、その子音らしい高さへ寄せるために使う。
 *
 * 白色雑音をそのまま鳴らすと、`s` も `p` も同じ音になってしまう。
 * 摩擦音と破裂音を分けているのは主に**雑音の重心の高さ**なので、
 * そこだけは作り分けないと「子音を足した」ことにならない。
 * 素直な一次フィルタで足りる（帯域の形そのものではなく、重心の高低だけが要る）。
 */
function highpassState(cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  return { a: rc / (rc + 1 / SR), x1: 0, y1: 0, x2: 0, y2: 0 };
}

/** 一次を 2 段通す（1 段では肩がゆるすぎて、低い子音と高い子音が重なる）。 */
function highpass(state, x) {
  const y1 = state.a * (state.y1 + x - state.x1);
  state.x1 = x;
  state.y1 = y1;
  const y2 = state.a * (state.y2 + y1 - state.x2);
  state.x2 = y1;
  state.y2 = y2;
  return y2;
}

/**
 * そのフィルタが白色雑音の実効値をどれだけ落とすか。
 *
 * 測って割っておくと、下の `level` を**母音に対する実効値の比**として読める。
 * これをやらないと、子音の「音量」が帯域の指定に引きずられて、
 * 「摩擦音を強くしたのか、高く寄せたのか」が切り分けられなくなる。
 */
const highpassGains = new Map();
function highpassGain(cutoffHz) {
  const found = highpassGains.get(cutoffHz);
  if (found !== undefined) return found;
  const state = highpassState(cutoffHz);
  const random = rng(777);
  const n = 40000;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = highpass(state, (random() - 0.5) * 2);
    // 頭は過渡なので捨てる。
    if (i >= n / 2) sum += v * v;
  }
  const gain = Math.sqrt(sum / (n / 2));
  highpassGains.set(cutoffHz, gain);
  return gain;
}

/**
 * 子音の種類。**2026-09-12（2 回目）に足した。**
 *
 * それまでの合成の声は母音だけで、**息の雑音も子音も入っていなかった**。
 * 手で考えた手がかりが 5 つとも自作の楽器の素材に負けたあとで記録を読み直すと、
 * 破れた 5 つはどれも「音程・包絡・揺れ」しか見ていない。
 * **本物の話し声が楽器と決定的に違うのは、広い帯域に散る雑音の粒が混じること**で、
 * それは倍音を足して作った楽器の素材にはどれにも無い。
 * つまり**いちばん効きそうな手がかりを、素材が表現できないせいで一度も試せていなかった**。
 *
 * `length` は音節の頭に置く長さ（秒）、`cutoff` は雑音を寄せる高さ（Hz）、
 * `level` は母音の実効値に対する比。数字は実測値のおおよその範囲から取った
 * （摩擦音は母音より 10〜20dB 低く、破裂音はそれより短く強い）。
 * 正確さより、**種類どうしが zcr と重心の上で十分に離れている**ことが要る。
 *
 * `none` を 1 つ混ぜてあるのは、母音で始まる音節が現実にもあるため。
 * ここが 0 だと「必ず頭に雑音がある」という、現実より都合のよい声になる。
 */
const CONSONANTS = [
  { kind: 'fricative', length: 0.1, cutoff: 4500, level: 0.2 }, // s
  { kind: 'fricative', length: 0.09, cutoff: 2000, level: 0.26 }, // sh
  { kind: 'fricative', length: 0.07, cutoff: 1200, level: 0.13 }, // f・h（弱い）
  { kind: 'plosive', length: 0.035, cutoff: 3000, level: 0.42 }, // t・k
  { kind: 'plosive', length: 0.03, cutoff: 800, level: 0.34 }, // p・b
  { kind: 'none', length: 0, cutoff: 0, level: 0 }, // 母音で始まる音節
];

/** 息の雑音の量（母音の実効値に対する比）と、寄せる高さ（Hz）。 */
const BREATH_LEVEL = 0.05;
const BREATH_CUTOFF = 1500;

/**
 * 子音 1 サンプルぶんの包絡。
 *
 * 破裂音は「閉鎖（無音）→ 破裂（ごく短い雑音）→ 帯気（尾を引く雑音）」の 3 段にする。
 * **閉鎖の無音がいちばん効く**はず。母音の直前に 20ms ほど何も鳴らない所ができるので、
 * スペクトルの変化（flux）がそこで必ず跳ねる。平らな雑音を置くだけでは、そこが出ない。
 * 摩擦音は同じ長さを平らに鳴らし、立ち上がりと収まりだけ丸める。
 *
 * `length` は **その音節で実際に使える長さ**で、`c.length` とは別に渡す。
 * 短い音節では子音が半分に切り詰められるので、`c.length` で収まりを計算すると
 * **振幅いっぱいのまま途中で打ち切られて、そこがクリックになる**。
 * クリックは広い帯域に散る雑音なので、まさにいま測ろうとしている量（`zcr`・`flux`・平坦さ）を
 * 押し上げてしまう。「子音が効いた」の中身がクリックだったということになりかねないので、
 * 切り詰めた長さのほうで丸める。
 */
function consonantEnvelope(c, inside, length) {
  if (c.kind === 'plosive') {
    const closure = length * 0.55;
    if (inside < closure) return 0;
    const after = inside - closure;
    const burst = length * 0.15;
    return after < burst ? 1 : Math.exp(-(after - burst) / (length * 0.18));
  }
  // 立ち上がりと収まりは、切り詰めた長さの 1/4 を超えないようにする
  // （音節が極端に短いと、丸める余裕そのものが無くなる）。
  const edge = Math.min(0.02, length / 4);
  return Math.max(0, Math.min(1, inside / Math.min(0.012, length / 4), (length - inside) / edge));
}

/**
 * 声らしい音。倍音列に母音の共鳴を掛け、音節ごとに母音と音程を動かす。
 *
 * **2026-09-11 にここを作り直した。** それまでは倍音の重みも f0 も発話中ずっと固定で、
 * スペクトルの形の上では「トレモロのかかった楽器」とまったく同じものだった
 * （`music-tremolo.wav` を声と区別できない、という意味）。そのせいで
 * 「包絡が動いたら声」という判定を試そうにも、**素材のほうが先に破れて**いた。
 * 判定の限界ではなく素材の限界で止まっていたので、素材の側を直した。
 *
 * 本物の声に寄せたのは 3 つ。どれも「声とは何か」を測る手がかりに直に効く:
 *
 * - **音節ごとに母音が変わる**（`VOWELS` から選ぶ）。包絡が動く理由がここで生まれる。
 * - **音節の長さが揃っていない**（0.16〜0.32 秒）。以前は 4.2Hz ちょうどの正弦波で
 *   揺らしていたので、**楽器のトレモロと同じく等間隔**だった。「動きが規則正しすぎないか」で
 *   音楽と分ける手を試せなかったのは、素材のこの性質のせい。
 * - **f0 が動く**（発話の終わりに向かって下がる＋音節ごとの揺れ）。
 *
 * `flat: true` を渡すと 2026-09-11 以前の平板な声に戻る。
 * 乱数の消費数も当時と同じ（f0 の 1 回だけ）なので、**同じ種なら 1 ビットも変わらない**。
 * 記録に残した過去の数字を測り直したくなったときのために残してある。
 *
 * `sustain: true` は、母音を長く伸ばしてしゃべる（0.45〜0.95 秒）。
 * これは **わざと意地悪な素材** を作るためのもの。伸ばしている間は口が動かないので
 * 包絡も動かない。「包絡が動いていないコマは声ではない」とコマ単位で判断すると、
 * ここで本物の声を切る。**伸ばした母音は現実の話し声に普通にある**ので、
 * 平板な合成音と違って「素材の欠陥」では済まされない。
 *
 * `steady: true` は、音節の長さを 0.24 秒に揃える（母音は動いたまま）。
 * これも **わざと意地悪な素材**。「揺れが規則正しすぎるものは楽器だ」で
 * 音楽を弾こうとすると、拍に乗ってしゃべる声（ラップ・詠唱・秒読み）がそこに落ちる。
 * 不規則さを手がかりにしてよいかを確かめるには、規則正しい声が手元に無いと話にならない。
 *
 * **2026-09-12（2 回目）に子音と息を足した。** 音節の頭に摩擦音か破裂音を置き、
 * 母音を鳴らしている間は薄い息の雑音を重ねる（詳しくは `CONSONANTS` の説明）。
 * それまでの声は母音だけで、**広い帯域に散る雑音の粒がまったく無かった**。
 * そのせいで、本物の話し声が楽器と最も違うはずの性質を一度も試せていなかった。
 *
 * `vowelsOnly: true` を渡すと子音も息も足さない（2026-09-12 の 1 回目までの声）。
 * **子音を選ぶ乱数はそのとき引かない**ので、同じ種なら当時と 1 ビットも変わらない。
 * 過去の数字を測り直すためと、**「子音が無い声でも見分けられるか」を測るため**に要る。
 * 後者のほうが大事で、`speech-vowels-only.wav` としてわざと一覧にも置いてある
 * （ハミング・伸ばした母音・歌のように、子音がほとんど無い発声は現実にある）。
 * 子音に頼る判定を入れるなら、それがこの素材を切らないことを必ず併せて見ること。
 */
function speak(
  data,
  from,
  to,
  level,
  random,
  { flat = false, sustain = false, steady = false, vowelsOnly = false } = {},
) {
  const f0 = 120 + random() * 40;
  if (flat) {
    for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
      const t = i / SR;
      const local = t - from;
      // 音節（1 秒に 4 つくらい）と、語尾に向かって落ちる包絡。
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4.2 * local);
      const fade = Math.min(1, local / 0.05, (to - from - local) / 0.08);
      const env = level * syllable * Math.max(0, fade);
      data[i] +=
        env *
        (Math.sin(2 * Math.PI * f0 * t) +
          0.6 * Math.sin(2 * Math.PI * f0 * 2 * t) +
          0.35 * Math.sin(2 * Math.PI * f0 * 3 * t) +
          0.2 * Math.sin(2 * Math.PI * f0 * 5 * t)) *
        0.28;
    }
    return;
  }

  // 音節の並びを先に決める。長さを振っておかないと、音量の揺れが
  // 正弦波と変わらなくなる（＝楽器のトレモロと同じ形になる）。
  const span = to - from;
  const syllables = [];
  for (let at = 0, previous = -1; at < span; ) {
    // 乱数は steady でも同じ回数だけ引く。引く回数が変わると、そのあとの母音や
    // 次の発話の f0 までずれて、「長さを揃えたから変わったのか」が見えなくなる。
    const drawn = random();
    const length = steady ? 0.24 : sustain ? 0.45 + drawn * 0.5 : 0.16 + drawn * 0.16;
    // 同じ母音が続くと、そこだけ包絡が動かない区間になってしまう。
    let vowel = Math.floor(random() * VOWELS.length);
    if (vowel === previous) vowel = (vowel + 1) % VOWELS.length;
    previous = vowel;
    // 子音は母音を選んだ**あと**に引く。vowelsOnly ではここを引かないので、
    // 音節の長さも母音の並びも、子音を足す前と 1 ビット違わない。
    const consonant = vowelsOnly ? CONSONANTS[CONSONANTS.length - 1] : CONSONANTS[Math.floor(random() * CONSONANTS.length)];
    const syllableLength = Math.min(length, span - at);
    // 子音が音節の半分を超えると母音が聞き取れる長さにならない。
    // 伸ばした母音（0.45〜0.95 秒）では効かないが、短い音節では効く。
    const consonantLength = Math.min(consonant.length, syllableLength * 0.5);
    syllables.push({ at, length: syllableLength, vowel, consonant, consonantLength });
    at += length;
  }

  let phase = 0;
  let index = 0;
  // 子音の雑音のフィルタ。音節ごとに作り直す（前の子音の尾が次へ漏れないように）。
  let consonantFilter = null;
  let consonantFilterFor = -1;
  // 息は発話のあいだ続いているので、こちらは作り直さない。
  const breathFilter = highpassState(BREATH_CUTOFF);
  const breathGain = highpassGain(BREATH_CUTOFF);
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    const local = t - from;
    while (index + 1 < syllables.length && local >= syllables[index + 1].at) index += 1;
    const syllable = syllables[index];
    const inside = local - syllable.at;
    const fade = Math.max(0, Math.min(1, local / 0.05, (span - local) / 0.08));

    // 子音は音節の頭。ここでは母音を鳴らさない（無声子音のあいだ声帯は止まっている）。
    // `continue` で位相を進めないのも同じ理由で、止まっていた声帯が子音のあとに
    // また同じ所から鳴り出すことになる。
    const consonantLength = syllable.consonantLength;
    if (consonantLength > 0 && inside < consonantLength) {
      if (index !== consonantFilterFor) {
        consonantFilter = highpassState(syllable.consonant.cutoff);
        consonantFilterFor = index;
      }
      const shaped = highpass(consonantFilter, (random() - 0.5) * 2) / highpassGain(syllable.consonant.cutoff);
      // 母音と同じ 0.217 を掛けるので、level は母音の実効値に対する比として効く。
      data[i] +=
        syllable.consonant.level *
        level *
        fade *
        consonantEnvelope(syllable.consonant, inside, consonantLength) *
        shaped *
        0.217;
      continue;
    }

    // 母音は子音のうしろから始まる。音節の長さは子音に食われたぶんだけ短くなる。
    const voiced = inside - consonantLength;
    const voicedLength = syllable.length - consonantLength;

    // 音節の中の音量。立ち上がりと収まりだけを丸め、間は平らにする。
    // 正弦波で揺らすと、伸ばした母音まで揺れてしまい「伸ばしている」ことにならない。
    const shape = Math.max(0, Math.min(1, voiced / 0.03, (voicedLength - voiced) / 0.05));
    // 音節の切れ目でも 0 までは落ちない（語の途中で息が切れるわけではない）。
    const syllableEnv = 0.15 + 0.85 * shape;
    const env = level * syllableEnv * fade;

    // 母音は瞬間には切り替わらない。前の母音から 60ms かけて移る（渡り）。
    const previous = syllables[Math.max(0, index - 1)];
    const glide = Math.min(0.06, voicedLength * 0.4);
    const blend = glide > 0 ? Math.min(1, voiced / glide) : 1;
    // 周波数は対数で補間する（400→800 の途中は 600 ではなく 566）。
    // 耳にも、そのあとで測るメル帯域にも、そちらのほうが素直。
    const formants = [0, 1, 2].map((k) =>
      Math.exp(Math.log(VOWELS[previous.vowel][k]) * (1 - blend) + Math.log(VOWELS[syllable.vowel][k]) * blend),
    );

    // 抑揚。発話の終わりに向かって 1 割ほど下がり、音節ごとに少し上下する。
    const declination = 1.08 - 0.2 * (local / span);
    const accent = 1 + 0.04 * Math.sin(2 * Math.PI * 1.7 * local);
    const f = f0 * declination * accent;
    // 音程が動くので位相は積み上げる（周波数を時刻に掛けると、そこで波が跳ぶ）。
    phase += (2 * Math.PI * f) / SR;

    let v = 0;
    let power = 0;
    for (let h = 1; h * f < 5000 && h * f < SR / 2; h += 1) {
      // 声帯の音は倍音がだいたい 1/h で落ちる。そこへ口の共鳴を掛ける。
      const a = formantGain(h * f, formants) / h;
      v += a * Math.sin(h * phase);
      power += a * a;
    }
    // 実効値で揃える。倍音の数や共鳴の位置で音量が変わると、
    // しきい値が素材ごとに動いて「何を測っているのか」が分からなくなる。
    const norm = power > 0 ? Math.sqrt(power / 2) : 1;
    // 最後の係数は、**平板だった頃と同じ音量になるように**測って決めた（0.217）。
    // 声の大きさ（上位 10%）が speech.wav で -19.0dBFS、無音の底が -58.9dBFS で、
    // どちらも 2026-09-07 に記録した値とぴったり同じ。音量が変わると自動しきい値も動いて、
    // 「声の作りを変えたから変わったのか、音量が変わったから変わったのか」が切り分けられなくなる。
    data[i] += (env * v * 0.217) / norm;

    // 息の雑音。母音を鳴らしている間ずっと薄く重なる。
    // 子音と違って**声と同時に鳴る**のが要点で、これがあると
    // 「鳴っているコマの平坦さ」が母音のあいだも少しだけ上がる。
    // 楽器の素材（正弦波の足し合わせ）にはこの成分がまったく無い。
    // ただし `tone`（= 1 - flatness）は声らしさの片方なので、濃くすると
    // **声らしさを自分で下げる**ことになる。薄さの根拠は JOURNAL に測った表を置いた。
    if (!vowelsOnly) {
      data[i] += BREATH_LEVEL * env * (highpass(breathFilter, (random() - 0.5) * 2) / breathGain) * 0.217;
    }
  }
}

/**
 * 音楽らしい音。和音が一定の音量で鳴り続けるので、しきい値方式には手強い。
 *
 * `tremolo` に周波数を渡すと、その速さで音量を揺らす。
 * これは **わざと意地悪な素材** を作るためのもの。声らしさを
 * 「音程がある（tone）× 音節の速さで揺れる（modulation）」で測っているので、
 * 音程のある楽器を音節と同じ速さで震わせると、声が 1 つも無いのに
 * 声らしさが高く出てしまう。この抜け道を塞げているかを確かめるために要る。
 *
 * `swellDepth` と `tremoloDepth` は揺れの深さ。既定値は従来の音をそのまま出す。
 * **深さを別々に指定できるようにしたのは 2026-09-12（3 回目）で、
 * 「ゆっくり大きくうねり、その上に浅く刻む音楽」を作るため。**
 * 揺れの割合（modulation）は分母に全部の揺れを敷いているので、
 * 遅いうねりが大きいほど音節帯の取り分は小さく出る。
 * つまり**遅いうねりが、速い刻みを隠していた**。そこを分母から外す手を試すなら、
 * 外したとたんに跳ね上がる素材が手元に無いと、良くなったのか緩くなったのかが分からない。
 *
 * 深さは 0〜1 のつもり。1 を超えると音量が負になって位相が反転するが、
 * 弾いていない（試し用の素材を作るだけなので、渡す値はこのファイルの中で閉じている）。
 */
function music(data, from, to, level, tremolo = 0, swellDepth = 0.15, tremoloDepth = 0.45) {
  const chord = [220, 277.18, 329.63, 440];
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    // 2 秒周期で少し揺らして、まったくの定常にならないようにする。
    const swell = 1 - swellDepth + swellDepth * Math.sin(2 * Math.PI * 0.5 * t);
    // ビブラート気味に深く揺らす。声の音節（4.2Hz）と同じ帯域を狙う。
    const shake = tremolo ? 1 - tremoloDepth + tremoloDepth * Math.sin(2 * Math.PI * tremolo * t) : 1;
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t);
    data[i] += (level * swell * shake * v) / chord.length;
  }
}

/**
 * 「フォルマントが動く楽器」。和音を倍音の多い音で鳴らし、
 * そこへ**声の音節と同じ速さで動く共鳴（フォルマント）**を掛ける。
 *
 * これは **わざと意地悪な素材** を作るためのもの。
 * 「スペクトルの形（包絡）が動いているか」で声を見分けようとすると、
 * 音量の揺れだけの `music-tremolo` は弾けるが、**包絡そのものが動く音**は弾けない。
 * 包絡の動きに賭ける手が本当に成り立つのかを確かめるには、
 * 「声でないのに包絡が動く音」が手元に無いと話にならない。
 *
 * 声と違うのは**音程が 2 つ同時に鳴っている**こと（和音なので基本周波数が 1 つに定まらない）。
 * そこが残された手がかりになるかどうかも、この素材で測れる。
 */
function wahChord(data, from, to, level, rate) {
  const chord = [220, 277.18];
  const period = 1 / rate;
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    // 2 秒ごとに 0.6 秒の休符を置く（フレーズの切れ目のつもり）。
    // 音量の幅が無いと、しきい値が「全編が鳴っている」に落ちて何も起きず、
    // 判定が破れていても被害が見えない。実害の出る形にしておく。
    if (t % 2 >= 1.4) continue;
    // 音節と同じ速さで「タタタタ」と音を置く。
    const local = t % period;
    const note = Math.min(1, local / 0.01, (period * 0.75 - local) / 0.03);
    if (note <= 0) continue;
    // 共鳴の中心を 400〜1600Hz の間で行き来させる（対数で動かす。人の口の動きに近い）。
    const center = Math.exp(Math.log(400) + (Math.log(1600) - Math.log(400)) * (0.5 + 0.5 * Math.sin(2 * Math.PI * rate * t)));
    let v = 0;
    let norm = 0;
    for (const f0 of chord) {
      for (let h = 1; h <= 12; h += 1) {
        const f = f0 * h;
        if (f > SR / 2) break;
        // 対数周波数での距離で共鳴の効きを決める（共鳴の幅は 1 オクターブ弱）。
        const d = Math.log(f / center) / 0.6;
        const gain = Math.exp(-d * d) / h;
        v += gain * Math.sin(2 * Math.PI * f * t);
        norm += gain;
      }
    }
    data[i] += norm > 0 ? (level * note * v) / norm : 0;
  }
}

/**
 * 和音が途中で変わる音楽。**わざと意地悪な素材**。
 *
 * 鳴りっぱなしの音楽はスペクトルの形が動かないので「どこかで形が動いたか」で弾けるが、
 * 和音が変わればそこで形は動く。本物の曲はたいてい和音が変わるので、
 * 「形がどこかで動いたら声がある」とみなす判定は、そこで破れるはず。破れ方を測るために要る。
 */
function chordProgression(data, from, to, level, everySeconds, breaks = []) {
  const progression = [
    [220, 277.18, 329.63],
    [246.94, 293.66, 369.99],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
  ];
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    // 休符の中は和音だけを止める。ハイハットは別の関数なので刻み続ける
    // （曲が抜けてドラムだけになる「ブレイク」。現実の曲にいくらでもある形）。
    if (breaks.some(([a, b]) => t >= a && t < b)) continue;
    const chord = progression[Math.floor(t / everySeconds) % progression.length];
    const swell = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.5 * t);
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t);
    data[i] += (level * swell * v) / (chord.length * 1.4);
  }
}

function noise(data, level, random) {
  for (let i = 0; i < data.length; i += 1) data[i] += (random() - 0.5) * 2 * level;
}

/**
 * 打楽器らしい音。指定した速さで「タッ」と鳴る。
 *
 * これは **わざと意地悪な素材** を作るためのもの。
 * 声を見分けるのに「音量が 1 秒に 3〜6 回くらい揺れているか」を見る手が有力だが、
 * それだと同じ速さで刻む音楽に引っかかる。引っかかることを確かめられなければ、
 * 「うまくいった」の中身が「自分に都合のいい素材で試しただけ」になってしまう。
 */
function drums(data, from, to, level, hitsPerSecond, random) {
  const period = SR / hitsPerSecond;
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const sincePeak = i % period;
    // 立ち上がりが速く、80ms ほどで減衰する打撃音。
    const env = Math.exp(-sincePeak / (0.08 * SR));
    const t = i / SR;
    data[i] += level * env * ((random() - 0.5) * 1.2 + 0.6 * Math.sin(2 * Math.PI * 90 * t));
  }
}

/**
 * シンバル／ハイハット。高い雑音を、声の音節と同じ速さで短く刻む。
 *
 * これは **わざと意地悪な素材** を作るためのもの。ただし狙いは
 * いま動いている判定ではなく、**これから考える手がかりのほう**にある。
 *
 * 2026-09-12（2 回目）に「雑音の粒と音程の粒が短い間に混じるか」という手がかりを測った。
 * 声のある素材は 7.8〜9.9 秒でよく分かれたのに、入れなかった。`drums.wav` が 13.00 秒で
 * 完全に破ったからで、記録には**この量が分けていたのは「声があるか」ではなく
 * 「その素材が正弦波だけで作られているか」だった**と書いてある。
 * 手元の音楽 6 本のうち 5 本が正弦波の和で、雑音を持つのは `drums` ひとつしか無い。
 * **雑音を持つ音楽が 1 本しか無いのに、雑音を手がかりにしてよいかは決められない。**
 *
 * ハイハットは `drums` とは別の壊し方をする。`drums` の雑音は白色で、90Hz の胴鳴りが
 * 付いているだけ（音程の粒はそこから出ている）。ハイハットは **6kHz より上に寄った雑音**で、
 * しかも**和音と同時に鳴る**。音程は雑音と同じ源からではなく、和音から来る。
 * つまり「雑音の粒」と「音程の粒」が、現実の曲とまったく同じ形で共存する。
 *
 * 4 つに 1 つを長く伸ばす（オープンハイハット）。全部を同じ長さで刻むと、
 * 減衰の形まで等間隔になって、「規則正しすぎるものは楽器」の側へ勝手に落ちてしまう。
 */
const HAT_CUTOFF = 6000;
function hats(data, from, to, level, hitsPerSecond, random) {
  const period = 1 / hitsPerSecond;
  const filter = highpassState(HAT_CUTOFF);
  const gain = highpassGain(HAT_CUTOFF);
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    const index = Math.floor(t / period);
    const inside = t - index * period;
    const decay = index % 4 === 2 ? 0.16 : 0.035;
    // フィルタは鳴っていない間も回し続ける（掛けるのは包絡だけ）。
    // 打点ごとに作り直すと、立ち上がりが毎回フィルタの過渡になって、
    // そこが広帯域のクリックになる。いま測ろうとしている量そのものを持ち上げてしまう。
    const shaped = highpass(filter, (random() - 0.5) * 2) / gain;
    data[i] += level * Math.exp(-inside / decay) * shaped;
  }
}

/** 管楽器の息の雑音（音の実効値に対する比）と、寄せる高さ（Hz）。 */
const FLUTE_BREATH_LEVEL = 0.32;
const FLUTE_BREATH_CUTOFF = 2000;

/**
 * 息の雑音を持つ楽器（フルート・弓の擦り音のつもり）。
 *
 * これも **わざと意地悪な素材**。狙いは `tone`（音色の尖り具合 = 1 - 平坦さ）と、
 * その周りの「雑音があるか」系の手がかり全部。
 *
 * 手元の音楽は `drums` を除いて全部が正弦波の和なので、**平坦さがどれも 0 に貼り付いている**
 * （鳴っているコマの上位 10% で `bgm` 0.074・`music-chords` 0.040・`music-wah` 0.075 に対し、
 * 声は 0.774〜0.823）。この開きは「声だから」ではなく「音楽の側が正弦波だから」出ている。
 * 現実の管楽器も弓の擦り音も、音程と**同時に**広い帯域の雑音を出す。
 * その音楽が手元に無いまま平坦さを手がかりに使うと、お手盛りになる。
 *
 * 声と違うのは **共鳴（フォルマント）が動かない**こと。管の長さは音程と一緒に変わるので、
 * 包絡は音程に付いてくるだけで、口のように独立しては動かない。
 * つまり「包絡が動くか」で分けられる**はず**で、ここは分かれてほしい側の素材になる。
 *
 * 音の切れ目には息継ぎ（0.09 秒）を置く。音量に幅が無いと、しきい値が
 * 「全編が鳴っている」に落ちて何も起きず、判定が破れていても被害が見えない。
 */
function breathyTone(data, from, to, level, random) {
  // ソ・ラ・シ・レ・ミ（ペンタトニック）。音程が近すぎると、音が変わっても
  // 包絡がほとんど動かず、「音程だけが動く楽器」という狙いが立たない。
  const scale = [392, 440, 493.88, 587.33, 659.25];
  const span = to - from;
  const notes = [];
  for (let at = 0, previous = -1; at < span; ) {
    const length = 0.55 + random() * 0.4;
    let step = Math.floor(random() * scale.length);
    if (step === previous) step = (step + 1) % scale.length;
    previous = step;
    notes.push({ at, length: Math.min(length, span - at), hz: scale[step] });
    at += length;
  }

  const filter = highpassState(FLUTE_BREATH_CUTOFF);
  const gain = highpassGain(FLUTE_BREATH_CUTOFF);
  let phase = 0;
  let index = 0;
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    const local = t - from;
    while (index + 1 < notes.length && local >= notes[index + 1].at) index += 1;
    const note = notes[index];
    const inside = local - note.at;
    const body = note.length - 0.09;
    const env = Math.max(0, Math.min(1, inside / 0.05, (body - inside) / 0.06));
    if (env <= 0) continue;

    // ビブラート。息継ぎと合わせて、音量も音程も止まらないようにする。
    const f = note.hz * (1 + 0.012 * Math.sin(2 * Math.PI * 5 * t));
    phase += (2 * Math.PI * f) / SR;
    let v = 0;
    let power = 0;
    // 管楽器は倍音が少ない（声より速く落ちる）。h^1.8 は測って決めたのではなく、
    // 「声の 1/h より急」であればよいので素直な形にした。
    for (let h = 1; h * note.hz < 8000 && h * note.hz < SR / 2; h += 1) {
      const a = 1 / Math.pow(h, 1.8);
      v += a * Math.sin(h * phase);
      power += a * a;
    }
    const norm = power > 0 ? Math.sqrt(power / 2) : 1;
    // 息は鳴っている間ずっと重なる。声の息（BREATH_LEVEL 0.05）よりずっと濃い。
    // フルートの息の音は、離れて聞いても分かるくらいはっきり鳴っている。
    const breath = highpass(filter, (random() - 0.5) * 2) / gain;
    data[i] += level * env * (v / norm + FLUTE_BREATH_LEVEL * breath);
  }
}

/**
 * ビブラートの深さ（音程の比）と速さ（Hz）。
 * **`speak()` の `accent`（1 ± 0.04 の 1.7Hz）と同じ値**にしてある。
 * 「楽器らしいビブラート」（浅く速い 5〜7Hz）にすると、声の抑揚とは別物になってしまい、
 * 「音程の動きで声を見分ける」手を潰す素材にならない。狙いは声と**同じ動き方**をさせること。
 */
const VIBRATO_DEPTH = 0.04;
const VIBRATO_RATE = 1.7;
/**
 * 音と音の間を渡る時間（秒）。
 *
 * ここが 0 だと音程が階段状に跳ぶので、「滑らかに動いたか」で弾けてしまう。
 * 弦も管も声も、隣の音へは必ず有限の時間をかけて渡る。
 * `speak()` の母音の渡り（0.06 秒）より少し長くしてあるのは、
 * 声より緩やかに渡る楽器（弦のポルタメント）のつもり。
 */
const PORTAMENTO = 0.09;
/**
 * 音程が動く楽器（声は無い）。**わざと意地悪な素材。**
 *
 * 狙いは「音程が滑らかに動いているか」で声を見分ける手、およびその周辺
 * （包絡の動き `envelopeChange`）。
 *
 * 手元の音楽は、音程が**完全に固定**か（`bgm`・`music-tremolo`・`music-wah`）、
 * **階段状に跳ぶ**か（`music-chords*`）、**音程が無い**か（`drums`・`hats`）のどれかしかない。
 * `music-flute` にビブラートは入っているが ±1.2%・5Hz と浅く速く、声の抑揚とは別の動きになる。
 * **音程が固定の音楽しか手元に無い状態で「音程が動けば声」を測れば、必ず良い数字が出る。**
 * それは判定の出来ではなく、素材の偏りを測っているだけになる
 * （`music-flute` を足した理由とまったく同じ構図）。
 *
 * 現実の楽器は音程を動かす。弦のビブラートもポルタメントも、管のしゃくり上げも、
 * 歌の無い器楽曲にいくらでもある。
 *
 * 声と違うのは **共鳴（フォルマント）が固定**であること。口は動かないので、
 * 倍音の重みが変わるのは「倍音が固定の共鳴の中を滑って通る」ぶんだけ。
 * つまり「口が動いたか」を本当に測れている手なら、この素材は弾けるはず。
 * 逆に音程の動きに引きずられる手は、ここで破れる
 * （`envelopeChange` は音程の動きに共鳴の 4〜8 割の大きさで反応すると測れているので、
 * 破れるはず——という予想が features.ts に書いたまま 3 日置いてあった。その答え合わせでもある）。
 *
 * 音の切れ目には休符（0.1 秒）を置く。音量に幅が無いと、しきい値が
 * 「全編が鳴っている」に落ちて何も起きず、判定が破れていても被害が見えない。
 */
function vibratoTone(data, from, to, level, random) {
  // ソ・ラ・シ・レ・ミ（ペンタトニック）。`breathyTone` と同じ並びの 1 オクターブ下で、
  // **声の基本周波数（120〜160Hz）と同じ帯**に置いた。高い所で鳴らすと、
  // メル帯域の下半分に何も無い素材になってしまい、「低い帯域で何が起きているか」を
  // 比べる相手にならない。
  const scale = [196, 220, 246.94, 293.66, 329.63].map((hz) => hz / 2);
  const span = to - from;
  const notes = [];
  for (let at = 0, previous = -1; at < span; ) {
    // 長さは振る。揃えると音量の揺れが正弦波と変わらなくなり、
    // 「規則正しさ」だけで弾けてしまう（それは音程の話ではない）。
    const length = 0.5 + random() * 0.45;
    let step = Math.floor(random() * scale.length);
    if (step === previous) step = (step + 1) % scale.length;
    previous = step;
    notes.push({ at, length: Math.min(length, span - at), hz: scale[step] });
    at += length;
  }

  // 口の形は動かない。母音「お」の共鳴に固定する（どれでもよいが、
  // 低い F1・F2 のほうが、この音域の倍音が共鳴の山に乗る）。
  const formants = VOWELS[4];
  let phase = 0;
  let index = 0;
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    const local = t - from;
    while (index + 1 < notes.length && local >= notes[index + 1].at) index += 1;
    const note = notes[index];
    const inside = local - note.at;
    const body = note.length - 0.1;
    const env = Math.max(0, Math.min(1, inside / 0.04, (body - inside) / 0.05));
    if (env <= 0) continue;

    // 隣の音からポルタメントで渡る。対数で補間する（`speak()` の母音の渡りと同じ理由）。
    const before = notes[Math.max(0, index - 1)];
    const blend = PORTAMENTO > 0 ? Math.min(1, inside / PORTAMENTO) : 1;
    const glided = Math.exp(Math.log(before.hz) * (1 - blend) + Math.log(note.hz) * blend);
    // ビブラート（声の抑揚と同じ）に、音の中で 1 割下がる傾きを重ねる。
    // 傾きは `speak()` の declination のつもりで、**動きを発話らしく**しておくためのもの。
    const decline = 1.05 - 0.1 * Math.min(1, inside / Math.max(1e-6, body));
    const f = glided * decline * (1 + VIBRATO_DEPTH * Math.sin(2 * Math.PI * VIBRATO_RATE * t));
    // 音程が動くので位相は積み上げる（周波数を時刻に掛けると、そこで波が跳ぶ）。
    phase += (2 * Math.PI * f) / SR;

    let v = 0;
    let power = 0;
    for (let h = 1; h * f < 5000 && h * f < SR / 2; h += 1) {
      // 倍音の落ち方も共鳴の形も声と同じにする。**違うのは共鳴が動かないことだけ**、
      // という素材にしておかないと、破れたときに何が効いたのか言えない。
      const a = formantGain(h * f, formants) / h;
      v += a * Math.sin(h * phase);
      power += a * a;
    }
    const norm = power > 0 ? Math.sqrt(power / 2) : 1;
    data[i] += (level * env * v) / norm;
  }
}

/**
 * 発話の**頭にぴたりと接する**和音（曲が鳴り止んだ瞬間にしゃべり出す形）。
 *
 * 2026-09-15 に入れた「発話の頭を遡って拾う」手を潰しにいくための素材。
 * 遡りは**鳴っているあいだだけ**戻るので、発話の前が無音なら何も拾わない。
 * つまり遡りが損をするのは「声の直前まで、声でない音が鳴り続けている」ときだけで、
 * それがいちばん濃く出る形がこれ。ショート動画では普通にある切り方なので、
 * 意地悪なだけの形ではない。
 *
 * **最初は減衰する一撃（スティンガー）で作ったが、punisher にならなかった。**
 * 打点は声らしさの判定を素通りするので、遡りが無くても丸ごと残ってしまい、
 * 遡りの有無で数字が 1 ポイントも動かない（2026-09-15 の記録を参照）。
 * 潰すには**判定が確かに弾く音**でなければならないので、持続する和音にしてある。
 *
 * 乱数を引かない。`speak` のあとから呼べば、声は `speech.wav` と 1 ビットも変わらない。
 */
function chordInto(data, starts, level, length) {
  const chord = [220, 277.18, 329.63];
  for (const at of starts) {
    const from = Math.max(0, Math.round((at - length) * SR));
    const to = Math.min(data.length, Math.round(at * SR));
    for (let i = from; i < to; i += 1) {
      const t = i / SR;
      const inside = (i - from) / SR;
      // 出入りだけ短く均す。あいだは音量も音色も動かさない（動かすと「和音が変わる音楽」になり、
      // 何を測っているのか分からなくなる）。声との継ぎ目に段差を作らないため、末尾も 0 へ落とす。
      const env = Math.min(1, inside / 0.03, (length - inside) / 0.03);
      let v = 0;
      for (const f of chord) v += Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t);
      data[i] += (level * env * v) / (chord.length * 1.4);
    }
  }
}

function makeShort(
  name,
  {
    speech = true,
    sparse = false,
    bgm = false,
    bgmLevel = 0.12,
    bgmTremolo = 0,
    /** ゆっくりしたうねり（0.5Hz）の深さ。既定は従来どおりごく浅い。 */
    bgmSwellDepth = 0.15,
    /** トレモロの深さ。浅くすると「うねりに隠れた刻み」が作れる。 */
    bgmTremoloDepth = 0.45,
    /** 声の音節と同じ速さで共鳴が動く楽器（Hz）。0 で鳴らさない。 */
    wah = 0,
    wahLevel = 0.3,
    /** 和音が何秒ごとに変わるか。0 で鳴らさない。 */
    chordEvery = 0,
    chordLevel = 0.25,
    /**
     * 和音だけが休む区間（秒の [始まり, 終わり] の並び）。ハイハットは刻み続ける。
     * 「音楽が途切れずに鳴り続けているから切られずに済んでいる」素材と、
     * 途中で曲の顔つきが変わる素材とを分けて測るために置いた。
     */
    chordBreaks = [],
    beat = 0,
    beatLevel = 0.25,
    /** シンバル／ハイハットを刻む速さ（Hz）。0 で鳴らさない。 */
    hat = 0,
    hatLevel = 0.1,
    /** 息の雑音を持つ管楽器を鳴らすか。 */
    flute = false,
    /** 音程が声と同じように動く楽器を鳴らすか。「音程の動き」に賭ける手を潰しにいく素材。 */
    vibrato = false,
    /**
     * 既定値は**ほかの素材と同じ音量に揃うように測って決めた**（実効値 -23.7dBFS）。
     * `fluteLevel` と同じ理由（素材ごとに音量が違うと自動しきい値もずれる）。
     */
    vibratoLevel = 0.075,
    /**
     * 既定値は**ほかの素材と同じ音量に揃うように測って決めた**（実効値 -23.7dBFS）。
     * 素材ごとに音量が違うと自動しきい値もずれて、
     * 「作りを変えたから数字が動いたのか、音量が動いたからか」が切り分けられなくなる。
     */
    fluteLevel = 0.07,
    noiseLevel = 0.002,
    speechLevel = 0.5,
    /** 2026-09-11 以前の平板な声で鳴らす（過去の数字を測り直すため）。 */
    flat = false,
    /** 母音を長く伸ばしてしゃべる。包絡をコマ単位の門にする手を潰しにいく素材。 */
    sustain = false,
    /** 音節の長さを揃えてしゃべる。「規則正しさ」で音楽を弾く手を潰しにいく素材。 */
    steady = false,
    /** 子音も息も足さない声（2026-09-12 の 1 回目までの声）。子音に頼る判定を潰しにいく素材。 */
    vowelsOnly = false,
    /** 発話の頭にぴたりと接する和音。「発話の頭を遡って拾う」手を潰しにいく素材。 */
    chordInto: chordIntoOn = false,
    chordIntoLevel = 0.3,
    /** 和音の長さ（秒）。遡りの既定（0.32 秒）よりずっと長くしておく。 */
    chordIntoLength = 1.0,
    seed = 1,
  },
) {
  const random = rng(seed);
  const data = new Float32Array(Math.round(SHORT_LENGTH * SR));
  noise(data, noiseLevel, random);
  if (bgm) music(data, 0, SHORT_LENGTH, bgmLevel, bgmTremolo, bgmSwellDepth, bgmTremoloDepth);
  if (wah) wahChord(data, 0, SHORT_LENGTH, wahLevel, wah);
  if (chordEvery) chordProgression(data, 0, SHORT_LENGTH, chordLevel, chordEvery, chordBreaks);
  if (beat) drums(data, 0, SHORT_LENGTH, beatLevel, beat, random);
  if (flute) breathyTone(data, 0, SHORT_LENGTH, fluteLevel, random);
  if (vibrato) vibratoTone(data, 0, SHORT_LENGTH, vibratoLevel, random);
  if (speech) {
    for (const [from, to] of sparse ? SPARSE_UTTERANCES : UTTERANCES)
      speak(data, from, to, speechLevel, random, { flat, sustain, steady, vowelsOnly });
  }
  // 和音は `speak` のあと・ハイハットの前。乱数を引かないので、
  // 足しても声もハイハットも 1 ビットも変わらない（`speech.wav` の声とそのまま比べられる）。
  if (chordIntoOn)
    chordInto(data, (sparse ? SPARSE_UTTERANCES : UTTERANCES).map(([from]) => from), chordIntoLevel, chordIntoLength);
  // ハイハットは**いちばん最後**に置く。こうしておくと、`hat` を足すだけの素材は
  // **ほかの音が 1 ビットも変わらない**（ここまでの乱数の消費数が同じなら同じ音が出る）。
  // ほかを変えずに 1 つだけ変えた 2 本を並べられないと、
  // 「判定が本当は何を見ていたのか」が出ない。
  //
  // **2026-09-13 の 2 回目に、打楽器のうしろから声のうしろへ移した。** 以前の場所でも
  // `music-hats` 対 `music-chords`（声の無い 2 本）は和音が一致していたが、
  // **声のある素材にハイハットを足すと声のほうが変わってしまう**（`hats` が乱数を引くので、
  // そのあとの `speak` が別の音節を選ぶ）。`speech-hats` を足すのに、
  // 「声も違う 2 本」では何が効いたのか言えない。
  // 声の無い素材は `speak` を呼ばないので、移しても音は 1 ビットも変わらない
  // （`music-hats.wav` の md5 が一致することを確認した）。
  if (hat) hats(data, 0, SHORT_LENGTH, hatLevel, hat, random);
  return writeWav(name, data);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`出力先: ${OUT}\n`);

// 何をどう作るかは spec.mjs にまとめてある（測る側からも同じものを参照するため）。
for (const fixture of SHORT_FIXTURES) {
  process.stdout.write(`${fixture.hard ? '※ ' : '  '}${fixture.note.padEnd(24, '　')} `);
  makeShort(fixture.name, fixture.options);
}
console.log('\n※ は、声を見分ける処理をいじめるために足した素材。');

if (process.argv.includes('long')) {
  // 長尺での処理時間とメモリを測るためのもの。10 分ぶん。
  const minutes = 10;
  const random = rng(9);
  const data = new Float32Array(Math.round(minutes * 60 * SR));
  noise(data, 0.002, random);
  for (let t = 0; t + 6 < minutes * 60; t += 6) {
    speak(data, t + 0.5, t + 2.2, 0.5, random);
    speak(data, t + 3.0, t + 5.0, 0.5, random);
  }
  writeWav('speech-long.wav', data);
}

console.log('\n完了。');
