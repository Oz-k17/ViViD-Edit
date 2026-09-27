/**
 * 時間で変化する値（キーフレーム）の**持ち方**と、そこから 1 コマぶんの値を取り出す所。
 *
 * ここは秒とスカラーしか見ない。クリップもタイムラインも知らないので、
 * 「その値が**どの時間軸**の秒で書かれているか」は `timebase.ts` が決める。
 * 分けてあるのは、**持ち方の議論（どう並べるか）と時間軸の議論（何秒として読むか）が別物**で、
 * 混ぜると「壊れたのは並べ方か、読み方か」が分からなくなるため。
 *
 * ## なぜ `number | { keys }` なのか
 *
 * 本体（`src/model/types.ts`）の `Clip` は `opacity: number` のような素の数を持っている。
 * ここを `{ keys: [...] }` だけにすると、**保存済みのプロジェクトと過去の履歴が全部読めなくなる**
 * （`project-file.ts` は JSON をそのまま畳んでいるだけなので、移行の当てが無い）。
 * 素の数をそのまま「打点が 1 つも無い＝ずっとその値」として受けられる形にしてあるので、
 * 読む側は `sampleAnimated()` に渡すだけでよく、**動かしていないクリップは JSON も 1 文字も増えない。**
 * 費用は `npm run lab:keyframe` の 3 段目で測ってある。
 *
 * ## 打点の並びは「書くときに」整える
 *
 * `sampleAnimated()` は**並んでいることを前提に**二分探索する。毎コマ・毎クリップ・
 * 値ごとに呼ばれる所なので、ここで並べ替えをすると尺とクリップ数の積で効いてくる。
 * 代わりに、打点を足す / 動かす側が `normalizeKeys()` を通す約束にした。
 */

/** 打点から次の打点までの繋ぎ方。 */
export type Ease = 'hold' | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface Keyframe {
  /** 時刻（秒）。何の秒かは `timebase.ts` が決める。 */
  t: number;
  v: number;
  /**
   * **この打点から次の打点まで**の繋ぎ方（省略時は `linear`）。
   *
   * 繋ぎ方を「区間」ではなく「手前の打点」に持たせたのは、打点を消したときに
   * どの繋ぎ方が残るかが一意に決まるため（区間に持たせると、消した区間の設定が宙に浮く）。
   */
  ease?: Ease;
}

/** 素の数なら「ずっとその値」、`{ keys }` なら打点の列。 */
export type Animated = number | { keys: Keyframe[] };

export function isKeyed(value: Animated): value is { keys: Keyframe[] } {
  return typeof value !== 'number';
}

/** 打点の列（または素の数）から、打点の配列を取り出す。素の数なら空。 */
export function keysOf(value: Animated): Keyframe[] {
  return isKeyed(value) ? value.keys : [];
}

/**
 * 打点の列を整える（書き込む側が通す）。
 *
 * - 数になっていない打点は捨てる（`NaN` が 1 つ混じると二分探索の結果が場所によって変わる）
 * - 時刻の順に並べる
 * - **同じ時刻の打点は後から来たほうを残す**（前を残すと、打点を重ねて置いたときに
 *   新しく置いたほうが無かったことになり、画面から見て「置けなかった」ように見える）
 */
export function normalizeKeys(keys: readonly Keyframe[]): Keyframe[] {
  const clean = keys.filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v));
  // 時刻が同じときは元の並び順を保つ（後勝ちを成り立たせるため、安定な並べ替えが要る）。
  const sorted = clean
    .map((k, i) => ({ k, i }))
    .sort((a, b) => (a.k.t === b.k.t ? a.i - b.i : a.k.t - b.k.t))
    .map(({ k }) => k);
  const out: Keyframe[] = [];
  for (const k of sorted) {
    if (out.length > 0 && out[out.length - 1].t === k.t) out[out.length - 1] = k;
    else out.push({ t: k.t, v: k.v, ...(k.ease && k.ease !== 'linear' ? { ease: k.ease } : {}) });
  }
  return out;
}

