/**
 * 試作の画面。
 * ここは「見せる・鳴らす」だけを受け持ち、判断はすべて純粋な関数（silence / ducking）に任せている。
 * 本体へ持っていくときに要るのはそちらだけで、このファイルは捨ててよい。
 */

import { analyzeLoudness, type LoudnessTrack } from './loudness.ts';
import { buildPeaks, type Peaks } from './peaks.ts';
import { analyzeFeatures, type FeatureTrack } from './features.ts';
import { planJetCut, type JetCutPlan } from './silence.ts';
import { applyDucking, gainAt, planDucking, type GainPoint } from './ducking.ts';
import { summarize, toClipEdits } from './edits.ts';
import { runSelfTest } from './selftest.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let audio: AudioContext | null = null;
const ensureAudio = () => {
  if (!audio) audio = new AudioContext();
  if (audio.state === 'suspended') void audio.resume();
  return audio;
};

/** いま鳴らしている音。新しく鳴らす前に必ず止める。 */
let playing: AudioBufferSourceNode[] = [];
function stopAll() {
  for (const node of playing) {
    try {
      node.stop();
    } catch {
      /* もう止まっている */
    }
  }
  playing = [];
}

interface Loaded {
  name: string;
  buffer: AudioBuffer;
  track: LoudnessTrack;
  peaks: Peaks;
  /** 声らしさなど。重いので、読み込んだときに一度だけ作る。 */
  features: FeatureTrack;
}

let voice: Loaded | null = null;
let bgm: Loaded | null = null;
let plan: JetCutPlan | null = null;
let duckPoints: GainPoint[] = [];

// ---------- 読み込み ----------

async function load(file: File, canvas: HTMLCanvasElement): Promise<Loaded> {
  const bytes = await file.arrayBuffer();
  // decodeAudioData は音声トラックだけを取り出すので、動画ファイルをそのまま渡してよい。
  const buffer = await ensureAudio().decodeAudioData(bytes);
  const track = analyzeLoudness(buffer, 0.02);
  return {
    name: file.name,
    buffer,
    track,
    peaks: buildPeaks(buffer, Math.max(200, canvas.clientWidth || 800)),
    features: analyzeFeatures(buffer, track),
  };
}

function bindFile(inputId: string, statusId: string, canvas: HTMLCanvasElement, onLoad: (loaded: Loaded) => void) {
  const status = $<HTMLParagraphElement>(statusId);
  $<HTMLInputElement>(inputId).addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    status.className = 'status';
    status.textContent = `${file.name} を読み込んでいます…`;
    try {
      const loaded = await load(file, canvas);
      status.textContent = `${loaded.name} ・ ${loaded.buffer.duration.toFixed(2)} 秒 ・ ${loaded.buffer.numberOfChannels}ch ・ ${loaded.buffer.sampleRate}Hz`;
      onLoad(loaded);
    } catch (e) {
      status.className = 'status error';
      status.textContent = `この形式の音は、このブラウザでは読めませんでした（${e instanceof Error ? e.message : e}）`;
    }
  });
}

// ---------- 描画 ----------

/**
 * キャンバスを画面の実寸に合わせる（ぼやけ防止）。
 * 見た目の高さは style で固定する。width / height 属性だけを書き換えると、
 * それが要素の高さにもなってしまい、描くたびに縦へ伸び続ける。
 */
function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 800;
  const height = displayHeight(canvas);
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/** CSS 上の高さ。data-height に書いた値を正とする。 */
function displayHeight(canvas: HTMLCanvasElement): number {
  return Number(canvas.dataset.height) || 160;
}

