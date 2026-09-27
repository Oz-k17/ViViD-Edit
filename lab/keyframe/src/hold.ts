/**
 * **既定でない時間軸を、打点の外のどこに持つか。** 4 通りを同じ形で並べて測る所。
 *
 *   npm run lab:keyframe:hold
 *
 * ## なぜこれを測るのか
 *
 * 時間軸（`source` / `local` / `fraction`）は値と一緒に持つ、と 2026-09-27 の 1 回目に決めた。
 * ところが**打点を全部消すと値は素の数へ畳まれる**（`removeKeyAt()`）ので、そこで軸も消える。
 * 消えると次に置いた打点が種類の既定で読まれ、尺 5 秒の静止画では立つ所が 4.00 秒動く。
 * 画面（2 回目）は自分で軸を覚えて `putKeyAtTime(..., base)` に渡して逃げているが、
 * **画面が覚えている限り、保存も複製もコピーも運べない。**
 *
 * 直し方の候補は 4 つある。**どれも「軸が生き残るか」だけでは選べない**——
 * 生き残る場所を変えると、別の操作で落ちる先が変わるだけのことがある。
 * なので**操作 × 持ち方**の表にして、「何が消えたか（軸 / 値）」を分けて測る。
 *
 * | 持ち方 | どこに持つか |
 * | --- | --- |
 * | `inKeys` | 打点の列と一緒（**いまの形**）。打点が 0 個になると消える |
 * | `emptyKeys` | 空の列を残す（`{ base, keys: [] }`）。`track.ts` が避けていた形 |
 * | `stillValue` | 畳んだ形が**軸と値を両方**持つ（`{ base, v }`） |
 * | `onClip` | クリップの側に、値の名前ごとの表で持つ（`baseMemo`） |
 *
 * ## 測るのに要った 2 つの操作
 *
 * ふつうの操作（保存・複製・割る）は 4 通りとも通る。**分かれるのはこの 2 つだけ**で、
 * どちらも「値と時間軸が別々に動く」瞬間:
 *
 * - **打点を全部消して置き直す** — 値だけが残り、軸が置き場所を失う
 * - **値だけを別のクリップへ写す**（コピー / プリセット / テンプレート）— 値だけが動く
 *
 * ここは `timebase.ts` の編集の操作（`move` / `trimLeft` / …）とは別の列で、
 * **クリップの形はまったく変わらない。** だから 1 回目・2 回目の測定には出てこなかった。
 */

import { normalizeKeys, sampleAnimated, type Ease, type Keyframe } from './value.ts';
import {
  defaultTrackBase,
  keyTimeIn,
  timeAtKeyTime,
  type ClipKind,
  type ClipTiming,
  type TrackBase,
} from './track.ts';
import type { LabClip } from './timebase.ts';
import { SCENARIOS, type Intent, type Scenario } from './scenarios.ts';

export type HoldName = 'inKeys' | 'emptyKeys' | 'stillValue' | 'onClip';
export const HOLDS: HoldName[] = ['inKeys', 'emptyKeys', 'stillValue', 'onClip'];

export const HOLD_NOTE: Record<HoldName, string> = {
  inKeys: '打点の列と一緒（いまの形）',
  emptyKeys: '空の列を残す { base, keys: [] }',
  stillValue: '畳んだ形が軸と値を持つ { base, v }',
  onClip: 'クリップの側に値の名前ごとの表',
};

/**
 * 4 通りが作る形をぜんぶ受ける入れ物。
 *
 * **読む道を 1 本にしてある**のが大事な所で、持ち方ごとに読み方を書くと
 * 「落ちたのは持ち方か読み方か」が分からなくなる（`timebase.ts` が付け替えで踏んだ穴と同じ形）。
 */
export type HeldValue = number | { base?: TrackBase; keys?: Keyframe[]; v?: number };

/** `onClip` だけが使う覚え書きを足したクリップ。 */
export interface HoldClip extends ClipTiming {
  /** 値の名前 → 時間軸。**既定と同じ軸は書かない**（書くと JSON が毎回太る）。 */
  baseMemo?: Record<string, TrackBase>;
}

/** 動かす値 1 本ぶん（クリップ・値の名前・値）。 */
export interface Slot {
  clip: HoldClip;
  prop: string;
  value: HeldValue;
}

