/**
 * 試し用の素材に対して、いまの無音カットがどう効くかを測る。
 *
 *   npm run lab:fixtures   # 先に素材を作る
 *   npm run lab:bench
 *   npm run lab:bench -- lab/fixtures/out/speech-long.wav   # ファイルを指定してもよい
 *   LAB_NO_RUN=1 npm run lab:bench   # 「動きが続いたか」を見ない（2026-09-14 以前の振る舞い）
 *
 * `LAB_NO_RUN` は A/B を並べるためのもの。判定に手を入れたら、
 * **入れる前と入れたあとを同じコマンドで出せる**ようにしておかないと、
 * 「良くなった」が測れない（前の数字は記録から拾い直すことになる）。
 *
 * セルフテスト（合成波形での検算）は「壊れていないか」を見るもので、
 * こちらは「実際どれくらい効くか」を見るもの。数字を記録に残しておけば、
 * あとから手を入れたときに良くなったのか悪くなったのかが分かる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';
import { SHORT_FIXTURES, utterancesOf } from '../fixtures/spec.mjs';

const { analyzeLoudness } = await import('./src/loudness.ts');
const { analyzeFeatures } = await import('./src/features.ts');
const { planJetCut } = await import('./src/silence.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = path.join(root, 'lab/fixtures/out');

const files = process.argv.slice(2).filter((a) => a.endsWith('.wav'));
if (files.length === 0) {
  if (!fs.existsSync(fixtures)) {
    console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
    process.exit(1);
  }
  files.push(...fs.readdirSync(fixtures).filter((f) => f.endsWith('.wav')).map((f) => path.join(fixtures, f)));
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (s, n) => String(s).padStart(n, ' ');

console.log('音量だけで判定（level）と、声らしさも見る（speech）を並べる。\n');
console.log(
  `${pad('素材', 22)}${num('尺', 7)}  |${num('本数', 5)}${num('残る', 7)}${num('削減', 6)}${num('時間', 7)}  |${num('本数', 5)}${num('残る', 7)}${num('削減', 6)}${num('時間', 7)}`,
);
console.log(`${' '.repeat(29)}  |${pad('  level（既定）', 25)}|${pad('  speech（新）', 25)}`);
console.log('-'.repeat(95));

/** 使い物になっていない結果には印を付ける。数字だけ見ても気づけないため。 */
function verdict(plan) {
  if (plan.keep.length === 0) return '何も残らない';
  if (plan.resultDuration > plan.originalDuration * 0.95) return '全編が鳴っている判定';
  return null;
}

/** 2 つの区間の重なりの長さ。 */
const overlap = (a, b) => Math.max(0, Math.min(a.end, b[1]) - Math.max(a.start, b[0]));

/**
 * 正解と突き合わせる。
 *
 * **削減率だけを見てはいけない。** 全部削れば削減 100% になるが、それは
 * 声ごと消しているだけ。「声をどれだけ残せたか」と「余計にどれだけ残したか」を
 * 並べて初めて、良くなったかどうかが言える。
 */
function accuracy(plan, fixture) {
  if (!fixture) return null;
  const truth = utterancesOf(fixture);
  const truthTotal = truth.reduce((sum, [a, b]) => sum + (b - a), 0);
  let hit = 0;
  for (const range of plan.keep) for (const u of truth) hit += overlap(range, u);
  const keptTotal = plan.resultDuration;
  return {
    // 声のうち、残せた割合。低いと「声を切ってしまっている」。
    recall: truthTotal > 0 ? hit / truthTotal : null,
    // 残したもののうち、声だった割合。低いと「余計なものを残している」。
    precision: keptTotal > 0 ? hit / keptTotal : truthTotal > 0 ? 0 : null,
  };
}

const percent = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);

for (const file of files) {
  const buffer = readWav(file);
  const track = analyzeLoudness(buffer, 0.02);

  const t0 = performance.now();
  const level = planJetCut(track, { mode: 'level' });
  const levelMs = performance.now() - t0;

  const t1 = performance.now();
  const features = analyzeFeatures(buffer, track);
  const speech = planJetCut(
    track,
    { mode: 'speech', ...(process.env.LAB_NO_RUN ? { minEnvelopeRun: 0 } : {}) },
    features.speechScore,
    features.shapeChange,
    features.envelopeChange,
    features.envelopeFlux,
  );
  const speechMs = performance.now() - t1;

  const cut = (plan) => (plan.originalDuration > 0 ? Math.round((1 - plan.resultDuration / plan.originalDuration) * 100) : 0);
  const cell = (plan, ms) =>
    `${num(plan.keep.length, 5)}${num(plan.resultDuration.toFixed(1) + 's', 7)}${num(cut(plan) + '%', 6)}${num(ms.toFixed(0) + 'ms', 7)}`;

  console.log(
    `${pad(path.basename(file), 22)}${num(level.originalDuration.toFixed(1) + 's', 7)}  |${cell(level, levelMs)}  |${cell(speech, speechMs)}`,
  );

  const notes = [];
  if (verdict(level)) notes.push(`level: ${verdict(level)}`);
  if (speech.noSpeechFound) {
    const why = speech.noSpeechReason === 'shape' ? '形がどこでも動かない' : '声だと判断できたコマがほぼ無い';
    notes.push(`speech: 声が見つからないので何もしなかった（${why}）`);
  }
  else if (verdict(speech)) notes.push(`speech: ${verdict(speech)}`);
  notes.push(`声らしいコマの割合 ${(speech.speechRatio * 100).toFixed(0)}%`);
  notes.push(`形が動いた ${speech.shapeSeconds.toFixed(1)}s`);
  // 保持が音楽の一瞬の動きを引き伸ばしていないかは、ここを見る。
  notes.push(`音色が動いた ${speech.envelopeSeconds.toFixed(1)}s`);
  if (speech.usedMode !== 'speech') notes.push('speech モードに落ちられなかった');
  if (notes.length) console.log(`${' '.repeat(22)} └ ${notes.join(' / ')}`);

  // 正解の分かっている素材なら、削減率だけでなく中身の当たり具合も出す。
  const fixture = SHORT_FIXTURES.find((f) => f.name === path.basename(file));
  const a = accuracy(level, fixture);
  const b = accuracy(speech, fixture);
  if (a && b) {
    console.log(
      `${' '.repeat(22)} └ 声を残せた率 ${percent(a.recall)} → ${percent(b.recall)}` +
        ` / 残したうち声だった率 ${percent(a.precision)} → ${percent(b.precision)}`,
    );
  }
}

console.log(
  '\nspeech は音そのものを見る（FFT）ぶん level より遅い。そのぶん、BGM や環境音が乗った素材で切れるようになる。',
);
console.log('削減率だけを見ないこと。全部削れば 100% になるが、それは声ごと消しているだけ。');
