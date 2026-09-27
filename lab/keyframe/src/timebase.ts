/**
 * 打点の秒を**何の秒として読むか**（時間軸）と、編集したときに何が要るか。
 *
 * ここがこの試作の本題。値の並べ方（`value.ts`）はどの時間軸でも同じなので、
 * 設計で決めないといけないのは**「打点の時刻を何に結び付けるか」だけ**になる。
 *
 * ## 4 通りしか無い
 *
 * | 時間軸 | 打点の 2.0 秒が指すもの |
 * | --- | --- |
 * | `source` | 素材の 2.0 秒（`sourceTimeAt()` と同じ読み方） |
 * | `local` | クリップの頭から 2.0 秒 |
 * | `absolute` | タイムラインの 2.0 秒 |
 * | `fraction` | クリップの尺の 2.0 割（0〜1 で書く） |
 *
 * どれが良いかは「編集したあとに人が期待する絵になるか」で決まるので、
 * **先に測る**（`npm run lab:keyframe:probe`）。ここでは 4 通りを同じ形で並べるだけにしてある。
 *
 * ## 編集の操作は本体から写している
 *
 * `move` / `trimLeft` / `trimRight` / `split` / `setSpeed` / `rippleShift` は
 * `src/model/ops.ts` と `src/components/editor/Inspector.tsx` の振る舞いをそのまま写した。
 * 重なりの削り取り（`carve`）は写していない——あれは**クリップを消す / 割る**操作で、
 * 割るほうは `split` と同じ計算（`splitOne`）なので、時間軸の当たり外れは `split` で出る。
 *
 * 写しで大事なのは 1 か所だけ:
 * **`trimLeft` は、テロップと静止画では `sourceIn` を動かさない**（本体がそうしている）。
 * 素材の中に「そのコマ」が無いものは、頭を詰めても中身が変わらないため。
 * この 1 行が、あとで `source` と `local` の当たり方を分ける。
 */

import { scaleKeys, shiftKeys, type Animated } from './value.ts';
import { keyTimeIn, sourceTimeAt, type ClipKind, type ClipTiming } from './track.ts';

/** 測るための 4 通り。`track.ts` の 3 つ＋タイムラインの秒（`absolute`）。 */
export type TimeBase = 'source' | 'local' | 'absolute' | 'fraction';
export const TIME_BASES: TimeBase[] = ['source', 'local', 'absolute', 'fraction'];

export type { ClipKind };
export { sourceTimeAt };

/**
 * 測るのに要る所だけに削ったクリップ。本体の `Clip` の部分集合。
 * 動かす値は 1 本だけ持つ（本体では `scale` / `opacity` / `x` / `y` ごとに 1 本ずつ）。
 */
export interface LabClip extends ClipTiming {
  id: string;
  value: Animated;
}

export const clipEnd = (clip: LabClip): number => clip.start + clip.duration;

/**
 * タイムラインの時刻を、その時間軸での打点の時刻に直す。
 *
 * `absolute` 以外は `track.ts` の `keyTimeIn()` をそのまま呼ぶ。
 * **写さずに呼んでいるのは、測っている式と持っていく式が食い違わないようにするため**
 * （食い違うと、直したのが測定なのか本体なのか後から読めなくなる）。
 */
export function keyTimeAt(base: TimeBase, clip: LabClip, time: number): number {
  return base === 'absolute' ? time : keyTimeIn(base, clip, time);
}

/** 頭を詰めても素材の中身が変わらない種類（本体の `trimClip` がこう分けている）。 */
export const hasSourceFrames = (kind: ClipKind): boolean => kind === 'video' || kind === 'audio';

// ---------------------------------------------------------------------------
// 編集の操作（本体の写し）。打点の付け替えは `rebase` に集めてある。
// ---------------------------------------------------------------------------

