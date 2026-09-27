/**
 * キーフレームの画面。**打点を置く・つまむ・繋ぎ方を選ぶ**所と、そこから出る絵。
 *
 * ここは「見せる・受ける」だけを受け持ち、判断はすべて純粋な関数
 * （`value.ts` / `track.ts` / `timebase.ts` / `compose.ts`）に任せている。
 * 本体へ持っていくときに要るのはそちらだけで、このファイルは捨ててよい。
 *
 * **画面で計算をやり直さない。** ほかの 5 つの画面と同じ決め事で、値を読む所は
 * `sampleClipValue()`、絵にする所は `composeAt()`、ずれを測る所は `scoreAgainst()` の
 * 1 本ずつに絞ってある。こうしておくと `uitest.mjs` が
 * 「画面に出ている数字」と「コマンドラインの数字」を同じ物差しで突き合わせられる。
 *
 * ## 画面を作って要ったもの（9/27 の 1 回目には無かったもの）
 *
 * 1. **逆向きの写し**（`timeAtKeyTime()`）。打点の秒は時間軸ごとに意味が違うので、
 *    3 通りを見比べられる形に並べるには「打点 → タイムラインの秒」が要る。
 *    読むだけなら片道で足りるので、測定にも本体へ差す形にも出てこなかった。
 * 2. **丸めない前向きの写し**（`keyTimeInUnclamped()`）。本体の `sourceTimeAt()` は
 *    クリップの頭で丸めるので、**頭より前に居る打点を掴むと張り付く。**
 *    「刈らない」と決めた打点はまさにそこに居る。
 * 3. **打点が 0 個のときに時間軸を渡す口**（`putKeyAtTime(..., base)`）。
 *    時間軸は値と一緒に持っているので、**打点が 1 つも無い値には時間軸が残っていない。**
 */

import {
  keysOf,
  normalizeKeys,
  type Ease,
  type Keyframe,
} from './value.ts';
import {
  defaultTrackBase,
  isKeyedTrack,
  keyTimeInUnclamped,
  keysOfTrack,
  sampleClipValue,
  putKeyAtTime,
  removeKeyAt,
  setTrackBase,
  timeAtKeyTime,
  trackBaseIn,
  type AnimatedTrack,
  type TrackBase,
} from './track.ts';
import { applyOp, clipEnd, editOps, type EditOp, type LabClip, type TimeBase } from './timebase.ts';
import {
  baseClip,
  EXACT,
  SCENARIOS,
  scoreAgainst,
  worstError,
  type Intended,
  type Scenario,
} from './scenarios.ts';
import { composeAt, VALUE_FALLBACK, VALUE_RANGE, type Composed, type ValueName } from './compose.ts';
import { runSelfTest } from './selftest.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 画面で選べる時間軸。`absolute` は測って捨てたので出さない。 */
const TRACK_BASES: TrackBase[] = ['source', 'local', 'fraction'];
const EASES: Ease[] = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut'];
/** ずれを測るコマの速さ。`probe.mjs` と同じでないと数字を突き合わせられない。 */
const SCORE_FPS = 30;
/** 素材の絵の大きさ（合成の絵）。16:9 を 9:16 に収めるので、上下が切れる形になる。 */
const MEDIA: { width: number; height: number } = { width: 1280, height: 720 };
const FRAME = { width: 270, height: 480 };

/** 素材ごとに、値を何に効かせて見せるか（素材が書いている数の意味に近いほう）。 */
const SHOW_AS: Record<string, ValueName> = {
  'video-punch': 'scale',
  'video-2x': 'opacity',
  'audio-duck': 'opacity',
  'video-fade-in': 'opacity',
  'text-intro': 'opacity',
  'image-kenburns': 'scale',
};

const OP_LABELS: Record<string, string> = {
  move: '掴んで動かす',
  trimLeft: '頭を詰める',
  trimRight: '尻を詰める',
  split: '割る',
  setSpeed: '速さを変える',
  rippleShift: 'リップルで詰まる',
};

interface State {
  scenario: Scenario;
  /**
   * **打点が 0 個のときの値**（`number` か `{ base, v }`）。時間軸の置き場所でもある。
   *
   * 2026-09-27 の 2 回目まで、ここは `base: TrackBase` という**画面が自分で覚える欄**だった。
   * 3 回目に畳んだ形（`StillTrack`）が軸を持つようになったので、
   * **画面は覚えるのをやめて、値の側から読む**（`baseNow()`）。
   * 打点があるあいだ読むのは `base` だけで、`v` は畳んだときに `removeKeyAt()` が入れ直す。
   */
  seat: AnimatedTrack;
  valueName: ValueName;
  /** いまのクリップ（編集を当てたあと）。 */
  clip: LabClip;
  /**
   * 打点の列。**ドラッグ中は並んでいないことがある**ので、読むときは必ず `sortedKeys()` を通す。
   * 掴んでいる打点を番号で追いかけるため、生の順を保っている。
   */
  keys: Keyframe[];
  selected: number;
  fadeIn: number;
  fadeOut: number;
  applyFade: boolean;
  time: number;
  /** 当てた編集（時間軸を替えて同じ順で当て直せるように、名前と「割ったどちらを持つか」だけ持つ）。 */
  log: { op: string; pick: number }[];
  /** 期待の土台。**最初の編集を当てる直前の状態**で固める（そこが「人が書いた曲線」）。 */
  intended: Intended | null;
  /** 打点が重なって畳まれた回数（つまんで通り過ぎたときに起きる）。 */
  absorbed: number;
}

