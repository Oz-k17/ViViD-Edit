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
import { keyTimeAt, sourceTimeAt, TIME_BASES, type ClipKind, type LabClip, type TimeBase } from './timebase.ts';

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
 * 期待する値。編集後のクリップと、その上のタイムラインの時刻から決める。
 *
 * どれも**編集前に書いた曲線を、期待の形で引き直しただけ**。
 * `content` は素材の秒、`head` はクリップの頭からの秒、`stretch` は尺の割合で引く。
 */
export function intendedValue(s: Scenario, after: LabClip, time: number): number {
  const curve = authoredCurve(s);
  const before = baseClip(s);
  switch (s.intent) {
    case 'content': {
      // 出ている素材の秒 → 編集前ならそれが何秒に見えていたか → その時刻の値
      const source = sourceTimeAt(after, time);
      const at = before.start + (source - before.sourceIn) / (before.speed || 1);
      return sampleAnimated(curve, at, s.fallback);
    }
    case 'head':
      return sampleAnimated(curve, before.start + (time - after.start), s.fallback);
    case 'stretch': {
      const u = after.duration > 0 ? (time - after.start) / after.duration : 0;
      return sampleAnimated(curve, before.start + u * before.duration, s.fallback);
    }
  }
}

/** 編集後のクリップを 1 コマずつ見て、期待とのずれの最大・平均を出す。 */
export function scoreClip(
  s: Scenario,
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
    const got = sampleAnimated(after.value, keyTimeAt(base, after, time), s.fallback);
    const want = intendedValue(s, after, time);
    const err = Math.abs(got - want);
    if (err > max) max = err;
    sum += err;
    n += 1;
  }
  return { max, mean: n > 0 ? sum / n : 0, samples: n };
}

export const EXACT = 1e-9;
export { TIME_BASES };