/**
 * 打点の時刻を編集に合わせて付け替える。
 *
 * **ここが空で済む時間軸ほど、本体に入れるときの傷が浅い。**
 * `src/model/ops.ts` は `structuredClone` でクリップを丸ごと写すので、
 * 付け替えが要らない時間軸なら**本体の操作に 1 行も足さずに**打点が付いてくる。
 * 逆に付け替えが要る時間軸は、操作の数だけ本体に手が入り、
 * **写し忘れた 1 か所が「たまに動かない」になって出る。**
 */
type Rebase = (value: Animated, before: LabClip, after: LabClip) => Animated;

/** 何もしない（＝その時間軸では、この操作で打点を触る必要が無い）。 */
const keep: Rebase = (value) => value;

/**
 * 付け替えの方針。**ここを時間軸と分けておくのが、この試作でいちばん大事な所。**
 *
 * - `raw`: 何も付け替えない。打点はその時間軸が指すものに**そのまま付いていく**
 * - `follow`: 素材の中身に合わせて付け替える（どの時間軸でも「絵に付く」ようにする）
 *
 * 最初は `follow` だけを書いて 4 通りを比べたが、それだと
 * **「どの期待（絵に付く / 頭に付く / 尺に伸びる）を選ぶか」を付け替えの中身が先に決めてしまう。**
 * テロップとケンバーンズが 4 通りとも同じ値で落ちたのがその症状で、
 * 落ちていたのは時間軸ではなく**こちらが書いた付け替え**だった。
 */
export type RebasePolicy = 'raw' | 'follow';
export const REBASE_POLICIES: RebasePolicy[] = ['raw', 'follow'];

export interface EditOp {
  name: string;
  /** クリップをどう変えるか（打点は触らない）。2 つ返るのは `split` だけ。 */
  apply: (clip: LabClip) => LabClip[];
  /** 「絵に付く」ようにするための付け替え（時間軸ごと）。 */
  follow: Record<TimeBase, Rebase>;
}

const MIN_DURATION = 0.1;

/** 本体の `splitOne()` と同じ計算。 */
function splitOne(clip: LabClip, time: number): LabClip[] {
  const left: LabClip = { ...clip, duration: time - clip.start };
  const right: LabClip = {
    ...clip,
    id: `${clip.id}-r`,
    start: time,
    duration: clipEnd(clip) - time,
    sourceIn: clip.sourceIn + (time - clip.start) * (clip.speed || 1),
  };
  return [left, right];
}

/** 本体の `trimClip(side='left')` と同じ計算。 */
function trimLeft(clip: LabClip, delta: number): LabClip {
  const speed = clip.speed || 1;
  const limit = hasSourceFrames(clip.kind) ? -clip.sourceIn / speed : Number.NEGATIVE_INFINITY;
  const d = Math.max(Math.max(limit, -clip.start), Math.min(clip.duration - MIN_DURATION, delta));
  return {
    ...clip,
    start: clip.start + d,
    duration: clip.duration - d,
    sourceIn: hasSourceFrames(clip.kind) ? clip.sourceIn + d * speed : clip.sourceIn,
  };
}

/**
 * 頭が動いたぶん、クリップの頭からの秒はいくつずれるか。
 *
 * **ここに速さを掛けてはいけない。** `local` の秒はタイムライン側の秒なので、
 * ずれるのは動いた秒そのもの（素材側の秒は `sourceIn` が同じ量 × 速さで動いて釣り合う）。
 * 最初は `× speed` を掛けていて、`video-2x`（2 倍速）だけが 0.600 ずれて出た。
 * **速さ 1 の素材しか置いていなければ、この間違いは表に出ない。**
 */
const headShift = (before: LabClip, after: LabClip): number => after.start - before.start;

/**
 * 操作の一覧。引数（何秒動かすか等）は素材ごとに変えたいので、作る関数にしてある。
 */