const first = SCENARIOS[0];
const state: State = {
  scenario: first,
  seat: first.fallback,
  valueName: SHOW_AS[first.name],
  clip: baseClip(first),
  keys: [],
  selected: -1,
  fadeIn: 0,
  fadeOut: 0,
  applyFade: true,
  time: first.start,
  log: [],
  intended: null,
  absorbed: 0,
};

// ---------- 値とクリップ ----------

const sortedKeys = (): Keyframe[] => normalizeKeys(state.keys);

/**
 * いま読むときの時間軸。**画面は覚えず、値から読む。**
 *
 * 覚えると、覚えた側と値の側が食い違ったときに黙ってずれる（`track.ts` の `trackBaseIn()` の注）。
 */
const baseNow = (): TrackBase => trackBaseIn(state.clip, state.seat);

/**
 * いまの曲線。**打点が 1 つも無ければ畳んだ形**（素の数、または軸を覚えている `{ base, v }`）。
 *
 * `fallback` に素材の既定（`scenario.fallback`）を使うのは、
 * `probe.mjs` が測っているのと同じ値でないと数字を突き合わせられないため。
 */
function curve(): AnimatedTrack {
  const keys = sortedKeys();
  return keys.length > 0 ? { base: baseNow(), keys } : state.seat;
}

/**
 * いまのクリップ（曲線を入れた形）。編集の操作と採点はこれを見る。
 *
 * **畳んだ形はここで数へ落とす。** `LabClip.value` は `Animated`（素の数か打点の列）なので、
 * `{ base, v }` をそのまま通すと `shiftKeys()` などが `keys` を読んで落ちる
 *（付け替えを書く道に入ったときだけ出る穴なので、いまの `raw` では表に出ない）。
 * 落とすときの値は読んだ値そのままなので、絵も採点も変わらない。
 */
function clipNow(): LabClip {
  const c = curve();
  return {
    ...state.clip,
    value: isKeyedTrack(c) ? c : sampleClipValue(state.clip, c, state.time, state.scenario.fallback),
  };
}

/** 絵にするための 4 値。**動かすのは 1 本だけで、残りは素の数のまま。** */
function tracks(): { scale: AnimatedTrack; x: AnimatedTrack; y: AnimatedTrack; opacity: AnimatedTrack } {
  const out = {
    scale: VALUE_FALLBACK.scale as AnimatedTrack,
    x: VALUE_FALLBACK.x as AnimatedTrack,
    y: VALUE_FALLBACK.y as AnimatedTrack,
    opacity: VALUE_FALLBACK.opacity as AnimatedTrack,
  };
  out[state.valueName] = curve();
  return out;
}

function composed(time = state.time): Composed {
  return composeAt(
    { ...state.clip, fadeIn: state.fadeIn, fadeOut: state.fadeOut },
    tracks(),
    time,
    FRAME,
    MEDIA,
    state.applyFade,
  );
}

/** その素材の編集の操作（引数は素材が持っている）。**割る所だけクリップの中へ寄せる。** */
function opsFor(s: Scenario): EditOp[] {
  return editOps({
    moveBy: s.edits.moveBy,
    trimHead: s.edits.trimHead,
    trimTail: s.edits.trimTail,
    // 何度も割ると素材が書いた秒がクリップの外へ出るので、内側へ寄せる（尺 0.1 秒は本体の最小）。
    splitAt: (c) => Math.min(clipEnd(c) - 0.1, Math.max(c.start + 0.1, s.edits.splitAt)),
    speedTo: s.edits.speedTo,
    rippleBy: s.edits.rippleBy,
  });
}

// ---------- 素材の読み込み（任意） ----------

type Media =
  | { kind: 'synthetic' }
  | { kind: 'video'; el: HTMLVideoElement; url: string }
  | { kind: 'image'; el: HTMLImageElement; url: string };

let media: Media = { kind: 'synthetic' };
/** 合成の絵。**素材の秒を焼き込んである**ので、`source` の打点が絵に付いているか目で見える。 */
const synthetic = document.createElement('canvas');
synthetic.width = MEDIA.width;
synthetic.height = MEDIA.height;

function drawSynthetic(sourceTime: number) {
  const ctx = synthetic.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = MEDIA;
  ctx.fillStyle = '#1b2030';
  ctx.fillRect(0, 0, w, h);
  // 升目。拡大と位置が効いているかは、模様が無いと分からない。
  const cell = 80;
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      if (((x / cell) | 0) % 2 === ((y / cell) | 0) % 2) continue;
      ctx.fillStyle = 'rgba(183, 208, 168, 0.10)';
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.strokeStyle = 'rgba(232, 233, 234, 0.25)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  // そのコマが素材の何秒かを焼く。`source` の打点は、この数字に付いていなければ間違い。
  ctx.fillStyle = '#e8e9ea';
  ctx.font = '600 92px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`素材 ${sourceTime.toFixed(2)}s`, w / 2, h / 2);
  // コマを見分けるための印（素材の秒で回る）。数字だけだと動きが読めない。
  const angle = sourceTime * 1.2;
  ctx.fillStyle = '#d8b87a';
  ctx.beginPath();
  ctx.arc(w / 2 + Math.cos(angle) * 240, h / 2 + Math.sin(angle) * 150, 22, 0, Math.PI * 2);
  ctx.fill();
}

