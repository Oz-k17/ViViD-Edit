/**
 * 自動リフレームの画面。
 *
 * ここは「読む・見せる」だけを受け持ち、判断はすべて純粋な関数
 * （`columns.ts` / `reframe.ts`）に任せている。本体へ持っていくときに要るのはそちらだけで、
 * このファイルは捨ててよい。
 *
 * **画面で判定をやり直さない。** シーン検出・拍の画面と同じ決め事で、`planReframe` を呼ぶ所を
 * 1 つに絞り、描画もプレビューも統計も、その 1 回の結果だけを見る。こうしておくと
 * `uitest.mjs` が「画面の枠」と「コマンドラインの枠」を同じ物差しで突き合わせられる。
 *
 * ## 読み込みは `scene-cut` のものを借りている
 *
 * `scene-cut/src/decode.ts` は**判断を置かない部品**（本物の動画 → `ImageData` の列）で、
 * 判定の側には何も混ざらない。リフレーム用にもう 1 本書くと、
 * 直すときに 2 か所直すことになるだけなので借りている。
 * `FrameLike` は両方とも `{ width, height, data }` なので、そのまま渡せる。
 *
 * ## 絵のほうは読み直さない（2026-09-25 に画面を作って分かったこと）
 *
 * 表紙の画面（`thumbnail`）では「測るコマ（長辺 128）」と「出す絵（実寸）」で
 * **読み込みが 2 本要った**。こちらは要らない——出口が 1 枚の絵ではなく
 * **枠の列**（`toCropRects`）なので、絵は元の動画を横へずらして覗くだけで足りる。
 * つまり縮めたコマは測るためだけに使い、人が見るほうは `<video>` がそのまま持っている。
 * **出口が「値」なのか「絵」なのかで、画面に要る読み込みの数が変わる。**
 *
 * ## 軸は 2 つあるが、画面は 1 枚（2026-10-04・2 回目に足した）
 *
 * 横（16:9 → 9:16・枠は横へ動く）と縦（9:16 → 1:1・枠は縦へ動く）を、同じページで切り替える。
 * **2 枚に分けなかったのは、軸で変わるものと変わらないものが実際に測れているから**——
 * 判定の側では枠を決める段（`planFromRaw`）が軸を知らず、入れ替わるのは
 * 畳む向きと被写体を指す手だけだった（2026-10-04 の記録）。
 * 画面の側も同じ形で、読み込み・時間軸の絵・つまみの配線・プレビューの骨格は共通で、
 * **軸で入れ替わるのは「どっちの辺を動かすか」だけ**。
 * 2 枚に分けると、この共通部分を直すときに 2 か所直すことになる。
 *
 * **ただし既定は軸ごとに別**（窓の幅 31.6% / 高さ 56.25%、見ない帯の置き所）なので、
 * 軸を替えたらつまみへ写し直す。ここを共通にすると、
 * **縦の軸に横の窓（31.6%）が残ったまま数字が出る**——画面だけが別の設定で動く形になる。
 */

import { decodeVideoFrames, type DecodedClip } from '../../scene-cut/src/decode.ts';
import type { Axis, ColumnStat } from './columns.ts';
import {
  DEFAULT_REFRAME,
  REFRAME_ANALYSIS_FPS,
  VERTICAL_REFRAME,
  planReframe,
  planReframeVertical,
  summarizeForReframe,
  summarizeForReframeVertical,
  toCropRects,
  type ReframeOptions,
  type ReframePlan,
} from './reframe.ts';
import { runSelfTest } from './selftest.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Loaded {
  name: string;
  clip: DecodedClip;
  /** 列（縦の軸では行）へ畳んだもの。**畳み方はつまみなので、そこが動いたら畳み直す。** */
  cols: ColumnStat[];
  band: number;
  /** どちらの軸へ畳んだか。**軸を替えると畳む向きが変わる**ので、一緒に持つ。 */
  axis: Axis;
  /** プレビュー用に持っておく元のファイル（`<video>` へ渡す）。 */
  url: string;
}

/**
 * いま決めている軸。`u` は横（16:9 から 9:16 を切る）、`v` は縦（9:16 から 1:1 を切る）。
 *
 * **画面の側で軸を持っているのはここだけ。** 判定の入口（畳む・指す・計画する）も
 * プレビューのずらし方も、全部この 1 つを見て選ぶ。
 */
