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
 * ## 持ち方は 3 つの形（2026-09-27 の 3 回目に 1 つ増えた）
 *
 * `number`（素の数）／`{ base?, keys }`（打点あり）／`{ base, v }`（打点は無いが軸を覚えている）。
 * 3 つ目は**既定でない時間軸を、打点の外に持つ**ための形で、
 * 「打点を全部消したら軸ごと消える」「空の列を残すと値が既定へ跳ねる」の両方を避ける唯一の形だった
 * （4 通り測った表は `README.md` の「既定でない時間軸をどこに持つか」・`npm run lab:keyframe:hold`）。
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

/** 打点を持つ形。`base` を省いたら `source`（いちばん多い「絵に付く」）。 */
export interface KeyedTrack {
  base?: TrackBase;
  keys: Keyframe[];
}

/**
 * **打点を持たないが、時間軸だけ覚えている形**（2026-09-27 の 3 回目に足した）。
 *
 * 打点を全部消したときに素の数へ畳むと、**時間軸も一緒に消える**（値と一緒に持っているため）。
 * 消えると次に置いた打点が種類の既定で読まれるので、尺 5 秒の静止画では立つ所が 4.00 秒動く。
 * 逆に**空の列だけを残す**形（`{ base, keys: [] }`）だと時間軸は残るが、
 * 読む側が毎コマ `fallback` を通るので**値が既定へ跳ねる**——`track.ts` が
 * 「空の列を残さない」と決めていた理由はこちらだった。
 * **時間軸と値を両方置けば、どちらも立つ。** 測定は `npm run lab:keyframe:hold`。
 *
 * 既定の時間軸なら素の数へ畳む（覚えるものが無いので）。**この形が出るのは、
 * 人が既定でない時間軸を選んだ値だけ**なので、ふつうのクリップの JSON は 1 文字も増えない。
 */
export interface StillTrack {
  base: TrackBase;
  v: number;
  /** 打点の列と見分けるための目印（`keys` が無い側であることを型でも言う）。 */
  keys?: undefined;
}

/**
 * 時間で変化する値。**素の数をそのまま受ける**ので、保存済みのプロジェクトがそのまま読める。
 */
export type AnimatedTrack = number | KeyedTrack | StillTrack;

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

/**
 * 打点の列を持っているか。
 *
 * **`typeof !== 'number'` で判定してはいけない。** 畳んだ形（`StillTrack`）も数ではないので、
 * そこで分けると `value.keys.length` が undefined を読む。列そのものを見る。
 */
export const isKeyedTrack = (value: AnimatedTrack): value is KeyedTrack =>
  typeof value !== 'number' && Array.isArray((value as KeyedTrack).keys);

/** 打点は無いが時間軸を覚えている形か。 */
export const isStillTrack = (value: AnimatedTrack): value is StillTrack =>
  typeof value !== 'number' && !Array.isArray((value as KeyedTrack).keys);

/** 打点の列（素の数・畳んだ形なら空）。 */
export const keysOfTrack = (value: AnimatedTrack): Keyframe[] =>
  isKeyedTrack(value) ? value.keys : [];

/**
 * 値そのものが名乗っている時間軸（名乗っていなければ `source`）。
 *
 * **クリップの種類を見ないので、素の数には使えない。** 種類の既定まで含めて知りたいときは
 * `trackBaseIn()`（クリップを渡す版）を使う。
 */
export const trackBaseOf = (value: AnimatedTrack): TrackBase =>
  typeof value === 'number' ? 'source' : (value.base ?? 'source');

/**
 * その値を**いま何の秒として読むか**。打点を置く / 消す / 軸を替える所は全部ここを通す。
 *
 * **「覚えている軸」と「既定の軸」を呼ぶ側それぞれで足し合わせると、
 * 1 か所書き忘れたときだけ黙ってずれる**（画面がそうなっていた）。
 *
 * 種類の既定へ落ちるのは**素の数のときだけ**で、`base` を省いた打点の列は `source` と読む
 * ——`sampleClipValue()` がそう読んでいるので、そこと食い違わせない
 * （食い違うと「読むときは素材の秒・畳むときは頭からの秒」という形で、保存を通した値だけが壊れる）。
 */
