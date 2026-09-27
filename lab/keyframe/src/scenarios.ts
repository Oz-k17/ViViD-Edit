/**
 * 「編集したあと、人が期待する絵になっているか」を測るための素材と**正解**。
 *
 * ## 正解をどう決めたか（ここを疑われたら測定ごと無意味なので、先に書く）
 *
 * 打点の持ち方を比べるとき、**正解を「素材の秒で書いたもの」と決めてしまうと
 * `source` が勝つのは当たり前**になる。それでは測ったことにならないので、
 * 期待の形を 3 通りに分けて、**素材ごとにどれを期待するかを人の言葉で決めてある**。
 *
 * | 期待 | 例 | 編集したあとどうあってほしいか |
 * | --- | --- | --- |
 * | `content`（絵に付く） | 素材の 5.0 秒の瞬間で寄る | **その素材のコマ**が出ている間はずっと同じ値 |
 * | `head`（頭に付く） | テロップが出てから 0.4 秒で開く | **クリップの頭からの秒**が同じなら同じ値 |
 * | `stretch`（尺に伸びる） | 静止画をクリップの間ずっとゆっくり寄る | **尺に対する割合**が同じなら同じ値 |
 *
 * どれを期待するかは種類でほぼ決まる（素材のコマが無いものに `content` は書けない）。
 * ただし静止画は `head` にも `stretch` にもなりうるので、**両方の素材を置いてある。**
 *
 * ## 打点は「同じ見た目」から作る
 *
 * 素材は打点を時間軸ごとに手で書くのではなく、**編集前のタイムラインの秒で 1 回だけ**書く。
 * それを 4 つの時間軸へ写すので、**編集する前は 4 通りとも 1 コマも違わない**
 * （`selftest.ts` の「編集前は 4 通りとも同じ」がそれを押さえている）。
 * こうしないと、比べているのが持ち方の差ではなく**書き方の差**になる。
 */

import { normalizeKeys, sampleAnimated, type Animated, type Ease } from './value.ts';
import {
  applyOp,
  keyTimeAt,
  sourceTimeAt,
  TIME_BASES,
  type ClipKind,
  type EditOp,
  type LabClip,
  type RebasePolicy,
  type TimeBase,
} from './timebase.ts';

export type Intent = 'content' | 'head' | 'stretch';