function mediaSource(): CanvasImageSource {
  if (media.kind === 'synthetic') return synthetic;
  return media.el;
}

function mediaSize(): { width: number; height: number } {
  if (media.kind === 'video') {
    return { width: media.el.videoWidth || MEDIA.width, height: media.el.videoHeight || MEDIA.height };
  }
  if (media.kind === 'image') {
    return { width: media.el.naturalWidth || MEDIA.width, height: media.el.naturalHeight || MEDIA.height };
  }
  return MEDIA;
}

$<HTMLInputElement>('kf-file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (media.kind !== 'synthetic') URL.revokeObjectURL(media.url);
  const url = URL.createObjectURL(file);
  const status = $<HTMLParagraphElement>('kf-status');
  if (file.type.startsWith('image/')) {
    const el = new Image();
    el.onload = () => {
      media = { kind: 'image', el, url };
      drawAll();
    };
    el.onerror = () => {
      status.className = 'status error';
      status.textContent = 'この画像は読めませんでした。';
    };
    el.src = url;
    return;
  }
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  // 絵を出すだけなので読み込みは待つ。`seeked` で描き直すのは、
  // **素材の秒へ飛ばしてから描かないと、前のコマが出たままになる**ため。
  el.addEventListener('loadeddata', () => {
    media = { kind: 'video', el, url };
    drawAll();
  });
  el.addEventListener('seeked', drawPreview);
  el.addEventListener('error', () => {
    status.className = 'status error';
    status.textContent = 'この動画は、このブラウザでは読めませんでした。';
  });
  el.src = url;
  el.load();
});

// ---------- 曲線のキャンバス ----------

interface View {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
  width: number;
  height: number;
  pad: number;
}

/**
 * 見せる範囲。**クリップの範囲と、打点が立っている所の両方を入れる。**
 *
 * クリップの範囲だけに切ると、**頭を詰めて外に出た打点が画面から消える。**
 * 消さないと決めた（9/27）ものが見えなくなるのは画面の側の嘘なので、外も入れて描く。
 */
function view(): View {
  const canvas = $<HTMLCanvasElement>('kf-curve');
  const clip = state.clip;
  const times = sortedKeys().map((k) => timeAtKeyTime(baseNow(), clip, k.t));
  const lo = Math.min(clip.start, ...times);
  const hi = Math.max(clipEnd(clip), ...times);
  const span = Math.max(0.5, hi - lo);
  const values = [state.scenario.fallback, ...sortedKeys().map((k) => k.v)];
  const vLo = Math.min(...values);
  const vHi = Math.max(...values);
  const vPad = Math.max(0.05, (vHi - vLo) * 0.2);
  return {
    t0: lo - span * 0.06,
    t1: hi + span * 0.06,
    v0: vLo - vPad,
    v1: vHi + vPad,
    width: canvas.clientWidth || 800,
    height: Number(canvas.dataset.height) || 260,
    pad: 26,
  };
}

const toPixel = (v: View, t: number, value: number) => ({
  x: v.pad + ((t - v.t0) / (v.t1 - v.t0)) * (v.width - v.pad * 2),
  y: v.height - v.pad - ((value - v.v0) / (v.v1 - v.v0)) * (v.height - v.pad * 2),
});

const fromPixel = (v: View, x: number, y: number) => ({
  time: v.t0 + ((x - v.pad) / (v.width - v.pad * 2)) * (v.t1 - v.t0),
  value: v.v0 + ((v.height - v.pad - y) / (v.height - v.pad * 2)) * (v.v1 - v.v0),
});