export const trackBaseIn = (clip: ClipTiming, value: AnimatedTrack): TrackBase =>
  typeof value === 'number' ? defaultTrackBase(clip.kind) : trackBaseOf(value);

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
  // 畳んだ形（打点は無い・時間軸だけ覚えている）は、覚えている値をそのまま返す。
  // **ここで `fallback` を返すと「打点を全部消したのに値が既定へ戻った」になる。**
  if (!isKeyedTrack(value)) return Number.isFinite(value.v) ? value.v : fallback;
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
  /**
   * **素の数**（一度も打点を置いていない値）に、最初の打点を置くときの時間軸。
   *
   * 2026-09-27 の 2 回目に画面から要って足した引数。当時は打点が 0 個の値に時間軸が
   * 残っていなかったので、**画面が自分で覚えて毎回渡す**しかなかった。
   * 3 回目に畳んだ形（`StillTrack`）が時間軸を持つようになったので、
   * **一度でも軸を選んだ値では要らなくなった**（値の側から拾える）。
   * 先に軸だけ決めたいなら `setTrackBase()` を通すほうが、保存も複製もコピーも運べる。
   */
  wantBase?: TrackBase,
): AnimatedTrack {
  // **値が時間軸を名乗っているなら、それを動かさない。**
  // 種類の既定を当てにいくと、テロップに `source` で打点を置いていた値が
  // 2 つ目を足した瞬間に `local` として読み直され、1 つ目の打点だけ場所が飛ぶ。
  // 畳んだ形（`StillTrack`）も名乗っているので、**打点が 0 個でもここで拾える**
  // （`wantBase` が要るのは素の数のときだけになった）。
  const base = typeof value === 'number' ? (wantBase ?? defaultTrackBase(clip.kind)) : trackBaseIn(clip, value);
  const keys = keysOfTrack(value);
  const v = next ?? sampleClipValue(clip, value, time, typeof value === 'number' ? value : 0);
  const t = keyTimeIn(base, clip, time);
  return { base, keys: normalizeKeys([...keys, { t, v, ...(ease ? { ease } : {}) }]) };
}

/**
 * 打点を 1 つ取り除く。**列が空になったら畳む**（`{ keys: [] }` を残さない）。
 *
 * 空の列を残すと、読む側が毎コマ `fallback` を通ることになり、
 * 「打点を全部消したのに値が既定へ戻った」という形で見える。
 * 畳んだ先は `collapseTrack()`——既定の時間軸なら素の数、外した軸なら `{ base, v }`。
 */
export function removeKeyAt(
  clip: ClipTiming,
  value: AnimatedTrack,
  t: number,
  fallback: number,
  epsilon = 1e-6,
): AnimatedTrack {
  if (!isKeyedTrack(value)) return value;
  const keys = value.keys.filter((k) => Math.abs(k.t - t) > epsilon);
  if (keys.length === 0) return collapseTrack(clip, value, fallback);
  return { ...value, keys };
}

/**
 * 打点が 0 個になった値を畳む。**時間軸が既定なら素の数、そうでなければ覚えておく形。**
 *
 * `clip` を受けるようになったのはここのため（2026-09-27 の 3 回目）。
 * 種類の既定と同じ軸まで覚えると、**ふつうのクリップの JSON が打点を消すたびに太る**
 * ので、覚える価値があるのは「人が既定から外した軸」だけ。
 */
export function collapseTrack(
  clip: ClipTiming,
  value: AnimatedTrack,
  fallback: number,
): AnimatedTrack {
  const v = lastValueOf(value, fallback);
  const base = trackBaseIn(clip, value);
  return base === defaultTrackBase(clip.kind) ? v : { base, v };
}

