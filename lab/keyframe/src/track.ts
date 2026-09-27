/**
 * **本体へ持っていく形。** クリップの上で「時間で変化する値」を持ち、1 コマぶんを取り出す。
 *
 * `value.ts`（並べ方）と `timebase.ts`（測るための 4 通り）を測って決めた結論がここ。
 * 測定は `npm run lab:keyframe:probe`、表は `README.md` にある。要点は 3 つ:
 *
 * 1. **時間軸は「期待の形」とちょうど 1 対 1 だった。**
 *    絵に付いてほしい値は素材の秒（`source`）、クリップの頭に付いてほしい値は頭からの秒（`local`）、
 *    尺に伸び縮みしてほしい値は尺の割合（`fraction`）。
 *    測った 36 通り（素材 6 本 × 操作 6 つ）で、**それぞれが自分の期待をちょうど満たす。**
 * 2. **だから時間軸は値と一緒に持つ。** 1 つに決めて他を付け替えで救う形も測ったが、
 *    付け替えは「どの期待を選ぶか」を先に決めてしまうので、
 *    テロップとケンバーンズが道連れになる（`README.md` の 2 段目）。
 * 3. **3 つとも、編集の操作に 1 行も足さずに成り立つ。** 本体の `src/model/ops.ts` は
 *    `structuredClone` でクリップを丸ごと写すので、打点は黙って付いてくる。
 *    付け替えを書く必要があるのは `absolute`（タイムラインの秒）だけで、
 *    **それはどの期待も満たさないので捨てた。**
 *
 * ## 本体に入れるときの接続先
 *
 * - 読む所は `src/engine/renderer.ts` の `drawVisualClip()` / `drawTextClip()` と
 *   `src/engine/offline-export.ts`。`clip.opacity` を `sampleClipValue(clip, clip.opacity, time, 1)` に
 *   替えるだけで、素の数のままのクリップは 1 コマも変わらない（`sampleClipValue` の速い道）。
 * - **フェードとテロップの出は別物として残す。** 本体は `opacity` に
 *   `fadeEnvelope()` とテロップの `animation` を掛けている。打点はそれと掛け算で重なる
 *   （打点で 0.5、フェードで 0.5 なら 0.25）。片方を打点で置き換えるのは別の回の判断。
 */

import { normalizeKeys, sampleAnimated, type Ease, type Keyframe } from './value.ts';

/** 打点の秒を何として読むか。`absolute`（タイムラインの秒）は測って捨てた。 */
export type TrackBase = 'source' | 'local' | 'fraction';

export type ClipKind = 'video' | 'image' | 'audio' | 'text';

/** 時間の計算に要る所だけ。本体の `Clip` はこれを満たしている。 */
export interface ClipTiming {
  kind: ClipKind;
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
}

/**
 * 時間で変化する値。**素の数をそのまま受ける**ので、保存済みのプロジェクトがそのまま読める。
 * `base` を省いたら `source`（いちばん多い「絵に付く」）。
 */
export type AnimatedTrack = number | { base?: TrackBase; keys: Keyframe[] };

/** 素材の中の時刻。`src/model/types.ts` の `sourceTimeAt()` と同じ式。 */
export function sourceTimeAt(clip: ClipTiming, time: number): number {
  return clip.sourceIn + Math.max(0, time - clip.start) * (clip.speed || 1);
}

/**
 * タイムラインの時刻を、その時間軸での打点の時刻に直す。
 *
 * 知らない名前が来たら `source` として読む。**保存した JSON から来る値なので、
 * 知らない名前で `NaN` を返すと「その日だけ絵が消える」形の壊れ方になる**
 * （`sampleAnimated()` は NaN を最初の打点へ落とすので、絵は消えないが動かなくなる）。
 */
export function keyTimeIn(base: TrackBase, clip: ClipTiming, time: number): number {
  if (base === 'local') return time - clip.start;
  if (base === 'fraction') return clip.duration > 0 ? (time - clip.start) / clip.duration : 0;
  return sourceTimeAt(clip, time);
}

export const isKeyedTrack = (value: AnimatedTrack): value is { base?: TrackBase; keys: Keyframe[] } =>
  typeof value !== 'number';

export const trackBaseOf = (value: AnimatedTrack): TrackBase =>
  isKeyedTrack(value) ? (value.base ?? 'source') : 'source';