export function editOps(opts: {
  moveBy: number;
  trimHead: number;
  trimTail: number;
  splitAt: (clip: LabClip) => number;
  speedTo: number;
  rippleBy: number;
}): EditOp[] {
  return [
    {
      // 掴んで横へ動かす。中身は 1 コマも変わらないので、見える絵も変わってはいけない。
      name: 'move',
      apply: (c) => [{ ...c, start: Math.max(0, c.start + opts.moveBy) }],
      follow: {
        source: keep,
        local: keep,
        // タイムラインの秒で書いてあると、動かしたぶん打点も動かさないと絵が変わる。
        absolute: (v, before, after) => shiftKeys(v, after.start - before.start),
        fraction: keep,
      },
    },
    {
      // 頭を詰める。映像なら「前を切り落とす」、テロップなら「出てくるのを遅らせる」。
      name: 'trimLeft',
      apply: (c) => [trimLeft(c, opts.trimHead)],
      follow: {
        source: keep,
        local: (v, before, after) => shiftKeys(v, -headShift(before, after)),
        // 残った所はタイムライン上の場所が動かないので、絶対の秒は触らなくてよい。
        absolute: keep,
        // 尺も頭も動く。割合で書いてあると両方ぶん付け替えが要る。
        fraction: (v, before, after) => {
          const head = headShift(before, after) / before.duration;
          return scaleKeys(shiftKeys(v, -head), before.duration / after.duration);
        },
      },
    },
    {
      // 尻を詰める / 伸ばす。残った所の絵は変わってはいけない。
      name: 'trimRight',
      apply: (c) => [{ ...c, duration: Math.max(MIN_DURATION, c.duration + opts.trimTail) }],
      follow: {
        source: keep,
        local: keep,
        absolute: keep,
        fraction: (v, before, after) => scaleKeys(v, before.duration / after.duration),
      },
    },
    {
      // 割る。本体は `structuredClone` で両方に同じ値を配るので、付け替えは右側に効く。
      name: 'split',
      apply: (c) => splitOne(c, opts.splitAt(c)),
      follow: {
        source: keep,
        local: (v, before, after) => shiftKeys(v, -headShift(before, after)),
        absolute: keep,
        fraction: (v, before, after) => {
          const head = headShift(before, after) / before.duration;
          return scaleKeys(shiftKeys(v, -head), before.duration / after.duration);
        },
      },
    },
    {
      // 速さを変える。尺はそのままで、見える中身の範囲が変わる（本体の Inspector と同じ）。
      name: 'setSpeed',
      apply: (c) => [{ ...c, speed: opts.speedTo }],
      follow: {
        source: keep,
        local: (v, before, after) => scaleKeys(v, (before.speed || 1) / (after.speed || 1), 0),
        absolute: (v, before, after) =>
          scaleKeys(v, (before.speed || 1) / (after.speed || 1), before.start),
        fraction: (v, before, after) => scaleKeys(v, (before.speed || 1) / (after.speed || 1), 0),
      },
    },
    {
      // 前のクリップが消えて、後ろが詰められた（リップル削除の巻き添え）。中身は変わらない。
      name: 'rippleShift',
      apply: (c) => [{ ...c, start: Math.max(0, c.start + opts.rippleBy) }],
      follow: {
        source: keep,
        local: keep,
        absolute: (v, before, after) => shiftKeys(v, after.start - before.start),
        fraction: keep,
      },
    },
  ];
}

/** 操作を 1 つ当てて、打点の付け替えまで済ませたクリップを返す。 */
export function applyOp(
  op: EditOp,
  base: TimeBase,
  clip: LabClip,
  policy: RebasePolicy = 'follow',
): LabClip[] {
  const rebase = policy === 'raw' ? keep : op.follow[base];
  return op.apply(clip).map((after) => ({ ...after, value: rebase(clip.value, clip, after) }));
}

/** その時間軸・方針で、打点を触らないといけない操作の名前（＝本体に手を入れる箇所）。 */
export function rebaseSites(base: TimeBase, ops: EditOp[], policy: RebasePolicy = 'follow'): string[] {
  if (policy === 'raw') return [];
  return ops.filter((op) => op.follow[base] !== keep).map((op) => op.name);
}