/** 打点を 1 つ置く / 同じ時刻なら差し替える。列は整った状態で返る。 */
export function putKey(value: Animated, key: Keyframe): Animated {
  return { keys: normalizeKeys([...keysOf(value), key]) };
}

/** 0〜1 の進み具合を繋ぎ方で曲げる。`easeOut` は本体のテロップと同じ形（`1-(1-u)^3`）。 */
export function easeAt(ease: Ease | undefined, u: number): number {
  switch (ease) {
    case 'hold':
      return 0;
    case 'easeIn':
      return u * u * u;
    case 'easeOut':
      return 1 - (1 - u) ** 3;
    case 'easeInOut':
      return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    default:
      return u;
  }
}

/**
 * 時刻 `t` の手前にある打点の番号を返す（`t` が最初の打点より前なら -1）。
 *
 * **列が時刻の順に並んでいることを前提にしている**（`normalizeKeys()` を通すこと）。
 *
 * ## なぜ二分探索なのか（速いほうではない）
 *
 * 測ると、**ふつうに使う 2〜16 個では前から見るほうが 2 割速い**（`npm run lab:keyframe` の 3 段目）。
 * それでも二分にしたのは、音量の曲線のように**打点が数百になりうる値**があり、
 * そこで 3.9 倍に開くため（512 個で 73 ns 対 283 ns）。
 * 2 割が惜しい側の絶対値は「書き出し 1 本で 1ms」の 2 割なので、悪くなる側の桁を取った。
 */
export function findSegment(keys: readonly Keyframe[], t: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * 時刻 `t` の値を取り出す。
 *
 * - 打点が 1 つも無ければ `fallback`
 * - 最初の打点より前／最後の打点より後ろは、その打点の値を**保つ**（伸ばしも折り返しもしない）
 *
 * `fallback` を呼ぶ側に出させているのは、**値ごとに「無い」の意味が違う**ため。
 * 不透明度で 0 を既定にすると絵が消え、拡大で 0 を既定にすると絵が無くなる。
 * 空の列を 0 と読む作りにすると、**打点を全部消した瞬間にクリップが消える。**
 */
export function sampleAnimated(value: Animated, t: number, fallback = 0): number {
  if (!isKeyed(value)) return value;
  const keys = value.keys;
  if (keys.length === 0) return fallback;
  if (keys.length === 1) return keys[0].v;
  // NaN はどちらの端とも比べられないので、先に最初の打点へ落とす。
  // ±Infinity はこの下の端の判定がそのまま正しく効く（前なら最初・後ろなら最後）。
  if (Number.isNaN(t)) return keys[0].v;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;

  const i = findSegment(keys, t);
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  // 同じ時刻の打点は `normalizeKeys()` が畳むので span > 0。畳む前の列を渡されても落ちないようにする。
  if (span <= 0) return b.v;
  return a.v + (b.v - a.v) * easeAt(a.ease, (t - a.t) / span);
}

/** 打点の列が持つ時刻の範囲（空なら null）。 */
export function keyRange(value: Animated): { from: number; to: number } | null {
  const keys = keysOf(value);
  if (keys.length === 0) return null;
  return { from: keys[0].t, to: keys[keys.length - 1].t };
}

/** 時刻を一律にずらす（時間軸を付け替えるときに使う。値は触らない）。 */
export function shiftKeys(value: Animated, delta: number): Animated {
  if (!isKeyed(value)) return value;
  return { keys: value.keys.map((k) => ({ ...k, t: k.t + delta })) };
}

/** 時刻を一律に伸縮する（速さを変えたときなど）。`factor` は 0 より大きいこと。 */
export function scaleKeys(value: Animated, factor: number, pivot = 0): Animated {
  if (!isKeyed(value) || !(factor > 0)) return value;
  return { keys: value.keys.map((k) => ({ ...k, t: pivot + (k.t - pivot) * factor })) };
}