export const keysIn = (value: HeldValue): Keyframe[] =>
  typeof value === 'number' ? [] : (value.keys ?? []);

const withMemo = (clip: HoldClip, prop: string, base: TrackBase | null): HoldClip => {
  const memo = { ...(clip.baseMemo ?? {}) };
  if (base === null || base === defaultTrackBase(clip.kind)) delete memo[prop];
  else memo[prop] = base;
  return Object.keys(memo).length > 0 ? { ...clip, baseMemo: memo } : { ...clip, baseMemo: undefined };
};

/** その持ち方が**覚えている**時間軸（覚えていなければ null）。 */
export function rememberedBase(hold: HoldName, slot: Slot): TrackBase | null {
  if (hold === 'onClip') return slot.clip.baseMemo?.[slot.prop] ?? null;
  if (typeof slot.value === 'number') return null;
  return slot.value.base ?? null;
}

/** いま読むときに使う時間軸（覚えていなければ種類の既定）。 */
export const baseOf = (hold: HoldName, slot: Slot): TrackBase =>
  rememberedBase(hold, slot) ?? defaultTrackBase(slot.clip.kind);

/**
 * 1 コマぶんの値。**4 通りで同じ道を通る。**
 *
 * 畳んだ形で `v` を持っていなければ `fallback`——ここが `emptyKeys` の落ちる所で、
 * 「打点を全部消したのに値が既定へ戻った」として出る。
 */
export function readAt(hold: HoldName, slot: Slot, time: number, fallback: number): number {
  const value = slot.value;
  if (typeof value === 'number') return value;
  const keys = value.keys ?? [];
  if (keys.length > 0) {
    return sampleAnimated({ keys }, keyTimeIn(baseOf(hold, slot), slot.clip, time), fallback);
  }
  return Number.isFinite(value.v) ? (value.v as number) : fallback;
}

/** 打点を 1 つ置く（本体の `putKeyAtTime()` に当たる）。 */
export function putAt(
  hold: HoldName,
  slot: Slot,
  time: number,
  fallback: number,
  next?: number,
  ease?: Ease,
): Slot {
  const base = baseOf(hold, slot);
  const v = next ?? readAt(hold, slot, time, typeof slot.value === 'number' ? slot.value : fallback);
  const t = keyTimeIn(base, slot.clip, time);
  const keys = normalizeKeys([...keysIn(slot.value), { t, v, ...(ease ? { ease } : {}) }]);
  return hold === 'onClip'
    ? { ...slot, clip: withMemo(slot.clip, slot.prop, base), value: { keys } }
    : { ...slot, value: { base, keys } };
}

/** 打点を 1 つ消す。**0 個になったときの畳み方が、持ち方そのもの。** */
export function removeAt(hold: HoldName, slot: Slot, t: number, epsilon = 1e-6): Slot {
  const before = keysIn(slot.value);
  if (before.length === 0) return slot;
  const keys = before.filter((k) => Math.abs(k.t - t) > epsilon);
  if (keys.length > 0) {
    return hold === 'onClip'
      ? { ...slot, value: { keys } }
      : { ...slot, value: { base: baseOf(hold, slot), keys } };
  }
  const last = before[before.length - 1].v;
  const base = baseOf(hold, slot);
  switch (hold) {
    // 素の数へ畳む。**値は残るが軸が消える。**
    case 'inKeys':
      return { ...slot, value: last };
    // 空の列を残す。**軸は残るが値が消える**（読む側が fallback を通る）。
    case 'emptyKeys':
      return { ...slot, value: { base, keys: [] } };
    // 軸と値を両方置く。既定の軸なら覚えるものが無いので素の数へ。
    case 'stillValue':
      return { ...slot, value: base === defaultTrackBase(slot.clip.kind) ? last : { base, v: last } };
    // 素の数へ畳むが、軸はクリップの側に残っている。
    case 'onClip':
      return { ...slot, value: last };
  }
}

/** 打点を全部消す（人が 1 つずつ消した形）。 */
export function clearAll(hold: HoldName, slot: Slot): Slot {
  let out = slot;
  // 消すたびに列が変わるので、毎回いまの先頭を取る。
  for (let guard = 0; guard < 64 && keysIn(out.value).length > 0; guard += 1) {
    out = removeAt(hold, out, keysIn(out.value)[0].t);
  }
  return out;
}