/** キャンバスを画面の実寸に合わせる（ぼやけ防止）。ほかの画面と同じ形。 */
function fit(canvas: HTMLCanvasElement, height: number): CanvasRenderingContext2D | null {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 800;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

function drawCurve() {
  const canvas = $<HTMLCanvasElement>('kf-curve');
  const v = activeView();
  const ctx = fit(canvas, v.height);
  if (!ctx) return;
  ctx.clearRect(0, 0, v.width, v.height);

  const clip = state.clip;
  const left = toPixel(v, clip.start, v.v1).x;
  const right = toPixel(v, clipEnd(clip), v.v1).x;

  // --- クリップの範囲。曲線が「在る」のはここだけ ---
  ctx.fillStyle = 'rgba(183, 208, 168, 0.10)';
  ctx.fillRect(left, v.pad * 0.5, right - left, v.height - v.pad);
  ctx.strokeStyle = 'rgba(183, 208, 168, 0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(left, v.pad * 0.5, right - left, v.height - v.pad);

  // --- 目盛り（値の上下と、クリップの頭・尻の秒） ---
  ctx.fillStyle = 'rgba(154, 160, 166, 0.9)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(v.v1.toFixed(2), 4, toPixel(v, v.t0, v.v1).y);
  ctx.fillText(v.v0.toFixed(2), 4, toPixel(v, v.t0, v.v0).y);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${clip.start.toFixed(2)}s`, left, v.height - 4);
  ctx.fillText(`${clipEnd(clip).toFixed(2)}s`, right, v.height - 4);

  // --- 曲線。クリップの中だけを引く（外はそもそも描かれない時刻） ---
  ctx.strokeStyle = '#d8b87a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const step = 1;
  for (let x = left; x <= right; x += step) {
    const t = fromPixel(v, x, 0).time;
    const value = composed(t).values[state.valueName];
    const y = toPixel(v, t, value).y;
    if (x === left) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // --- いま見ている時刻 ---
  const px = Math.round(toPixel(v, state.time, 0).x) + 0.5;
  ctx.strokeStyle = 'rgba(232, 233, 234, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, v.pad * 0.5);
  ctx.lineTo(px, v.height - v.pad * 0.5);
  ctx.stroke();

  // --- 打点。クリップの外に居るものは色を変える（消さないと決めたものなので、見せる） ---
  sortedKeys().forEach((k, i) => {
    const t = timeAtKeyTime(baseNow(), clip, k.t);
    const p = toPixel(v, t, k.v);
    const outside = t < clip.start - 1e-9 || t > clipEnd(clip) + 1e-9;
    ctx.fillStyle = outside ? 'rgba(164, 112, 122, 0.95)' : '#b7d0a8';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    if (i === state.selected) {
      ctx.strokeStyle = '#e8e9ea';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 繋ぎ方が `linear` でないものは、そこから次までの線種を変えて出す。
    if (k.ease && k.ease !== 'linear') {
      ctx.fillStyle = 'rgba(154, 160, 166, 0.9)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(k.ease, p.x + 7, p.y - 5);
    }
  });
}

// ---------- つまむ ----------

/** その画素にいちばん近い打点（10 画素まで）。無ければ -1。 */
function pickKey(x: number, y: number): number {
  const v = activeView();
  const clip = state.clip;
  let best = -1;
  let bestDist = 10;
  sortedKeys().forEach((k, i) => {
    const p = toPixel(v, timeAtKeyTime(baseNow(), clip, k.t), k.v);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

let dragging = -1;
/**
 * つまんでいる間の軸。**掴んだ瞬間の見せ方を固める。**
 *
 * `view()` は打点の位置から範囲を決めるので、そのまま使うと
 * **つまんでいる間に軸が伸び、指の下で目盛りが動く**（動かした先がさらに遠くへ逃げる）。
 * 実測では縦へ 30 画素（値で +0.0707 のつもり）動かすと **+0.640** 動き、
 * 横へクリップの外まで出すと **1.13 秒**余計に動いた。**掴んでいる間だけ軸を止めると 0 になる。**
 */
let dragView: View | null = null;

/** いま使う軸。つまんでいる間は凍結したほうを返す。 */
const activeView = (): View => dragView ?? view();

/**
 * 画素 → 打点の（時刻・値）。
 *
 * **丸めない写しを使うのがここの肝。** 本体の `sourceTimeAt()` はクリップの頭で丸めるので、
 * そのまま使うと**頭より前へは打点を置けず、外に居る打点を掴むと頭へ張り付く。**
 */
function keyAtPixel(x: number, y: number): { t: number; v: number } {
  const v = activeView();
  const at = fromPixel(v, x, y);
  const range = VALUE_RANGE[state.valueName];
  return {
    t: keyTimeInUnclamped(baseNow(), state.clip, at.time),
    v: Math.min(range.max, Math.max(range.min, at.value)),
  };
}

function canvasPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = $<HTMLCanvasElement>('kf-curve').getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

const curveCanvas = $<HTMLCanvasElement>('kf-curve');

curveCanvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const at = canvasPoint(event);
  const hit = pickKey(at.x, at.y);
  if (hit >= 0) removeKeyIndex(hit);
});

curveCanvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const at = canvasPoint(event);
  const hit = pickKey(at.x, at.y);
  if (hit >= 0 && (event.altKey || event.metaKey)) {
    removeKeyIndex(hit);
    return;
  }
  if (hit >= 0) {
    state.keys = sortedKeys();
    state.selected = hit;
    dragging = hit;
    dragView = view();
    curveCanvas.setPointerCapture(event.pointerId);
    syncEaseSelect();
    drawAll();
    return;
  }
  // 何も無い所を押したら打点を足す（押した所の秒と値で）。
  const key = keyAtPixel(at.x, at.y);
  const before = sortedKeys().length;
  state.keys = normalizeKeys([...sortedKeys(), { t: key.t, v: key.v }]);
  if (state.keys.length === before) state.absorbed += 1;
  state.selected = state.keys.findIndex((k) => k.t === key.t);
  dragging = state.selected;
  dragView = view();
  curveCanvas.setPointerCapture(event.pointerId);
  syncEaseSelect();
  drawAll();
});

curveCanvas.addEventListener('pointermove', (event) => {
  if (dragging < 0) return;
  const at = canvasPoint(event);
  const key = keyAtPixel(at.x, at.y);
  const next = state.keys.slice();
  if (!next[dragging]) return;
  next[dragging] = { ...next[dragging], t: key.t, v: key.v };
  state.keys = next;
  state.selected = dragging;
  drawAll();
});

function endDrag(event: PointerEvent) {
  if (dragging < 0) return;
  const held = state.keys[dragging];
  const before = state.keys.length;
  state.keys = normalizeKeys(state.keys);
  // **つまんだまま別の打点を通り過ぎると、後勝ちで 1 つ畳まれる**（`normalizeKeys` の決まり）。
  // 黙って消えると「置いたのに無い」に見えるので、数えて知らせる。
  if (state.keys.length < before) state.absorbed += before - state.keys.length;
  state.selected = held ? state.keys.findIndex((k) => k.t === held.t && k.v === held.v) : -1;
  dragging = -1;
  dragView = null;
  if (curveCanvas.hasPointerCapture(event.pointerId)) curveCanvas.releasePointerCapture(event.pointerId);
  drawAll();
}

curveCanvas.addEventListener('pointerup', endDrag);
curveCanvas.addEventListener('pointercancel', endDrag);

function removeKeyIndex(index: number) {
  const keys = sortedKeys();
  if (index < 0 || index >= keys.length) return;
  // **`removeKeyAt()` を通す。** 直に `filter` すると、最後の 1 つを消したときに
  // 畳んだ形（軸を覚えている `{ base, v }`）が作られず、画面だけ軸を保っていることになる。
  const next = removeKeyAt(state.clip, curve(), keys[index].t, state.scenario.fallback);
  state.keys = keysOfTrack(next);
  if (state.keys.length === 0) state.seat = next;
  state.selected = -1;
  syncEaseSelect();
  drawAll();
}

$<HTMLButtonElement>('kf-remove').addEventListener('click', () => removeKeyIndex(state.selected));

$<HTMLButtonElement>('kf-put').addEventListener('click', () => {
  // **時間軸を渡していない。** 2026-09-27 の 2 回目は渡さないと種類の既定へ戻ったが、
  // 3 回目に畳んだ形が軸を持つようになったので、`putKeyAtTime()` が値の側から拾う。
  const next = putKeyAtTime(clipNow(), curve(), state.time);
  state.keys = keysOfTrack(next);
  state.selected = -1;
  drawAll();
});

$<HTMLSelectElement>('kf-ease').addEventListener('change', () => {
  const ease = $<HTMLSelectElement>('kf-ease').value as Ease;
  const keys = sortedKeys();
  if (state.selected < 0 || !keys[state.selected]) return;
  keys[state.selected] = { ...keys[state.selected], ease };
  state.keys = normalizeKeys(keys);
  drawAll();
});

function syncEaseSelect() {
  const keys = sortedKeys();
  const key = keys[state.selected];
  $<HTMLButtonElement>('kf-remove').disabled = !key;
  $<HTMLSelectElement>('kf-ease').value = key?.ease ?? 'linear';
}

// ---------- 出ている絵 ----------

function drawPreview() {
  const canvas = $<HTMLCanvasElement>('kf-preview');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = composed();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (media.kind === 'synthetic') drawSynthetic(c.sourceTime);
  if (media.kind === 'video') {
    const want = Math.max(0, Math.min(media.el.duration || 0, c.sourceTime));
    if (Math.abs(media.el.currentTime - want) > 0.02) media.el.currentTime = want;
  }

  // **本体は透明度が 0.002 以下なら描かない**（`drawVisualClip` の頭）。
  // 打点で谷を作るとそこだけ描画が飛ぶので、同じ所で飛ばして見せる。
  if (c.alpha > 0.002) {
    const size = mediaSize();
    const rect =
      media.kind === 'synthetic'
        ? c.rect
        : composeAt(
            { ...state.clip, fadeIn: state.fadeIn, fadeOut: state.fadeOut },
            tracks(),
            state.time,
            FRAME,
            size,
            state.applyFade,
          ).rect;
    ctx.globalAlpha = c.alpha;
    try {
      ctx.drawImage(mediaSource(), rect.x, rect.y, rect.w, rect.h);
    } catch {
      /* 読み込み途中のコマは描けない。次の描き直しで出る。 */
    }
    ctx.globalAlpha = 1;
  }
  showValues(c);
}

function stat(term: string, value: string, cls = '') {
  return `<div><dt>${term}</dt><dd${cls ? ` class="${cls}"` : ''}>${value}</dd></div>`;
}

function showValues(c: Composed) {
  $<HTMLDListElement>('kf-values').innerHTML = [
    stat('いまの時刻', `${state.time.toFixed(2)}s`),
    stat('出ている素材の秒', `${c.sourceTime.toFixed(2)}s`),
    stat(`打点の値（${state.valueName}）`, c.values[state.valueName].toFixed(3)),
    stat('フェードの係数', c.fade.toFixed(3)),
    stat('描くときの透明度', c.alpha.toFixed(3), c.alpha <= 0.002 ? 'none' : ''),
    stat('絵を置く所', `${c.rect.x.toFixed(0)}, ${c.rect.y.toFixed(0)} / ${c.rect.w.toFixed(0)}×${c.rect.h.toFixed(0)}`),
  ].join('');
}

$<HTMLInputElement>('kf-time').addEventListener('input', () => {
  state.time = Number($<HTMLInputElement>('kf-time').value);
  $<HTMLOutputElement>('out-time').textContent = `${state.time.toFixed(2)}s`;
  drawCurve();
  drawPreview();
});

for (const id of ['kf-fade-in', 'kf-fade-out']) {
  $<HTMLInputElement>(id).addEventListener('input', () => {
    state.fadeIn = Number($<HTMLInputElement>('kf-fade-in').value);
    state.fadeOut = Number($<HTMLInputElement>('kf-fade-out').value);
    showFades();
    drawAll();
  });
}
$<HTMLInputElement>('kf-fade-on').addEventListener('change', () => {
  state.applyFade = $<HTMLInputElement>('kf-fade-on').checked;
  drawAll();
});

function showFades() {
  $<HTMLOutputElement>('out-fade-in').textContent = `${state.fadeIn.toFixed(2)} 秒`;
  $<HTMLOutputElement>('out-fade-out').textContent = `${state.fadeOut.toFixed(2)} 秒`;
}

// ---------- 編集して、打点が付いてくるか見る ----------

/**
 * 期待の土台を固める。**編集を当てる前の曲線が「人が書いたもの」。**
 *
 * 打点の秒をタイムラインの秒へ直して持つ（`timeAtKeyTime()`）。こうしてあると、
 * 同じ曲線を 3 通りの時間軸へ入れ直して並べられる（`scenarios.ts` の `clipInBase()` と同じ形）。
 */
function snapshot(): Intended {
  const clip = clipNow();
  return {
    before: clip,
    authored: {
      keys: normalizeKeys(
        sortedKeys().map((k) => ({ t: timeAtKeyTime(baseNow(), clip, k.t), v: k.v, ease: k.ease })),
      ),
    },
    intent: state.scenario.intent,
    fallback: state.scenario.fallback,
  };
}

function applyEdit(name: string, pick = 0) {
  if (state.log.length === 0) state.intended = snapshot();
  const op = opsFor(state.scenario).find((o) => o.name === name);
  if (!op) return;
  // **付け替えは書かない**（`raw`）。それで期待どおりになるのが 9/27 の結論で、ここはその確かめ。
  const out = applyOp(op, baseNow() as TimeBase, clipNow(), 'raw');
  const chosen = out[Math.min(pick, out.length - 1)];
  state.clip = chosen;
  state.keys = keysOfTrack(chosen.value);
  state.log.push({ op: name, pick });
  state.time = Math.min(clipEnd(chosen), Math.max(chosen.start, state.time));
  syncTimeRange();
  drawAll();
}

/** その時間軸へ同じ曲線を入れ直して、同じ編集を当て直したときのずれ。 */
function scoreFor(base: TrackBase): { max: number; mean: number } {
  const want = state.intended ?? snapshot();
  let clip: LabClip = {
    ...want.before,
    value: {
      keys: normalizeKeys(
        keysOf(want.authored).map((k) => ({
          // 丸めない写しを使う。**頭より前に置いた打点は、丸めると入れ直した時点で潰れる。**
          t: keyTimeInUnclamped(base, want.before, k.t),
          v: k.v,
          ease: k.ease,
        })),
      ),
    },
  };
  for (const step of state.log) {
    const op = opsFor(state.scenario).find((o) => o.name === step.op);
    if (!op) continue;
    const out = applyOp(op, base as TimeBase, clip, 'raw');
    clip = out[Math.min(step.pick, out.length - 1)];
  }
  const { max, mean } = scoreAgainst(want, base as TimeBase, clip, SCORE_FPS);
  return { max, mean };
}

function showScore() {
  const box = $<HTMLDListElement>('kf-score');
  const intent = state.scenario.intent;
  $<HTMLSpanElement>('kf-intent').textContent =
    intent === 'content' ? 'content ・ 絵に付く' : intent === 'head' ? 'head ・ クリップの頭に付く' : 'stretch ・ 尺に伸びる';
  box.innerHTML = TRACK_BASES.map((base) => {
    const { max } = scoreFor(base);
    const hit = max <= EXACT;
    return stat(
      `${base}${base === defaultTrackBase(state.scenario.kind) ? '（種類の既定）' : ''}`,
      hit ? '0（期待どおり）' : max.toFixed(4),
      hit ? 'hit' : 'miss',
    );
  }).join('');
  $<HTMLSpanElement>('kf-log').textContent =
    state.log.length === 0
      ? 'まだ何も当てていません（編集前なので 3 通りとも 0 です）。'
      : `当てた編集: ${state.log.map((s) => OP_LABELS[s.op] + (s.op === 'split' ? (s.pick === 0 ? '（左）' : '（右）') : '')).join(' → ')}`;
}

function buildOpButtons() {
  const row = $<HTMLDivElement>('kf-ops');
  row.innerHTML = '';
  for (const op of opsFor(state.scenario)) {
    const picks = op.name === 'split' ? [0, 1] : [0];
    for (const pick of picks) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.op = op.name;
      button.dataset.pick = String(pick);
      const suffix =
        op.name === 'split'
          ? pick === 0
            ? '（左を持つ）'
            : '（右を持つ）'
          : op.name === 'setSpeed'
            ? `（×${state.scenario.edits.speedTo}）`
            : '';
      button.textContent = `${OP_LABELS[op.name]}${suffix}`;
      button.addEventListener('click', () => applyEdit(op.name, pick));
      row.appendChild(button);
    }
  }
}

$<HTMLButtonElement>('kf-reset').addEventListener('click', () => resetScenario());

// ---------- 素材の選び直し ----------

function resetScenario() {
  const s = state.scenario;
  state.seat = s.fallback;
  state.valueName = SHOW_AS[s.name];
  state.clip = baseClip(s);
  // 素材が書いた打点は**タイムラインの秒**なので、選んだ時間軸へ写して入れる。
  state.keys = normalizeKeys(
    s.authored.map((k) => ({ t: keyTimeInUnclamped(baseNow(), state.clip, k.at), v: k.v, ease: k.ease })),
  );
  state.selected = -1;
  state.log = [];
  state.intended = null;
  state.absorbed = 0;
  state.time = s.start;
  // **フェードはクリップの持ち物**なので、素材を選び直したら戻す。
  // 残しておくと、次の素材で「打点は 1 なのに絵が出ない」形になって打点の側を疑うことになる
  //（確かめを書いていて実際に 1 度そうなった）。
  state.fadeIn = 0;
  state.fadeOut = 0;
  state.applyFade = true;
  $<HTMLInputElement>('kf-fade-in').value = '0';
  $<HTMLInputElement>('kf-fade-out').value = '0';
  $<HTMLInputElement>('kf-fade-on').checked = true;
  showFades();
  $<HTMLSelectElement>('kf-base').value = baseNow();
  $<HTMLSelectElement>('kf-value').value = state.valueName;
  $<HTMLParagraphElement>('kf-note').textContent =
    `${s.kind} ・ 頭 ${s.start.toFixed(2)}s ・ 尺 ${s.duration.toFixed(2)}s ・ ` +
    `素材のイン点 ${s.sourceIn.toFixed(2)}s ・ 速さ ×${s.speed}`;
  $<HTMLParagraphElement>('kf-status').className = 'status';
  $<HTMLParagraphElement>('kf-status').textContent = `${s.name} — ${s.note}`;
  syncTimeRange();
  buildOpButtons();
  syncEaseSelect();
  drawAll();
}

function syncTimeRange() {
  const range = $<HTMLInputElement>('kf-time');
  range.min = String(state.clip.start);
  range.max = String(clipEnd(state.clip));
  range.step = String(1 / 120);
  range.value = String(state.time);
  $<HTMLOutputElement>('out-time').textContent = `${state.time.toFixed(2)}s`;
}

/**
 * 時間軸を替える。**打点の「見た目」を保つように写し替える。**
 *
 * 秒をそのまま残すと、`source` の 3.2 秒が `local` の 3.2 秒として読まれて曲線が飛ぶ。
 * 見た目を保って写すと、**編集するまで 3 通りが 1 コマも違わない**——
 * それが `probe.mjs` の 1 段目（編集前は 4 通りとも同じ）を画面でやっていることになる。
 */
$<HTMLSelectElement>('kf-base').addEventListener('change', () => {
  const next = $<HTMLSelectElement>('kf-base').value as TrackBase;
  // 写し替えの式は `setTrackBase()` に寄せた（画面にも同じものが書いてあった）。
  // **打点が 0 個でも通る**ので、「先に軸を決めてから置く」がこのボタンだけで済む。
  const moved = setTrackBase(state.clip, curve(), next, state.scenario.fallback);
  state.keys = keysOfTrack(moved);
  state.seat = setTrackBase(state.clip, state.seat, next, state.scenario.fallback);
  state.selected = -1;
  syncEaseSelect();
  drawAll();
});

$<HTMLSelectElement>('kf-value').addEventListener('change', () => {
  state.valueName = $<HTMLSelectElement>('kf-value').value as ValueName;
  drawAll();
});

$<HTMLSelectElement>('kf-scenario').addEventListener('change', () => {
  const found = SCENARIOS.find((s) => s.name === $<HTMLSelectElement>('kf-scenario').value);
  if (!found) return;
  state.scenario = found;
  resetScenario();
});

// ---------- まとめて描き直す ----------

function showKeys() {
  const keys = sortedKeys();
  const clip = state.clip;
  const outside = keys.filter((k) => {
    const t = timeAtKeyTime(baseNow(), clip, k.t);
    return t < clip.start - 1e-9 || t > clipEnd(clip) + 1e-9;
  }).length;
  $<HTMLParagraphElement>('kf-keys').textContent =
    keys.length === 0
      ? `打点なし（素の数 ${state.scenario.fallback} のまま。読むときは即返る道を通ります）`
      : `打点 ${keys.length} 個` +
        `（クリップの外 ${outside} 個）: ` +
        keys
          .map((k) => `${k.t.toFixed(3)}${baseNow() === 'fraction' ? '' : 's'} → ${k.v.toFixed(3)}${k.ease && k.ease !== 'linear' ? ` [${k.ease}]` : ''}`)
          .join(' , ');

  const warn = $<HTMLParagraphElement>('kf-warning');
  const messages: string[] = [];
  if (state.absorbed > 0) {
    messages.push(
      `<strong>打点が ${state.absorbed} 個、重なって畳まれました。</strong>` +
        '同じ時刻に 2 つは置けない決まり（後から置いたほうが残る）なので、つまんだまま別の打点を通り過ぎると畳まれます。',
    );
  }
  if (state.log.length > 0) {
    messages.push(
      '<strong>編集を当てたあとに打点を動かすと、下の「ずれ」は当てになりません</strong>' +
        '（期待の土台は編集前の曲線で固めてあります）。「編集を元に戻す」を押してから触ってください。',
    );
  }
  if (baseNow() !== defaultTrackBase(state.scenario.kind)) {
    messages.push(
      `<strong>時間軸を種類の既定（${defaultTrackBase(state.scenario.kind)}）から外しています。</strong>` +
        '下の「4.」で、その代価が数字に出ます。',
    );
  }
  warn.hidden = messages.length === 0;
  warn.innerHTML = messages.join('<br>');
}

function drawAll() {
  drawCurve();
  drawPreview();
  showKeys();
  showScore();
  syncEaseSelect();
}

window.addEventListener('resize', () => {
  drawCurve();
});

// ---------- 起動 ----------

$<HTMLSelectElement>('kf-scenario').innerHTML = SCENARIOS.map(
  (s) => `<option value="${s.name}">${s.name} ・ ${s.note}</option>`,
).join('');
showFades();
resetScenario();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __labKeyframe: {
      selfTest: typeof runSelfTest;
      /** 画面が使っている既定（判定の側から来ているかの確認用）。 */
      defaults: {
        bases: TrackBase[];
        eases: Ease[];
        defaultBase: Record<string, TrackBase>;
        scoreFps: number;
        scenarios: string[];
      };
      state: () => {
        scenario: string;
        base: TrackBase;
        valueName: ValueName;
        intent: string;
        clip: LabClip;
        keys: Keyframe[];
        selected: number;
        outside: number;
        absorbed: number;
        log: { op: string; pick: number }[];
        time: number;
        /**
         * いまの値を JSON にしたもの（**時間軸がどこに書かれているか**を外から見るため）。
         * 打点が 0 個なら畳んだ形（素の数 か `{ base, v }`）がそのまま出る。
         */
        valueJson: string;
        /** 3 通りのずれ（画面に出ている数字と同じもの）。 */
        score: Record<string, number>;
        composed: Composed;
      };
      setScenario: (name: string) => void;
      setBase: (base: TrackBase) => void;
      setValue: (name: ValueName) => void;
      setTime: (t: number) => void;
      setFade: (fadeIn: number, fadeOut: number, on?: boolean) => void;
      applyEdit: (name: string, pick?: number) => void;
      reset: () => void;
      /** 曲線のキャンバスの座標（画素 ↔ 秒・値）。つまむ操作を画素で確かめるため。 */
      geometry: () => View;
      toPixel: (t: number, v: number) => { x: number; y: number };
      fromPixel: (x: number, y: number) => { time: number; value: number };
      /** その画素が指す打点の（時刻・値）。丸めない写しを通したもの。 */
      keyAtPixel: (x: number, y: number) => { t: number; v: number };
      /**
       * いまの打点が**タイムラインの何秒に立つか**（`timeAtKeyTime()` を通したもの）。
       *
       * 確かめの側で秒を組み立て直すと同じ式が 2 本になるので、画面が使っているものを出す。
       */
      keyStandsAt: () => number[];
      /** 素材 6 本 × 時間軸 3 通り × 操作 6 つ（付け替えなし）。`probe.mjs` の 3 段目と同じもの。 */
      probeTable: () => { name: string; intent: string; base: string; errors: number[] }[];
      opNames: () => string[];
    };
  }
}

window.__labKeyframe = {
  selfTest: runSelfTest,
  defaults: {
    bases: TRACK_BASES,
    eases: EASES,
    defaultBase: {
      video: defaultTrackBase('video'),
      audio: defaultTrackBase('audio'),
      image: defaultTrackBase('image'),
      text: defaultTrackBase('text'),
    },
    scoreFps: SCORE_FPS,
    scenarios: SCENARIOS.map((s) => s.name),
  },
  state: () => ({
    scenario: state.scenario.name,
    base: baseNow(),
    valueJson: JSON.stringify(curve()),
    valueName: state.valueName,
    intent: state.scenario.intent,
    clip: clipNow(),
    keys: sortedKeys(),
    selected: state.selected,
    outside: sortedKeys().filter((k) => {
      const t = timeAtKeyTime(baseNow(), state.clip, k.t);
      return t < state.clip.start - 1e-9 || t > clipEnd(state.clip) + 1e-9;
    }).length,
    absorbed: state.absorbed,
    log: state.log.slice(),
    time: state.time,
    score: Object.fromEntries(TRACK_BASES.map((b) => [b, scoreFor(b).max])),
    composed: composed(),
  }),
  setScenario: (name) => {
    const found = SCENARIOS.find((s) => s.name === name);
    if (!found) return;
    state.scenario = found;
    $<HTMLSelectElement>('kf-scenario').value = name;
    resetScenario();
  },
  setBase: (base) => {
    $<HTMLSelectElement>('kf-base').value = base;
    $<HTMLSelectElement>('kf-base').dispatchEvent(new Event('change'));
  },
  setValue: (name) => {
    $<HTMLSelectElement>('kf-value').value = name;
    $<HTMLSelectElement>('kf-value').dispatchEvent(new Event('change'));
  },
  setTime: (t) => {
    state.time = t;
    syncTimeRange();
    drawAll();
  },
  setFade: (fadeIn, fadeOut, on = true) => {
    state.fadeIn = fadeIn;
    state.fadeOut = fadeOut;
    state.applyFade = on;
    $<HTMLInputElement>('kf-fade-in').value = String(fadeIn);
    $<HTMLInputElement>('kf-fade-out').value = String(fadeOut);
    $<HTMLInputElement>('kf-fade-on').checked = on;
    showFades();
    drawAll();
  },
  applyEdit,
  reset: resetScenario,
  geometry: activeView,
  toPixel: (t, v) => toPixel(activeView(), t, v),
  fromPixel: (x, y) => fromPixel(activeView(), x, y),
  keyAtPixel,
  keyStandsAt: () => sortedKeys().map((k) => timeAtKeyTime(baseNow(), state.clip, k.t)),
  probeTable: () =>
    SCENARIOS.flatMap((s) =>
      TRACK_BASES.map((base) => ({
        name: s.name,
        intent: s.intent,
        base,
        errors: opsFor(s).map((op) => worstError(s, base as TimeBase, op, 'raw', SCORE_FPS)),
      })),
    ),
  opNames: () => opsFor(state.scenario).map((o) => o.name),
};

$<HTMLButtonElement>('run-tests').addEventListener('click', () => {
  const results = runSelfTest();
  $<HTMLUListElement>('test-results').innerHTML = results
    .map(
      (r) =>
        `<li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? 'PASS' : 'FAIL'}</b><span>${r.name}</span><span>${r.detail}</span></li>`,
    )
    .join('');
});