let axis: Axis = 'u';

/** その軸の既定。**画面に直書きしない**ための入口（既定は判定の側が持っている）。 */
const defaultsFor = (a: Axis): ReframeOptions => (a === 'v' ? VERTICAL_REFRAME : DEFAULT_REFRAME);

let loaded: Loaded | null = null;
/** いまの設定で出した計画。**この 1 つだけを全部が見る。** */
let plan: ReframePlan | null = null;
/** 読み込みの順番待ち。シーン検出の画面と同じ理由（途中でつまみを回しても取りこぼさない）。 */
let chain: Promise<void> = Promise.resolve();
let loading = false;

function queueLoad(file: Blob & { name?: string }) {
  chain = chain.then(() => load(file)).catch(() => undefined);
}

// ---------- 読み込み ----------

$<HTMLInputElement>('rf-file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) queueLoad(file);
});

async function load(file: Blob & { name?: string }) {
  const status = $<HTMLParagraphElement>('rf-status');
  loading = true;
  status.className = 'status';
  status.textContent = `${file.name ?? '素材'} を読み込んでいます…`;
  try {
    const clip = await decodeVideoFrames(file, {
      fps: Number($<HTMLInputElement>('fps').value),
      onProgress: (ratio) => {
        status.textContent = `${file.name ?? '素材'} を読み込んでいます… ${Math.round(ratio * 100)}%`;
      },
    });
    if (loaded) URL.revokeObjectURL(loaded.url);
    const band = Number($<HTMLInputElement>('row-band').value);
    loaded = {
      name: file.name ?? '素材',
      clip,
      cols: fold(clip, band),
      band,
      axis,
      url: URL.createObjectURL(file),
    };
    status.textContent =
      `${loaded.name} ・ ${clip.duration.toFixed(2)} 秒 ・ ${clip.width}×${clip.height} ・ ` +
      `素材 ${clip.sourceFps.toFixed(1)}fps → 解析 ${clip.fps.toFixed(1)}fps（${clip.frames.length} コマ）`;
    attachPreview(loaded);
    refresh();
  } catch (e) {
    loaded = null;
    plan = null;
    status.className = 'status error';
    status.textContent = `この動画は、このブラウザでは読めませんでした（${e instanceof Error ? e.message : e}）`;
    draw();
    showStats();
  } finally {
    loading = false;
  }
}

// ---------- 判定（呼ぶのはここ 1 か所だけ） ----------

function band(half: number): { from: number; to: number } {
  // 0 は「落とさない」。`{ from: 0, to: 1 }` がそのまま全部を見る形なので、
  // ここで場合分けは要らない（潰れた帯にならないよう 0.45 で頭打ちにしてある）。
  const h = Math.min(0.45, Math.max(0, half));
  return { from: h, to: 1 - h };
}

function bandOption(half: number): Partial<ReframeOptions> {
  return { rowBand: band(half) };
}

/** いまの軸へ畳む。**入口を 1 つにしてある**のは、呼び分けを増やすと片方が古くなるから。 */
function fold(clip: DecodedClip, half: number): ColumnStat[] {
  const opt = bandOption(half);
  return axis === 'v'
    ? summarizeForReframeVertical(clip.frames, clip.times, opt)
    : summarizeForReframe(clip.frames, clip.times, opt);
}

function currentOptions(): Partial<ReframeOptions> {
  return {
    cropWidth: Number($<HTMLInputElement>('crop-width').value),
    deadband: Number($<HTMLInputElement>('deadband').value),
    gate: $<HTMLSelectElement>('gate').value as ReframeOptions['gate'],
    settle: Number($<HTMLInputElement>('settle').value),
    maxSpeed: Number($<HTMLInputElement>('max-speed').value),
    smooth: Number($<HTMLInputElement>('smooth').value),
    leadIn: $<HTMLInputElement>('lead-in').checked,
    // 軸の上で探してよい範囲。**横の軸では読まれない**（`rawTargets` が帯を取らない）が、
    // 渡す側で場合分けすると「渡したつもりの値」と「効いた値」が食い違うので、常に渡す。
    axisBand: band(Number($<HTMLInputElement>('axis-band').value)),
    ...bandOption(Number($<HTMLInputElement>('row-band').value)),
  };
}