/**
 * 種類ごとの既定の時間軸。
 *
 * - 映像と音は素材のコマがあるので `source`。頭を詰めても割っても、打点は同じコマに付く。
 * - **静止画とテロップは `local`。** 素材の中に「そのコマ」が無いので `source` に意味が無く、
 *   実際 `splitOne()` は種類を問わず `sourceIn` を進めるので、
 *   テロップを真ん中で割ると `source` の打点だけ 1.000 ずれた（測定の 4 段目）。
 * - `fraction`（尺に伸び縮み）は**既定にしない。** 尺に合わせたいかどうかは
 *   素材の種類から決まらない（同じ静止画で、寄りを尺いっぱいに伸ばしたい人と、
 *   2 秒で寄せ切ってほしい人が居る）。ケンバーンズのような**型のほうが名乗る**。
 */
export function defaultTrackBase(kind: ClipKind): TrackBase {
  return kind === 'video' || kind === 'audio' ? 'source' : 'local';
}

/**
 * その時刻の値。**打点を持たないクリップはここで即返る**（本体のいまの費用と同じ）。
 *
 * `fallback` を呼ぶ側に出させる理由は `value.ts` の `sampleAnimated()` の注にある。
 */
export function sampleClipValue(
  clip: ClipTiming,
  value: AnimatedTrack,
  time: number,
  fallback = 0,
): number {
  if (typeof value === 'number') return value;
  return sampleAnimated(value, keyTimeIn(value.base ?? 'source', clip, time), fallback);
}

/**
 * 「いまの再生位置に打点を置く」（画面のボタンがすること）。
 *
 * 置いた瞬間に絵が飛ばないように、**値を省いたら今の値をそのまま打点にする。**
 * これが無いと、素の数 0.8 のクリップに打点を置いた瞬間に既定値へ跳ねる。
 */
export function putKeyAtTime(
  clip: ClipTiming,
  value: AnimatedTrack,
  time: number,
  next?: number,
  ease?: Ease,
): AnimatedTrack {
  // **すでに打点を持っているなら、その時間軸を動かさない。**
  // 種類の既定を当てにいくと、テロップに `source` で打点を置いていた値が
  // 2 つ目を足した瞬間に `local` として読み直され、1 つ目の打点だけ場所が飛ぶ。
  const base = isKeyedTrack(value) ? trackBaseOf(value) : defaultTrackBase(clip.kind);
  const keys = isKeyedTrack(value) ? value.keys : [];
  const v = next ?? sampleClipValue(clip, value, time, typeof value === 'number' ? value : 0);
  const t = keyTimeIn(base, clip, time);
  return { base, keys: normalizeKeys([...keys, { t, v, ...(ease ? { ease } : {}) }]) };
}

/**
 * 打点を 1 つ取り除く。**列が空になったら素の数へ戻す**（`{ keys: [] }` を残さない）。
 *
 * 空の列を残すと、読む側が毎コマ `fallback` を通ることになり、
 * 「打点を全部消したのに値が既定へ戻った」という形で見える。
 */
export function removeKeyAt(
  value: AnimatedTrack,
  t: number,
  fallback: number,
  epsilon = 1e-6,
): AnimatedTrack {
  if (!isKeyedTrack(value)) return value;
  const keys = value.keys.filter((k) => Math.abs(k.t - t) > epsilon);
  if (keys.length === 0) return value.keys.length > 0 ? lastValueOf(value, fallback) : fallback;
  return { ...value, keys };
}

/** 打点を畳んで素の数へ戻すときの値（最後に残っていた打点の値）。 */
function lastValueOf(value: AnimatedTrack, fallback: number): number {
  if (!isKeyedTrack(value) || value.keys.length === 0) return fallback;
  return value.keys[value.keys.length - 1].v;
}

/**
 * ケンバーンズ（静止画をクリップの間ずっと寄せる）の型。
 *
 * **`fraction` を名乗る側の例としてここに置いてある。** 尺を変えても寄り切るのはこれだけで、
 * ほかの時間軸だと「尺を伸ばしたら途中で止まる」になる（測定の 4 段目・`image-kenburns`）。
 */
export function kenBurns(from = 1, to = 1.2): AnimatedTrack {
  return { base: 'fraction', keys: normalizeKeys([{ t: 0, v: from, ease: 'easeInOut' }, { t: 1, v: to }]) };
}