/**
 * **打点を置く前に時間軸だけを選ぶ**（「この値は尺に伸ばしたい」を先に決める口）。
 *
 * 書けない持ち方は `null` を返す。`inKeys` は置き場所が無いのでここで落ちる
 * ——それが「画面が自分で覚えるしかなかった」の正体。
 */
export function chooseBase(hold: HoldName, slot: Slot, base: TrackBase): Slot | null {
  const keys = keysIn(slot.value);
  if (keys.length > 0) {
    // 打点があるならどの持ち方でも書ける（時刻の写し替えは呼ぶ側の仕事＝画面の `kf-base`）。
    return hold === 'onClip'
      ? { ...slot, clip: withMemo(slot.clip, slot.prop, base) }
      : { ...slot, value: { base, keys } };
  }
  const v = typeof slot.value === 'number' ? slot.value : slot.value.v;
  switch (hold) {
    case 'inKeys':
      return null;
    case 'emptyKeys':
      // 空の列にすると、そこに入っていた素の数が落ちる。
      return { ...slot, value: { base, keys: [] } };
    case 'stillValue':
      return { ...slot, value: { base, v: v as number } };
    case 'onClip':
      return { ...slot, clip: withMemo(slot.clip, slot.prop, base) };
  }
}

// ---------------------------------------------------------------------------
// 値とクリップの運び方（ここが持ち方の当たり外れを分ける）
// ---------------------------------------------------------------------------

/** 保存 → 読み直し。本体の `project-file.ts` はクリップごと JSON を畳んでいる。 */
export const saveLoad = (slot: Slot): Slot => JSON.parse(JSON.stringify(slot));

/** クリップを複製する。本体の操作は `structuredClone` でクリップを丸ごと写す。 */
export const duplicateClip = (slot: Slot): Slot => structuredClone(slot);

/**
 * **値だけを別のクリップへ写す**（コピー＆ペースト / プリセット / テンプレート）。
 *
 * クリップは写らないので、クリップの側に覚えた軸は付いてこない。
 * 本体にこの口はまだ無いが、**「この寄りを別のカットにも」は短尺の編集でいちばん出る操作**で、
 * 打点を入れたら必ず要る。
 */
export const copyValueOnly = (slot: Slot, to: HoldClip): Slot => ({
  clip: to,
  prop: slot.prop,
  value: structuredClone(slot.value),
});

/** クリップを割る（右側だけ返す。本体の `splitOne()` と同じ形）。 */
export function splitRight(slot: Slot, time: number): Slot {
  const c = slot.clip;
  const clip: HoldClip = {
    ...c,
    start: time,
    duration: c.start + c.duration - time,
    sourceIn: c.sourceIn + (time - c.start) * (c.speed || 1),
  };
  return structuredClone({ ...slot, clip });
}

// ---------------------------------------------------------------------------
// 測るための素材（**既定でない時間軸を人が選びたい値**）
// ---------------------------------------------------------------------------

/**
 * 既定から外した軸が欲しい素材。**ここが無いと 4 通りの差は 1 本でしか出ない。**
 *
 * `SCENARIOS` の 6 本のうち、既定でない軸を要るのは `image-kenburns` だけ（静止画に `fraction`）。
 * 1 本では「たまたまその素材の都合」と見分けが付かないので、**種類の違う 3 本を足した**。
 * どれも `want` の軸だと編集 6 操作を素で通ることを、測る前に確かめている（`hold-probe.mjs` の 0 段目）。
 */
export interface OffDefault extends Scenario {
  /** 人が選びたい時間軸（`defaultTrackBase(kind)` と違うもの）。 */
  want: TrackBase;
}

const kenburns = SCENARIOS.find((s) => s.name === 'image-kenburns') as Scenario;