/**
 * 畳み方が変わったときだけ畳み直す。
 *
 * 列へ畳むのはコマ 1 枚ずつ全画素を舐めるので、195 コマでも目に見えて重い。
 * **`rowBand` 以外のつまみは畳んだあとの話**なので、そこでは畳み直さない。
 */
function refresh() {
  if (!loaded) return;
  const half = Number($<HTMLInputElement>('row-band').value);
  // **軸が変わったときも畳み直し**（畳む向きそのものが変わるので、前の列は使えない）。
  if (half !== loaded.band || axis !== loaded.axis) {
    loaded.cols = fold(loaded.clip, half);
    loaded.band = half;
    loaded.axis = axis;
  }
  const options = currentOptions();
  plan = axis === 'v' ? planReframeVertical(loaded.cols, options) : planReframe(loaded.cols, options);
  draw();
  showStats();
  layoutPreview();
  syncPreview();
}

// ---------- 描画 ----------

/** キャンバスを画面の実寸に合わせる（ぼやけ防止）。他の画面と同じ形。 */
function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.dataset.height) || 160;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/**
 * 時間 × 画面の横位置で、枠の動きを描く。
 *
 * **縦を「画面の横位置」にしてあるのは、見たいものが位置そのものだから。**
 * 距離や点数のグラフにすると、「枠がどこに居たか」を数字から思い描く手間が要る。
 * 生の位置・ならしたあと・枠の帯を同じ面に重ねると、
 * **どこで遅れ、どこで置いていかれたか**がそのまま形に出る。
 */