export interface Scenario {
  name: string;
  /** 何をしている素材か（表の見出しに出す）。 */
  note: string;
  intent: Intent;
  kind: ClipKind;
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
  /** 値が無いときの既定（不透明度なら 1、音量なら 1 など）。 */
  fallback: number;
  /** 編集前のタイムラインの秒で書いた打点。 */
  authored: { at: number; v: number; ease?: Ease }[];
  /** この素材で試す編集の引数。 */
  edits: { moveBy: number; trimHead: number; trimTail: number; splitAt: number; speedTo: number; rippleBy: number };
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'video-punch',
    note: '映像の 5.0 秒の見せ場で 1.0 → 1.35 倍に寄る',
    intent: 'content',
    kind: 'video',
    start: 2,
    duration: 6,
    sourceIn: 3,
    speed: 1,
    fallback: 1,
    authored: [
      { at: 3.2, v: 1, ease: 'easeOut' },
      { at: 4, v: 1.35 },
      { at: 6.4, v: 1.35, ease: 'easeIn' },
      { at: 7, v: 1 },
    ],
    edits: { moveBy: 2.5, trimHead: 1, trimTail: -1.2, splitAt: 5, speedTo: 2, rippleBy: -1.4 },
  },
  {
    name: 'video-2x',
    note: '2 倍速の素材の上で、素材の 8.0 秒に合わせて暗くする',
    intent: 'content',
    kind: 'video',
    start: 1,
    duration: 5,
    sourceIn: 4,
    speed: 2,
    fallback: 1,
    authored: [
      { at: 2.4, v: 1 },
      { at: 3, v: 0.4 },
      { at: 4, v: 1 },
    ],
    edits: { moveBy: 3, trimHead: 0.8, trimTail: -1, splitAt: 3.5, speedTo: 4, rippleBy: -0.6 },
  },
  {
    name: 'audio-duck',
    note: 'ナレーションの下で BGM を 0.25 まで下げる（素材の秒に合わせてある）',
    intent: 'content',
    kind: 'audio',
    start: 0.5,
    duration: 8,
    sourceIn: 12,
    speed: 1,
    fallback: 1,
    authored: [
      { at: 2, v: 1, ease: 'easeInOut' },
      { at: 2.4, v: 0.25 },
      { at: 6, v: 0.25, ease: 'easeInOut' },
      { at: 6.4, v: 1 },
    ],
    edits: { moveBy: 1.5, trimHead: 1.2, trimTail: -2, splitAt: 4, speedTo: 1, rippleBy: -0.5 },
  },
  {
    // 頭の側に打点がある素材。**「見えない打点は刈ってよい」を潰すために置いてある。**
    // ほかの 5 本は打点が偶然クリップの頭より後ろにあり、刈っても何も起きなかった。
    name: 'video-fade-in',
    note: '映像の頭 1.0 秒で 0 → 1 に開く（打点が、詰めると消える所に居る）',
    intent: 'content',
    kind: 'video',
    start: 2,
    duration: 5,
    sourceIn: 3,
    speed: 1,
    fallback: 1,
    authored: [
      { at: 2, v: 0, ease: 'easeOut' },
      { at: 3, v: 1 },
    ],
    edits: { moveBy: 1, trimHead: 0.6, trimTail: -0.5, splitAt: 4, speedTo: 2, rippleBy: -0.4 },
  },
  {
    name: 'text-intro',
    note: 'テロップが出てから 0.4 秒で開き、最後の 0.3 秒で閉じる',
    intent: 'head',
    kind: 'text',
    start: 3,
    duration: 4,
    sourceIn: 0,
    speed: 1,
    fallback: 0,
    authored: [
      { at: 3, v: 0, ease: 'easeOut' },
      { at: 3.4, v: 1 },
      { at: 6.7, v: 1 },
      { at: 7, v: 0 },
    ],
    edits: { moveBy: 2, trimHead: 0.6, trimTail: -0.8, splitAt: 5, speedTo: 1, rippleBy: -1 },
  },
  {
    name: 'image-kenburns',
    note: '静止画をクリップの間ずっと 1.0 → 1.2 倍へ寄せる（尺に合わせたい）',
    intent: 'stretch',
    kind: 'image',
    start: 0,
    duration: 5,
    sourceIn: 0,
    speed: 1,
    fallback: 1,
    authored: [
      { at: 0, v: 1 },
      { at: 5, v: 1.2 },
    ],
    edits: { moveBy: 2, trimHead: 1, trimTail: -1.5, splitAt: 2.5, speedTo: 1, rippleBy: -0.8 },
  },
];

/** 編集前のクリップ（打点はまだ入れていない）。 */
export function baseClip(s: Scenario): LabClip {
  return {
    id: s.name,
    kind: s.kind,
    start: s.start,
    duration: s.duration,
    sourceIn: s.sourceIn,
    speed: s.speed,
    value: s.fallback,
  };
}

/** 書いた打点を、タイムラインの秒で読める形（＝正解を作る土台）にしたもの。 */
export function authoredCurve(s: Scenario): Animated {
  return { keys: normalizeKeys(s.authored.map((k) => ({ t: k.at, v: k.v, ease: k.ease }))) };
}

/** 書いた打点を、ある時間軸のクリップへ入れる。 */
export function clipInBase(s: Scenario, base: TimeBase): LabClip {
  const clip = baseClip(s);
  const keys = normalizeKeys(
    s.authored.map((k) => ({ t: keyTimeAt(base, clip, k.at), v: k.v, ease: k.ease })),
  );
  return { ...clip, value: { keys } };
}