/** 打点を畳むときに残す値（最後に残っていた打点の値／畳んだ形ならその値）。 */
function lastValueOf(value: AnimatedTrack, fallback: number): number {
  if (typeof value === 'number') return value;
  if (!isKeyedTrack(value)) return Number.isFinite(value.v) ? value.v : fallback;
  if (value.keys.length === 0) return fallback;
  return value.keys[value.keys.length - 1].v;
}

/**
 * **時間軸を選ぶ口**（「この値は尺に伸ばしたい」を人が先に決める所）。
 *
 * 打点が 0 個でも呼べるのがここの役目。これが無いと、既定でない時間軸を持てるのは
 * 「型が名乗る」（`kenBurns()`）か「打点を置くときに画面が覚えている軸を渡す」だけで、
 * **画面が覚えている限り、保存も複製もコピーも運べない。**
 *
 * 打点を持っている値では、**見た目が変わらないように時刻を写し替える**。
 * 写し替えないと、`fraction` の 1.0（尻）が `local` の 1.0 秒として読み直されて曲線ごと飛ぶ。
 * 写し替えは画面にも同じものが書いてあったが、**2 か所に置くと食い違ったとき
 * どちらが正しいか読めない**ので、ここへ寄せた。
 */
export function setTrackBase(
  clip: ClipTiming,
  value: AnimatedTrack,
  base: TrackBase,
  fallback = 0,
): AnimatedTrack {
  const from = trackBaseIn(clip, value);
  if (isKeyedTrack(value)) {
    if (from === base) return value;
    const keys = normalizeKeys(
      value.keys.map((k) => ({
        ...k,
        t: keyTimeInUnclamped(base, clip, timeAtKeyTime(from, clip, k.t)),
      })),
    );
    return { base, keys };
  }
  // 打点が無い側。既定へ戻すなら覚えるものが無いので素の数へ畳む。
  const v = lastValueOf(value, fallback);
  return base === defaultTrackBase(clip.kind) ? v : { base, v };
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

/**
 * 打点の時刻 → タイムラインの時刻（`keyTimeIn()` の**逆向き**）。
 *
 * **画面を作って初めて要ると分かった所。** 読むだけなら片道（タイムラインの秒 → 打点の秒）で
 * 足りるので、2026-09-27 の測定にも本体の `renderer.ts` へ差す形にも逆は出てこない。
 * ところが打点を**描く / つまむ**には逆が要る——「この打点はキャンバスのどこに立つのか」が
 * 分からないと、点も曲線も置けない。
 *
 * `source` では速さで割る。速さ 0 は本体が作らせないが、**保存した JSON から来る値**なので、
 * 0 のときはクリップの頭へ落とす（`Infinity` を返して描画ごと消さないため）。
 */
export function timeAtKeyTime(base: TrackBase, clip: ClipTiming, t: number): number {
  if (base === 'local') return clip.start + t;
  if (base === 'fraction') return clip.start + t * clip.duration;
  const speed = clip.speed || 1;
  return speed > 0 ? clip.start + (t - clip.sourceIn) / speed : clip.start;
}

/**
 * `keyTimeIn()` の、**クリップの頭で丸めない版**（つまむとき用）。
 *
 * 本体の `sourceTimeAt()` は `Math.max(0, time - start)` で頭を丸めている。
 * 読む側はクリップの外を読まないので丸めて困らないが、**つまむ側は丸めると壊れる**——
 * 頭より前に居る打点（`video-fade-in` を詰めた状態がそれ）を掴むと、
 * 丸めのせいで掴んだ先が `sourceIn` に張り付き、離した瞬間に曲線ごと飛ぶ。
 * **「刈らない」と決めた打点は、必ずこの外側に居る**ので、丸めた式では触れない。
 */
export function keyTimeInUnclamped(base: TrackBase, clip: ClipTiming, time: number): number {
  if (base === 'local') return time - clip.start;
  if (base === 'fraction') return clip.duration > 0 ? (time - clip.start) / clip.duration : 0;
  return clip.sourceIn + (time - clip.start) * (clip.speed || 1);
}