export const OFF_DEFAULTS: OffDefault[] = [
  // 静止画 × 尺の割合。既定は local。
  { ...kenburns, want: 'fraction' },
  {
    // 映像 × 尺の割合。既定は source なので、素材の秒から外す側。
    name: 'video-slow-push',
    note: '映像を尺いっぱいに 1.00 → 1.15 倍へゆっくり寄せる（尺に合わせたい）',
    intent: 'stretch',
    kind: 'video',
    start: 1,
    duration: 6,
    sourceIn: 5,
    speed: 1,
    fallback: 1,
    authored: [
      { at: 1, v: 1, ease: 'easeInOut' },
      { at: 7, v: 1.15 },
    ],
    edits: { moveBy: 2, trimHead: 1.2, trimTail: -1.5, splitAt: 4, speedTo: 2, rippleBy: -0.8 },
    want: 'fraction',
  },
  {
    // 映像 × 頭からの秒。既定は source。**頭を詰めても頭から開いてほしい**側。
    name: 'video-open',
    note: '映像クリップの頭 0.5 秒で開く（詰めても、その頭から開いてほしい）',
    intent: 'head',
    kind: 'video',
    start: 2,
    duration: 5,
    sourceIn: 8,
    speed: 1,
    fallback: 1,
    authored: [
      { at: 2, v: 0, ease: 'easeOut' },
      { at: 2.5, v: 1 },
    ],
    edits: { moveBy: 1.5, trimHead: 0.9, trimTail: -1, splitAt: 4, speedTo: 2, rippleBy: -0.5 },
    want: 'local',
  },
  {
    // テロップ × 尺の割合。既定は local。
    name: 'text-scroll',
    note: 'テロップを尺いっぱいに下から上へ流す（尺に合わせたい）',
    intent: 'stretch',
    kind: 'text',
    start: 4,
    duration: 4,
    sourceIn: 0,
    speed: 1,
    fallback: 0,
    authored: [
      { at: 4, v: -0.5 },
      { at: 8, v: 0.5 },
    ],
    edits: { moveBy: 2, trimHead: 0.8, trimTail: -1.2, splitAt: 6, speedTo: 1, rippleBy: -1 },
    want: 'fraction',
  },
];

export const INTENT_OF: Record<string, Intent> = Object.fromEntries(
  OFF_DEFAULTS.map((s) => [s.name, s.intent]),
);

/** その素材を、`want` の軸で持った状態の `Slot`。 */
export function slotFor(hold: HoldName, s: OffDefault, prop = 'value'): Slot {
  const clip: HoldClip = {
    kind: s.kind as ClipKind,
    start: s.start,
    duration: s.duration,
    sourceIn: s.sourceIn,
    speed: s.speed,
  };
  const keys = normalizeKeys(
    s.authored.map((k) => ({ t: keyTimeIn(s.want, clip, k.at), v: k.v, ease: k.ease })),
  );
  const bare: Slot = { clip, prop, value: s.fallback };
  const chosen = chooseBase(hold, bare, s.want);
  const seat = chosen ?? bare;
  return hold === 'onClip'
    ? { ...seat, value: { keys } }
    : { ...seat, value: { base: s.want, keys } };
}

/** 別のクリップ（コピー先）。**尺と頭を変えてある**ので、軸が消えれば打点の立つ所が動く。 */
export function otherClip(s: OffDefault): HoldClip {
  return {
    kind: s.kind as ClipKind,
    start: s.start + 3,
    duration: s.duration * 1.5,
    sourceIn: s.sourceIn + 2,
    speed: s.speed,
  };
}

/**
 * `Slot` を、採点の道具（`scenarios.ts` の `scoreAgainst()`）が読める形にする。
 *
 * 畳んだ形はそのまま渡せないので、**読んだ値 1 つの素の数**に落とす
 * （どの時刻でも同じ値を返すので、採点の意味は変わらない）。
 */
export function asLabClip(hold: HoldName, slot: Slot, fallback: number, id = 'slot'): LabClip {
  const keys = keysIn(slot.value);
  return {
    id,
    kind: slot.clip.kind,
    start: slot.clip.start,
    duration: slot.clip.duration,
    sourceIn: slot.clip.sourceIn,
    speed: slot.clip.speed,
    value: keys.length > 0 ? { keys } : readAt(hold, slot, slot.clip.start, fallback),
  };
}

/** 打点が**タイムラインのどこに立つか**（軸が消えたときのずれを秒で読むため）。 */
export function keyStandsAt(hold: HoldName, slot: Slot): number[] {
  const base = baseOf(hold, slot);
  return keysIn(slot.value).map((k) => timeAtKeyTime(base, slot.clip, k.t));
}

export const bytesOf = (o: unknown): number => new TextEncoder().encode(JSON.stringify(o)).length;