function drawWave(ctx: CanvasRenderingContext2D, peaks: Peaks, width: number, height: number, color: string) {
  const mid = height / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < width; x += 1) {
    const i = Math.min(peaks.max.length - 1, Math.floor((x / width) * peaks.max.length));
    const top = mid - peaks.max[i] * mid * 0.92;
    const bottom = mid - peaks.min[i] * mid * 0.92;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

function drawVoice() {
  const canvas = $<HTMLCanvasElement>('voice-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = displayHeight(canvas);
  ctx.clearRect(0, 0, width, height);
  if (!voice || !plan) return;

  const toX = (t: number) => (t / voice!.buffer.duration) * width;

  // 削る区間を先に敷く。
  ctx.fillStyle = 'rgba(138, 91, 91, 0.35)';
  for (const range of plan.cut) ctx.fillRect(toX(range.start), 0, Math.max(1, toX(range.end) - toX(range.start)), height);
  ctx.fillStyle = 'rgba(111, 154, 91, 0.16)';
  for (const range of plan.keep) ctx.fillRect(toX(range.start), 0, Math.max(1, toX(range.end) - toX(range.start)), height);

  drawWave(ctx, voice.peaks, width, height, '#cfd6cb');

  // 声らしさの曲線（「声らしさも見る」のときだけ）。判定の理由が目で見えるように。
  if (plan.usedMode === 'speech') {
    const score = voice.features.speechScore;
    ctx.strokeStyle = '#9ab7d8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 1) {
      const i = Math.min(score.length - 1, Math.floor((x / width) * score.length));
      const y = height - Math.min(1, score[i] / 0.6) * (height - 4) - 2;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const threshold = Number($<HTMLInputElement>('speech-threshold').value);
    const y = height - Math.min(1, threshold / 0.6) * (height - 4) - 2;
    ctx.strokeStyle = 'rgba(154, 183, 216, 0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // しきい値の線（dB を振幅に戻して描く）。
  const amp = Math.pow(10, plan.thresholdDb / 20);
  const mid = height / 2;
  ctx.strokeStyle = '#b7d0a8';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, mid - amp * mid * 0.92);
  ctx.lineTo(width, mid - amp * mid * 0.92);
  ctx.moveTo(0, mid + amp * mid * 0.92);
  ctx.lineTo(width, mid + amp * mid * 0.92);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBgm() {
  const canvas = $<HTMLCanvasElement>('bgm-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = displayHeight(canvas);
  ctx.clearRect(0, 0, width, height);
  if (!bgm) return;

  drawWave(ctx, bgm.peaks, width, height, '#8d93a0');
  if (duckPoints.length === 0) return;

  // 音量カーブ。BGM の尺いっぱいに引く（声が短ければ以降は 1 のまま）。
  ctx.strokeStyle = '#b7d0a8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 1) {
    const t = (x / width) * bgm.buffer.duration;
    const y = height - gainAt(duckPoints, t) * (height - 6) - 3;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ---------- 無音カット ----------

/** いま選ばれている判定のしかた。 */
function currentMode(): 'level' | 'speech' {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked?.value === 'speech' ? 'speech' : 'level';
}

function refreshCut() {
  const mode = currentMode();
  document.body.classList.toggle('mode-speech', mode === 'speech');
  $<HTMLOutputElement>('out-speech').textContent = Number($<HTMLInputElement>('speech-threshold').value).toFixed(2);
  $<HTMLOutputElement>('out-envelope-hold').textContent = `${Number($<HTMLInputElement>('envelope-hold').value).toFixed(2)} 秒`;
  $<HTMLOutputElement>('out-speech-lead-in').textContent = `${Number($<HTMLInputElement>('speech-lead-in').value).toFixed(2)} 秒`;
  if (!voice) return;
  plan = planJetCut(
    voice.track,
    {
      mode,
      speechThreshold: Number($<HTMLInputElement>('speech-threshold').value),
      sensitivity: Number($<HTMLInputElement>('sensitivity').value),
      minSilence: Number($<HTMLInputElement>('min-silence').value),
      padding: Number($<HTMLInputElement>('padding').value),
      envelopeHold: Number($<HTMLInputElement>('envelope-hold').value),
      speechLeadIn: Number($<HTMLInputElement>('speech-lead-in').value),
    },
    voice.features.speechScore,
    voice.features.shapeChange,
    voice.features.envelopeChange,
    // 均す前の列。「この素材に声があるか」を決めるときだけ使う（silence.ts の注を参照）。
    voice.features.envelopeFlux,
  );

  $<HTMLOutputElement>('out-sensitivity').textContent = Number($<HTMLInputElement>('sensitivity').value).toFixed(2);
  $<HTMLOutputElement>('out-min-silence').textContent = `${Number($<HTMLInputElement>('min-silence').value).toFixed(2)} 秒`;
  $<HTMLOutputElement>('out-padding').textContent = `${Number($<HTMLInputElement>('padding').value).toFixed(2)} 秒`;

  const ratio = plan.originalDuration > 0 ? plan.resultDuration / plan.originalDuration : 1;
  $<HTMLDListElement>('cut-stats').innerHTML = [
    ['元の尺', `${plan.originalDuration.toFixed(2)} 秒`],
    ['カット後', `${plan.resultDuration.toFixed(2)} 秒`],
    ['削減', `${plan.removed.toFixed(2)} 秒（${Math.round((1 - ratio) * 100)}%）`],
    ['クリップ数', `${plan.keep.length} 本`],
    ['しきい値', `${plan.thresholdDb.toFixed(1)} dB`],
    ['判定', plan.usedMode === 'speech' ? '声らしさも見た' : '音量だけ'],
    ...(plan.usedMode === 'speech'
      ? [['音色が動いていた', `${plan.envelopeSeconds.toFixed(2)} 秒`] as [string, string]]
      : []),
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  // 声が少ないときは、黙って判断せず知らせる。
  // 割合だけでは「声が無い」と「たまにしか声が無い」を分けられないため、
  // 決めるのは人に任せて、材料を出すだけにしている。
  const warning = $<HTMLParagraphElement>('cut-warning');
  if (plan.noSpeechFound) {
    // 同じ「何もしない」でも、理由によって次にすべきことが違う。
    warning.textContent =
      plan.noSpeechReason === 'shape'
        ? '音の中身が最初から最後まで変わりません。鳴りっぱなしの音楽ではありませんか？ ' +
          '声だと思うなら「音量だけ」で試してください。'
        : '声だと判断できるところが見つからなかったので、何もしていません。' +
          '音楽だけの素材か、音色の動かない音（鳴りっぱなしの楽器）ではありませんか？' +
          '（切りたいなら「音量だけ」で試してください）';
    warning.hidden = false;
  } else if (plan.usedMode === 'speech' && plan.speechRatio < 0.5) {
    warning.textContent =
      `鳴っているところのうち、声らしいと判断できたのは ${Math.round(plan.speechRatio * 100)}% です。` +
      '声の少ない素材か、声として拾えていないかのどちらかです。結果を必ず耳で確かめてください。';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  const clip = { start: 0, duration: voice.buffer.duration, sourceIn: 0 };
  const edits = toClipEdits(plan.keep, clip);
  const stats = summarize(edits, clip);
  $<HTMLPreElement>('edit-list').textContent = edits.length
    ? [
        `${stats.pieces} 本 / ${stats.before.toFixed(2)} 秒 → ${stats.after.toFixed(2)} 秒`,
        '',
        ...edits.map(
          (e, i) =>
            `${String(i + 1).padStart(2, ' ')}. タイムライン ${e.start.toFixed(2)}〜${(e.start + e.duration).toFixed(2)} 秒` +
            `　←　素材 ${e.from.start.toFixed(2)}〜${e.from.end.toFixed(2)} 秒`,
        ),
      ].join('\n')
    : '残る区間がありません（感度を下げてみてください）';

  drawVoice();
  refreshDuck();
}

/** 残す区間だけを順に鳴らす。詰めた結果がそのまま耳で確かめられる。 */
function playRanges(loaded: Loaded, ranges: { start: number; end: number }[]) {
  stopAll();
  const ctx = ensureAudio();
  let at = ctx.currentTime + 0.05;
  for (const range of ranges) {
    const length = range.end - range.start;
    if (length <= 0.01) continue;
    const node = ctx.createBufferSource();
    node.buffer = loaded.buffer;
    node.connect(ctx.destination);
    node.start(at, range.start, length);
    playing.push(node);
    at += length;
  }
}

// ---------- ダッキング ----------

function refreshDuck() {
  $<HTMLOutputElement>('out-duck').textContent = `${$<HTMLInputElement>('duck-db').value} dB`;
  $<HTMLOutputElement>('out-hold').textContent = `${Number($<HTMLInputElement>('hold').value).toFixed(2)} 秒`;
  $<HTMLOutputElement>('out-release').textContent = `${Number($<HTMLInputElement>('release').value).toFixed(2)} 秒`;

  duckPoints = voice
    ? planDucking(voice.track, {
        duckDb: Number($<HTMLInputElement>('duck-db').value),
        hold: Number($<HTMLInputElement>('hold').value),
        release: Number($<HTMLInputElement>('release').value),
      })
    : [];
  drawBgm();

  const ready = !!(voice && bgm);
  $<HTMLButtonElement>('play-mix').disabled = !ready;
  $<HTMLButtonElement>('play-flat').disabled = !ready;
}

function playMix(ducked: boolean) {
  if (!bgm) return;
  stopAll();
  const ctx = ensureAudio();
  const at = ctx.currentTime + 0.05;

  const bgmNode = ctx.createBufferSource();
  bgmNode.buffer = bgm.buffer;
  const gain = ctx.createGain();
  // BGM は元から少し下げておく（下げないと声より大きくて比べにくい）。
  gain.gain.value = 0.6;
  bgmNode.connect(gain).connect(ctx.destination);
  if (ducked && duckPoints.length) {
    gain.gain.setValueAtTime(0.6, at);
    // planDucking は 0〜1 を返すので、BGM の基準音量を掛けてから流す。
    applyDucking(
      gain.gain,
      duckPoints.map((p) => ({ time: p.time, gain: p.gain * 0.6 })),
      at,
    );
  }
  bgmNode.start(at);
  playing.push(bgmNode);

  if (voice) {
    const voiceNode = ctx.createBufferSource();
    voiceNode.buffer = voice.buffer;
    voiceNode.connect(ctx.destination);
    voiceNode.start(at);
    playing.push(voiceNode);
  }
}

// ---------- 配線 ----------

bindFile('voice-file', 'voice-status', $<HTMLCanvasElement>('voice-canvas'), (loaded) => {
  voice = loaded;
  $<HTMLButtonElement>('play-original').disabled = false;
  $<HTMLButtonElement>('play-cut').disabled = false;
  $<HTMLButtonElement>('stop-voice').disabled = false;
  refreshCut();
});

bindFile('bgm-file', 'bgm-status', $<HTMLCanvasElement>('bgm-canvas'), (loaded) => {
  bgm = loaded;
  $<HTMLButtonElement>('play-bgm').disabled = false;
  $<HTMLButtonElement>('stop-mix').disabled = false;
  refreshDuck();
});

for (const id of ['sensitivity', 'min-silence', 'padding', 'speech-threshold', 'envelope-hold', 'speech-lead-in']) {
  $<HTMLInputElement>(id).addEventListener('input', refreshCut);
}
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', refreshCut);
}
for (const id of ['duck-db', 'hold', 'release']) {
  $<HTMLInputElement>(id).addEventListener('input', refreshDuck);
}

$<HTMLButtonElement>('play-original').addEventListener('click', () => {
  if (voice) playRanges(voice, [{ start: 0, end: voice.buffer.duration }]);
});
$<HTMLButtonElement>('play-cut').addEventListener('click', () => {
  if (voice && plan) playRanges(voice, plan.keep);
});
$<HTMLButtonElement>('stop-voice').addEventListener('click', stopAll);
$<HTMLButtonElement>('stop-mix').addEventListener('click', stopAll);
$<HTMLButtonElement>('play-bgm').addEventListener('click', () => {
  if (bgm) playRanges(bgm, [{ start: 0, end: bgm.buffer.duration }]);
});
$<HTMLButtonElement>('play-mix').addEventListener('click', () => playMix(true));
$<HTMLButtonElement>('play-flat').addEventListener('click', () => playMix(false));

$<HTMLButtonElement>('run-tests').addEventListener('click', () => {
  const results = runSelfTest();
  $<HTMLUListElement>('test-results').innerHTML = results
    .map((r) => `<li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? 'PASS' : 'FAIL'}</b><span>${r.name}</span><span>${r.detail}</span></li>`)
    .join('');
});

window.addEventListener('resize', () => {
  drawVoice();
  drawBgm();
});

refreshCut();
refreshDuck();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __lab: {
      selfTest: typeof runSelfTest;
      state: () => { voice: number | null; bgm: number | null; plan: JetCutPlan | null; duckPoints: GainPoint[] };
    };
  }
}
window.__lab = {
  selfTest: runSelfTest,
  state: () => ({
    voice: voice?.buffer.duration ?? null,
    bgm: bgm?.buffer.duration ?? null,
    plan,
    duckPoints,
  }),
};