function draw() {
  const canvas = $<HTMLCanvasElement>('rf-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.dataset.height) || 160;
  ctx.clearRect(0, 0, width, height);
  if (!loaded || !plan || !plan.frames.length) return;

  const duration = loaded.clip.duration || loaded.clip.frames.length / loaded.clip.fps;
  const toX = (t: number) => (t / Math.max(duration, 1e-6)) * width;
  const pad = 8;
  const toY = (u: number) => pad + u * (height - pad * 2);
  const half = plan.options.cropWidth / 2;

  // --- 枠の帯（窓の左端〜右端）。いちばん下に敷く ---
  ctx.fillStyle = 'rgba(183, 208, 168, 0.22)';
  ctx.beginPath();
  ctx.moveTo(toX(plan.frames[0].time), toY(plan.frames[0].center - half));
  for (const f of plan.frames) ctx.lineTo(toX(f.time), toY(f.center - half));
  for (let i = plan.frames.length - 1; i >= 0; i -= 1) {
    ctx.lineTo(toX(plan.frames[i].time), toY(plan.frames[i].center + half));
  }
  ctx.closePath();
  ctx.fill();

  // --- 枠が動いている区間。床に帯で出す（「いつ動いたか」は数より形で読みたい） ---
  ctx.fillStyle = 'rgba(164, 112, 122, 0.85)';
  for (let i = 1; i < plan.frames.length; i += 1) {
    if (Math.abs(plan.frames[i].center - plan.frames[i - 1].center) <= 0) continue;
    const x = toX(plan.frames[i - 1].time);
    ctx.fillRect(x, height - 5, Math.max(1, toX(plan.frames[i].time) - x), 4);
  }

  // --- 生の位置（その手が指した所）。点で出す ---
  //
  // **生の位置とならしたあとを両方描くのがこの画面の肝。** 枠が遅れているとき、
  // 原因が「生の位置が荒れている」のか「ならしが追い付いていない」のかは、
  // 片方だけ描いても読めない（それに気づいて `ReframeFrame.raw` を足した）。
  ctx.fillStyle = 'rgba(154, 183, 216, 0.5)';
  for (const f of plan.frames) ctx.fillRect(toX(f.time) - 1, toY(f.raw) - 1, 2, 2);

  // --- ならしたあと（中央値） ---
  ctx.strokeStyle = 'rgba(216, 184, 122, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  plan.frames.forEach((f, i) => {
    const x = toX(f.time);
    const y = toY(f.target);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // --- 枠の中心 ---
  ctx.strokeStyle = '#d8b87a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  plan.frames.forEach((f, i) => {
    const x = toX(f.time);
    const y = toY(f.center);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // --- いま見ている時刻 ---
  const video = $<HTMLVideoElement>('rf-video');
  if (video.readyState > 0) {
    ctx.strokeStyle = 'rgba(232, 233, 234, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(toX(video.currentTime)) + 0.5, 0);
    ctx.lineTo(Math.round(toX(video.currentTime)) + 0.5, height);
    ctx.stroke();
  }
}

// ---------- 出来上がりのプレビュー ----------

/**
 * 枠の列から、その秒の中心を読む。
 *
 * コマの間は**線で繋ぐ**。15fps で測って 30fps の動画を見せると、繋がないと
 * 枠が 2 コマに 1 回だけ動いて見える（実際には 0.0147 ずつ滑らかに寄っている）。
 */
export function centerAt(frames: { time: number; center: number }[], t: number): number {
  if (!frames.length) return 0.5;
  if (t <= frames[0].time) return frames[0].center;
  const last = frames[frames.length - 1];
  if (t >= last.time) return last.center;
  // 時刻は等間隔なので、割り算で当たりを付けてから 1 つずつ確かめる
  // （素材の速さの見積もりが甘い入れ物では、等間隔が崩れることがある）。
  let i = Math.min(frames.length - 2, Math.max(0, Math.floor((t - frames[0].time) / Math.max(1e-9, frames[1].time - frames[0].time))));
  while (i > 0 && frames[i].time > t) i -= 1;
  while (i < frames.length - 2 && frames[i + 1].time <= t) i += 1;
  const a = frames[i];
  const b = frames[i + 1];
  const k = (t - a.time) / Math.max(1e-9, b.time - a.time);
  return a.center + (b.center - a.center) * k;
}

function attachPreview(l: Loaded) {
  for (const id of ['rf-video', 'rf-video-out']) {
    const v = $<HTMLVideoElement>(id);
    v.src = l.url;
    v.load();
  }
  const seek = $<HTMLInputElement>('rf-seek');
  seek.max = String(l.clip.duration || 1);
  seek.value = '0';
  seek.disabled = false;
  $<HTMLButtonElement>('rf-play').disabled = false;
}

/**
 * 覗き窓の大きさを、いまの窓の幅（縦の軸では高さ）から決める。
 *
 * **基準の高さは `data-height` から読む。`clientHeight` は使えない**——
 * 縦の軸ではこの関数自身が高さを書き換えるので、2 度目に呼ぶと
 * **前回の答えが基準になって、呼ぶたびに窓が縮んでいく**（キャンバスの `fit()` と同じ形で、
 * あちらも高さを `data-height` から取っている）。
 */
function layoutPreview() {
  if (!loaded || !plan) return;
  const crop = $<HTMLDivElement>('rf-crop');
  const out = $<HTMLVideoElement>('rf-video-out');
  const base = Number(crop.dataset.height) || 320;
  const aspect = loaded.clip.width / Math.max(1, loaded.clip.height);
  const videoWidth = base * aspect;
  out.style.width = `${videoWidth}px`;
  out.style.height = `${base}px`;
  // 元の画は欄の幅いっぱいに描く（窓は割合で重ねるので大きさに依らない）。
  // **縦の素材だけは幅で決めると高さが欄の幅の 1.8 倍**になり、画面の大半を元の画が占める
  // （2026-10-04・2 回目に撮った画面で、元の画が 1600px 近くまで伸びていた）。
  // 縦長の素材では出来上がりの 2 倍の高さに抑える。
  $<HTMLDivElement>('rf-source').style.maxWidth = aspect < 1 ? `${base * 2 * aspect}px` : '';
  if (axis === 'v') {
    // 出来上がりの形は「もとの形 × 窓の高さ」。9:16 を 56.25% で切ると 1:1 になる。
    crop.style.width = `${videoWidth}px`;
    crop.style.height = `${base * plan.options.cropWidth}px`;
  } else {
    // 横は「もとの形 × 窓の幅」。16:9 を 31.6% で切ると 9:16 になる。
    crop.style.width = `${videoWidth * plan.options.cropWidth}px`;
    crop.style.height = `${base}px`;
  }
}

/** いまの時刻の枠を、元の画の上と出来上がりの側の両方へ反映する。 */
function syncPreview() {
  if (!loaded || !plan) return;
  const video = $<HTMLVideoElement>('rf-video');
  const t = video.currentTime;
  const center = centerAt(plan.frames, t);
  const w = plan.options.cropWidth;

  // 元の画に重ねる窓は、どちらの軸でも割合のまま置ける。
  // **4 辺ぜんぶを JS から入れている**のは、片方の軸ぶんを CSS に残すと
  // 軸を替えたときに前の軸の値が残って、窓が画面の外へ出るため。
  const win = $<HTMLDivElement>('rf-window');
  const out = $<HTMLVideoElement>('rf-video-out');
  if (axis === 'v') {
    win.style.left = '0';
    win.style.width = '100%';
    win.style.top = `${(center - w / 2) * 100}%`;
    win.style.height = `${w * 100}%`;
    // 出来上がりの側は、動画そのものを縦へずらす。
    out.style.transform = `translateY(${-(center - w / 2) * (out.clientHeight || 0)}px)`;
  } else {
    win.style.top = '0';
    win.style.height = '100%';
    win.style.left = `${(center - w / 2) * 100}%`;
    win.style.width = `${w * 100}%`;
    out.style.transform = `translateX(${-(center - w / 2) * (out.clientWidth || 0)}px)`;
  }
  $<HTMLOutputElement>('out-time').textContent = `${t.toFixed(2)}s`;
}

/**
 * 2 本の `<video>` の時刻を揃える。
 *
 * **1 本にして左右へ 2 回描く**手もあるが、それには毎コマ canvas へ写す必要がある。
 * `<video>` を 2 本置いて片方を親にするほうが、ブラウザの再生に任せられて軽い。
 * ずれるのは再生の頭くらいなので、そこだけ合わせ直す。
 */
let shownTime = -1;
function followMaster() {
  const master = $<HTMLVideoElement>('rf-video');
  const slave = $<HTMLVideoElement>('rf-video-out');
  if (Math.abs(slave.currentTime - master.currentTime) > 0.08) slave.currentTime = master.currentTime;
  if (master.paused !== slave.paused) {
    if (master.paused) slave.pause();
    else void slave.play();
  }
  // **時刻が動いたときだけ描き直す。** 毎コマ描き直すと、止めているあいだも
  // 195 コマぶんの線を引き続けることになる（画は 1 ミリも変わらないのに）。
  if (master.currentTime !== shownTime) {
    shownTime = master.currentTime;
    syncPreview();
    $<HTMLInputElement>('rf-seek').value = String(master.currentTime);
    draw();
  }
  requestAnimationFrame(followMaster);
}
requestAnimationFrame(followMaster);

$<HTMLButtonElement>('rf-play').addEventListener('click', () => {
  const video = $<HTMLVideoElement>('rf-video');
  if (video.paused) void video.play();
  else video.pause();
  $<HTMLButtonElement>('rf-play').textContent = video.paused ? '再生' : '一時停止';
});

$<HTMLInputElement>('rf-seek').addEventListener('input', () => {
  const t = Number($<HTMLInputElement>('rf-seek').value);
  $<HTMLVideoElement>('rf-video').currentTime = t;
  $<HTMLVideoElement>('rf-video-out').currentTime = t;
});

// ---------- 統計 ----------

function stat(term: string, value: string, none = false) {
  return `<div><dt>${term}</dt><dd${none ? ' class="none"' : ''}>${value}</dd></div>`;
}

function showStats() {
  const box = $<HTMLDListElement>('rf-stats');
  const warn = $<HTMLParagraphElement>('rf-warning');
  if (!loaded || !plan || !plan.frames.length) {
    box.innerHTML = '';
    warn.hidden = true;
    return;
  }

  const seconds = plan.frames[plan.frames.length - 1].time - plan.frames[0].time;
  const centers = plan.frames.map((f) => f.center);
  let runs = 0;
  let open = false;
  for (let i = 1; i < centers.length; i += 1) {
    const moved = Math.abs(centers[i] - centers[i - 1]) > 0;
    if (moved && !open) runs += 1;
    open = moved;
  }
  const rect = toCropRects(plan)[0];

  box.innerHTML = [
    stat('読んだコマ', `${loaded.clip.frames.length} 枚`),
    stat('解析の速さ', `${loaded.clip.fps.toFixed(1)} fps`),
    stat('素材の速さ', `${loaded.clip.sourceFps.toFixed(1)} fps`),
    stat(axis === 'v' ? '窓の高さ' : '窓の幅', `${(plan.options.cropWidth * 100).toFixed(1)}%`),
    stat('泳いだ量', `${(seconds > 0 ? plan.travel / seconds : 0).toFixed(3)} / 秒`),
    stat('動いた回数', `${runs} 回`, runs === 0),
    stat('枠の振れ幅', `${(Math.max(...centers) - Math.min(...centers)).toFixed(3)}`),
    stat('頭の置き所', `${axis === 'v' ? 'y' : 'x'} ${rect.x.toFixed(3)}`),
  ].join('');

  // 知らせるのは「そのまま読むと数字が変わる」ときだけ。
  const messages: string[] = [];
  if (loaded.clip.truncated) {
    messages.push(
      `<strong>尺が長いので途中まで（${loaded.clip.frames.length} コマ）で切りました。</strong>` +
        'この先の枠は出てきません。',
    );
  }
  if (plan.options.cropWidth >= 1) {
    messages.push(
      axis === 'v'
        ? '<strong>窓が画面と同じ高さです。</strong>切る余りが無いので、枠は真ん中で止まります。'
        : '<strong>窓が画面と同じ幅です。</strong>切る余りが無いので、枠は真ん中で止まります。',
    );
  }
  // **泳ぎは「多い」ではなく「動く理由が無いのに動いた」が問題。** 数だけ出すと読めないので、
  // 測った台（被写体の居ない素材の中央値 0.006 / 秒）と並べて出す。
  //
  // **台は軸ごとに別の数字**（横は 20 本の中央値 0.006 / 秒、縦は 0.002 / 秒）。
  // ここを 1 つにすると、縦で「台より 3 倍泳いでいる」形が台に埋もれる。
  const swim = seconds > 0 ? plan.travel / seconds : 0;
  if (swim > 0.1) {
    const idle = axis === 'v' ? '0.002' : '0.006';
    const worst = axis === 'v' ? 'チルト（tilt で 0.131 / 秒）' : 'パン・チルト（pan-reveal で 0.158 / 秒）';
    messages.push(
      `<strong>枠が 1 秒あたり ${swim.toFixed(3)} 泳いでいます。</strong>` +
        `被写体の居ない素材で測った中央値は ${idle} / 秒で、0.1 を超えるのは` +
        `<strong>カメラが動いている素材</strong>です（${worst}）。そこはまだ空いている穴です。`,
    );
  }
  warn.hidden = messages.length === 0;
  warn.innerHTML = messages.join('<br>');
}

// ---------- つまみの配線 ----------

function showValue(id: string, outId: string, format: (v: number) => string) {
  $<HTMLOutputElement>(outId).textContent = format(Number($<HTMLInputElement>(id).value));
}

function showAllValues() {
  showValue('fps', 'out-fps', (v) => `${v} fps`);
  showValue('crop-width', 'out-crop', (v) => `${(v * 100).toFixed(1)}%`);
  showValue('deadband', 'out-dead', (v) => `${(v * 100).toFixed(1)}%`);
  showValue('settle', 'out-settle', (v) => `${v.toFixed(2)} 秒`);
  showValue('max-speed', 'out-speed', (v) => `${(v * 100).toFixed(0)}% / 秒`);
  showValue('smooth', 'out-smooth', (v) => `${v.toFixed(2)} 秒（${Math.max(1, Math.round(v * currentFps()))} コマ）`);
  showValue('row-band', 'out-band', (v) =>
    v > 0 ? `${axis === 'v' ? '左右' : '上下'} ${(v * 100).toFixed(0)}% を見ない` : '全部見る',
  );
  showValue('axis-band', 'out-axis-band', (v) =>
    v > 0 ? `上下 ${(v * 100).toFixed(0)}% には置かない` : '画面ぜんたいに置ける',
  );
}

// ---------- 軸の切り替え ----------

/**
 * 軸で入れ替わる文字。**判定の側から来る数字と同じ所に置いている**ので、
 * ここが抜けると「縦の軸なのに『元の画（16:9）』」のような、黙って嘘をつく画面になる。
 */
const AXIS_TEXT = {
  u: {
    out: '2. 切り出した縦型（9:16）を見る',
    legend: '縦が<strong>画面の横位置</strong>（上が左端・下が右端）、横が時間です',
    crop: '切り出す窓の幅',
    band: '列へ畳むときに見る縦の範囲',
    source: '元の画（16:9）と、いま切っている窓',
    result: '出来上がり（9:16）',
    axis: '枠は<strong>横</strong>へ動きます',
  },
  v: {
    out: '2. 切り出した 1:1 を見る',
    legend: '縦が<strong>画面の縦位置</strong>（上が上端・下が下端）、横が時間です',
    crop: '切り出す窓の高さ',
    band: '行へ畳むときに見る横の範囲',
    source: '元の画（9:16）と、いま切っている窓',
    result: '出来上がり（1:1）',
    axis: '枠は<strong>縦</strong>へ動きます',
  },
} as const;

/**
 * つまみへ、その軸の既定を写す。
 *
 * **軸ごとに別の既定を持っているので、軸を替えたら写し直すほかない**
 * （共通にすると、縦の軸に横の窓 31.6% が残ったまま数字が出る）。
 * つまみを手で回したあとに軸を往復すると、その手入れは消える——
 * **既定が食い違ったまま数字が出るより、消えるほうがましだと決めた。**
 */
function writeDefaults(a: Axis) {
  const d = defaultsFor(a);
  $<HTMLInputElement>('crop-width').value = String(d.cropWidth);
  $<HTMLInputElement>('deadband').value = String(d.deadband);
  $<HTMLInputElement>('settle').value = String(d.settle);
  $<HTMLInputElement>('max-speed').value = String(d.maxSpeed);
  $<HTMLInputElement>('smooth').value = String(d.smooth);
  $<HTMLInputElement>('row-band').value = String(d.rowBand.from);
  $<HTMLInputElement>('axis-band').value = String(d.axisBand.from);
  $<HTMLInputElement>('lead-in').checked = d.leadIn;
  $<HTMLSelectElement>('gate').value = d.gate;
}

function applyAxisText(a: Axis) {
  const t = AXIS_TEXT[a];
  $<HTMLElement>('sec-out').textContent = t.out;
  $<HTMLElement>('legend-axis').innerHTML = t.legend;
  $<HTMLElement>('label-crop').textContent = t.crop;
  $<HTMLElement>('label-band').textContent = t.band;
  $<HTMLElement>('cap-source').textContent = t.source;
  $<HTMLElement>('cap-out').textContent = t.result;
  $<HTMLElement>('axis-note').innerHTML = t.axis;
  // 横の軸では `axisBand` が読まれないので、つまみも出さない
  // （出したまま効かないつまみは、回してから「効かない」と気づくことになる）。
  for (const el of document.querySelectorAll<HTMLElement>('[data-for-axis]')) {
    el.hidden = el.dataset.forAxis !== a;
  }
}

$<HTMLSelectElement>('axis').addEventListener('change', () => {
  axis = $<HTMLSelectElement>('axis').value === 'v' ? 'v' : 'u';
  writeDefaults(axis);
  applyAxisText(axis);
  showAllValues();
  // **読み直しは要らない。** 畳む向きが変わるだけなので、`refresh()` の中で畳み直される
  // （読み込みは軸を知らない——`decode.ts` は長辺を 128 に揃えるだけ）。
  refresh();
});

/** いま何 fps で測っているか。**コマ数を秒でも見せる**ために要る（シーン検出の画面と同じ）。 */
function currentFps(): number {
  return loaded?.clip.fps ?? Number($<HTMLInputElement>('fps').value) ?? REFRAME_ANALYSIS_FPS;
}

for (const id of ['crop-width', 'deadband', 'settle', 'max-speed', 'smooth', 'row-band', 'axis-band']) {
  $<HTMLElement>(id).addEventListener('input', () => {
    showAllValues();
    refresh();
  });
}
$<HTMLElement>('lead-in').addEventListener('change', refresh);
// 門の形は畳んだあとの話なので、畳み直さずに引き直すだけでよい。
$<HTMLElement>('gate').addEventListener('change', refresh);

// コマの速さは**何を読むか**の話なので、こちらだけは読み直しになる。
$<HTMLElement>('fps').addEventListener('change', () => {
  showAllValues();
  const file = $<HTMLInputElement>('rf-file').files?.[0];
  if (file) queueLoad(file);
});
$<HTMLElement>('fps').addEventListener('input', showAllValues);

$<HTMLButtonElement>('run-tests').addEventListener('click', () => {
  const results = runSelfTest();
  $<HTMLUListElement>('test-results').innerHTML = results
    .map(
      (r) =>
        `<li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? 'PASS' : 'FAIL'}</b><span>${r.name}</span><span>${r.detail}</span></li>`,
    )
    .join('');
});

window.addEventListener('resize', () => {
  draw();
  layoutPreview();
  syncPreview();
});

// 既定は判定の側（`reframe.ts` / `decode.ts`）が持っている。**画面に直書きしたままにすると黙って食い違う**ので、
// 起動時にそちらから写す（HTML に書いてある値は、この行が動く前の見た目のため）。
$<HTMLSelectElement>('axis').value = axis;
writeDefaults(axis);
applyAxisText(axis);
$<HTMLInputElement>('fps').value = String(REFRAME_ANALYSIS_FPS);
showAllValues();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __labReframe: {
      selfTest: typeof runSelfTest;
      /**
       * 画面が使っている既定（コマンドラインと同じ所から来ているかの確認用）。
       *
       * **軸ごとに 2 つ出す。** 1 つにまとめて「いまの軸の既定」だけを返すと、
       * 画面が既定を写し忘れていても**そのとき写っている値**が返ってきて、確認が素通りする。
       */
      defaults: { reframe: ReframeOptions; vertical: ReframeOptions; analysisFps: number };
      /** その秒の中心（プレビューが見ているのと同じ値）。 */
      centerAt: (t: number) => number;
      /**
       * その秒のコマの、**軸の上の**明るさ（32 本）。横の軸では列、縦の軸では行。
       *
       * **画面に映っている絵が本当に枠の所か**を確かめるために置いてある。
       * 枠の数字が合っていても、ずらす向きを間違えていれば人が見る絵は別の所になる。
       * 畳んだものをそのまま返すので、**軸を替えれば中身も入れ替わる**
       * （確かめる側は「軸の上に並んだ 32 本」として読めばよく、向きを知らなくて済む）。
       */
      columnLuma: (t: number) => number[];
      state: () => {
        /** 読み込みの最中か。**数字を読む前にこれが false であることを確かめる。** */
        loading: boolean;
        /** いまどちらの軸で決めているか。 */
        axis: Axis;
        duration: number | null;
        frames: number;
        width: number | null;
        height: number | null;
        sourceFps: number | null;
        fps: number | null;
        missing: number;
        truncated: boolean;
        /** コマごとの時刻と枠の中心。`bench.mjs` と同じ物差しに載せるため。 */
        times: number[];
        centers: number[];
        /** 生の位置（ならす前）。画面が「荒れ」を測るのに使う。 */
        raws: number[];
        /** ならしたあと。 */
        targets: number[];
        cropWidth: number;
        /** 畳むときに見た、軸と垂直の範囲（確かめる側が同じ所だけを見るために要る）。 */
        rowBand: { from: number; to: number };
        travel: number;
      };
    };
  }
}
window.__labReframe = {
  selfTest: runSelfTest,
  defaults: { reframe: DEFAULT_REFRAME, vertical: VERTICAL_REFRAME, analysisFps: REFRAME_ANALYSIS_FPS },
  centerAt: (t: number) => centerAt(plan?.frames ?? [], t),
  columnLuma: (t: number) => {
    if (!loaded || !loaded.cols.length) return [];
    let best = 0;
    for (let i = 1; i < loaded.cols.length; i += 1) {
      if (Math.abs(loaded.cols[i].time - t) < Math.abs(loaded.cols[best].time - t)) best = i;
    }
    return [...loaded.cols[best].luma];
  },
  state: () => ({
    loading,
    axis,
    duration: loaded?.clip.duration ?? null,
    frames: loaded?.clip.frames.length ?? 0,
    width: loaded?.clip.width ?? null,
    height: loaded?.clip.height ?? null,
    sourceFps: loaded?.clip.sourceFps ?? null,
    fps: loaded?.clip.fps ?? null,
    missing: loaded?.clip.missing ?? 0,
    truncated: loaded?.clip.truncated ?? false,
    times: plan?.frames.map((f) => f.time) ?? [],
    centers: plan?.frames.map((f) => f.center) ?? [],
    raws: plan?.frames.map((f) => f.raw) ?? [],
    targets: plan?.frames.map((f) => f.target) ?? [],
    cropWidth: plan?.options.cropWidth ?? defaultsFor(axis).cropWidth,
    rowBand: plan?.options.rowBand ?? defaultsFor(axis).rowBand,
    travel: plan?.travel ?? 0,
  }),
};