/**
 * **期待の土台**——編集前のクリップと、そのとき「タイムラインの秒」で書いてあった曲線。
 *
 * 素材（`Scenario`）から作るのが本筋だが、**画面から人が置いた曲線も同じ物差しに載せたい**
 * ので、素材ではなくこの 4 つを受ける形に開いてある（2026-09-27 の 2 回目に画面を作って要った）。
 * 物差しを 2 本書かないのは `reframe/score.mjs` と同じ立場で、
 * **食い違ったときに「判定が変わったのか物差しが変わったのか」を読めなくしないため。**
 */
export interface Intended {
  before: LabClip;
  /** 編集前のタイムラインの秒で読める曲線。 */
  authored: Animated;
  intent: Intent;
  fallback: number;
}

export function intendedOf(s: Scenario): Intended {
  return { before: baseClip(s), authored: authoredCurve(s), intent: s.intent, fallback: s.fallback };
}

/**
 * 期待する値。編集後のクリップと、その上のタイムラインの時刻から決める。
 *
 * どれも**編集前に書いた曲線を、期待の形で引き直しただけ**。
 * `content` は素材の秒、`head` はクリップの頭からの秒、`stretch` は尺の割合で引く。
 */
export function intendedValueOf(want: Intended, after: LabClip, time: number): number {
  const { before, authored: curve } = want;
  switch (want.intent) {
    case 'content': {
      // 出ている素材の秒 → 編集前ならそれが何秒に見えていたか → その時刻の値
      const source = sourceTimeAt(after, time);
      const at = before.start + (source - before.sourceIn) / (before.speed || 1);
      return sampleAnimated(curve, at, want.fallback);
    }
    case 'head':
      return sampleAnimated(curve, before.start + (time - after.start), want.fallback);
    case 'stretch': {
      const u = after.duration > 0 ? (time - after.start) / after.duration : 0;
      return sampleAnimated(curve, before.start + u * before.duration, want.fallback);
    }
  }
}

export function intendedValue(s: Scenario, after: LabClip, time: number): number {
  return intendedValueOf(intendedOf(s), after, time);
}

/** 編集後のクリップを 1 コマずつ見て、期待とのずれの最大・平均を出す。 */
export function scoreAgainst(
  want: Intended,
  base: TimeBase,
  after: LabClip,
  fps = 30,
): { max: number; mean: number; samples: number } {
  let max = 0;
  let sum = 0;
  let n = 0;
  const frames = Math.max(1, Math.round(after.duration * fps));
  for (let i = 0; i <= frames; i += 1) {
    const time = after.start + Math.min(after.duration, i / fps);
    const got = sampleAnimated(after.value, keyTimeAt(base, after, time), want.fallback);
    const err = Math.abs(got - intendedValueOf(want, after, time));
    if (err > max) max = err;
    sum += err;
    n += 1;
  }
  return { max, mean: n > 0 ? sum / n : 0, samples: n };
}

export function scoreClip(
  s: Scenario,
  base: TimeBase,
  after: LabClip,
  fps = 30,
): { max: number; mean: number; samples: number } {
  return scoreAgainst(intendedOf(s), base, after, fps);
}

/**
 * 1 つの（素材・時間軸・方針・操作）での**最悪のずれ**。
 *
 * `probe.mjs` と画面の両方がここを呼ぶ。**測る式を 2 本置かないため**で、
 * 置いてしまうと「画面とコマンドラインで数字が違う」ときに
 * 判定が違うのか物差しが違うのかを切り分けられない（画面を足した 2026-09-27 の 2 回目に寄せた）。
 *
 * 割ると 2 本返るので**両方を見て悪いほう**を採る。尺が 0 になった側は見ない
 * （本体の最小の尺で止まるので実際には出ないが、引数を手で変えると出る）。
 */
export function worstError(
  s: Scenario,
  base: TimeBase,
  op: EditOp,
  policy: RebasePolicy,
  fps = 30,
): number {
  let worst = 0;
  for (const after of applyOp(op, base, clipInBase(s, base), policy)) {
    if (after.duration <= 0) continue;
    worst = Math.max(worst, scoreClip(s, base, after, fps).max);
  }
  return worst;
}

export const EXACT = 1e-9;
export { TIME_BASES };
