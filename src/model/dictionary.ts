/**
 * わたし辞書 — 字幕の直しを覚えて、次から自動で直す。
 *
 * 文字起こしは、人の名前・ゲームの用語・いつもの言い回しを、毎回同じように間違える。
 * 1 度手で直したら、その直し（「前の言葉 → 後の言葉」）を覚えておき、次に字幕を起こしたときに当てる。
 *
 * 覚え方: 字幕を書き換え終えたとき（入力欄から離れたとき）、前と後を比べ、変わった所だけを取り出す。
 * - 1 文字だけの直し（「会う」→「合う」）は、その字だけを覚えると関係ない所まで変わるので、前後 1 文字ずつ広げて覚える
 * - 足しただけ（句読点を打った等）は覚えない。消しただけは、2 文字以上のとき（「えーと」等の口癖）だけ覚える
 * - 書き換えが大きすぎる（行の大半を書き直した）ときは、言い直しなので覚えない
 */

import type { Sequence } from './types';

export interface DictEntry {
  from: string;
  to: string;
  /** 当てた回数（覚えたときは 0）。 */
  hits: number;
  createdAt: number;
}

/** これより長い変わり目は、言い直しとみなして覚えない。 */
const MAX_SPAN = 12;

const SPACE = /^\s*$/;

/**
 * 書き換えの前と後から、覚える直しを 1 つ取り出す。覚えるものが無ければ null。
 */
export function learnCorrection(before: string, after: string): { from: string; to: string } | null {
  if (before === after || !before.trim() || !after.trim()) return null;
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  let from = before.slice(head, before.length - tail);
  let to = after.slice(head, after.length - tail);
  // 改行や空白だけの直し（行の分け方を変えた）は、言葉の直しではない。
  if (SPACE.test(from) && SPACE.test(to)) return null;
  // 足しただけ（句読点・言葉を足した）は覚えない。どこに足すかは毎回違う。
  if (from.length === 0) return null;
  // 消しただけは、口癖（2 文字以上）だけ覚える。1 文字を消して回ると、関係ない所が崩れる。
  if (to.length === 0 && from.trim().length < 2) return null;
  if (from.length > MAX_SPAN || to.length > MAX_SPAN) return null;
  // 行の大半を書き直したなら、言い直し。
  if (from.length > before.length * 0.6 && before.length > 4) return null;
  // 1 文字の直しは、前後を 1 文字ずつ含めて覚える（その字だけだと、関係ない言葉まで変わる）。
  let start = head;
  let endBefore = before.length - tail;
  let endAfter = after.length - tail;
  if (from.length < 2) {
    if (start > 0 && !/\s/.test(before[start - 1])) start -= 1;
    if (endBefore < before.length && !/\s/.test(before[endBefore])) {
      endBefore += 1;
      endAfter += 1;
    }
    from = before.slice(start, endBefore);
    to = after.slice(start, endAfter);
    if (from.length < 2) return null;
  }
  return { from, to };
}

/** 辞書に足す。同じ「前の言葉」があれば、新しい直しで置き換える。 */
export function addEntry(entries: DictEntry[], from: string, to: string, now = Date.now()): DictEntry[] {
  const rest = entries.filter((e) => e.from !== from);
  // 前の直しを打ち消す直し（A→B のあと B→A）なら、辞書から外すだけにする。
  if (entries.some((e) => e.from === to && e.to === from)) return entries.filter((e) => !(e.from === to && e.to === from));
  return [...rest, { from, to, hits: 0, createdAt: now }];
}

/**
 * 文に辞書を当てる。長い言葉から先に当て、1 度直した所は 2 度直さない（A→B と B→C が並んでも、A は B で止まる）。
 * `counts` は、どの言葉を何回直したか（辞書の「当てた回数」を増やすため）。
 */
export function applyDictionary(text: string, entries: DictEntry[]): { text: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const usable = entries.filter((e) => e.from.length > 0).sort((a, b) => b.from.length - a.from.length);
  if (usable.length === 0 || !text) return { text, counts };
  let out = '';
  let i = 0;
  while (i < text.length) {
    const hit = usable.find((e) => text.startsWith(e.from, i));
    if (hit) {
      out += hit.to;
      i += hit.from.length;
      counts.set(hit.from, (counts.get(hit.from) ?? 0) + 1);
    } else {
      out += text[i];
      i += 1;
    }
  }
  return { text: out, counts };
}

/** 当てた回数を辞書へ足し戻す。 */
export function countHits(entries: DictEntry[], counts: Map<string, number>): DictEntry[] {
  if (counts.size === 0) return entries;
  return entries.map((e) => (counts.has(e.from) ? { ...e, hits: e.hits + (counts.get(e.from) ?? 0) } : e));
}

/** 合わせる（複数の文に当てたときの、回数の合計）。 */
export function mergeCounts(into: Map<string, number>, from: Map<string, number>) {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
}

/** タイムラインの字幕（種類＝字幕のテロップ）に辞書を当てる。見出しや飾りには当てない。 */
export function applyToCaptions(
  sequence: Sequence,
  entries: DictEntry[],
): { sequence: Sequence; changed: number; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  let changed = 0;
  const clips = sequence.clips.map((clip) => {
    if (clip.kind !== 'text' || !clip.text || (clip.text.role ?? 'caption') !== 'caption') return clip;
    const result = applyDictionary(clip.text.content, entries);
    if (result.text === clip.text.content) return clip;
    changed += 1;
    mergeCounts(counts, result.counts);
    return { ...clip, text: { ...clip.text, content: result.text } };
  });
  return { sequence: changed ? { ...sequence, clips } : sequence, changed, counts };
}
