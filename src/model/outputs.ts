/**
 * 完成品の置き場 — 書き出した作品の一覧と、確認の状態。
 *
 * 書き出したあと「どれを確かめたか・どれを投稿したか」を頭で覚えておく必要があった。
 * 書き出すたびに 1 行ずつ足し、「確認待ち → 確認済み → 投稿済み」を自分で進められるようにする。
 * 投稿そのものはしない（本人が確かめて、自分で投稿する）。
 *
 * 覚えるのは名前や長さなどの情報だけ。動画のファイルそのものは、保存した先（ダウンロード・カメラロール）にある。
 *
 * ここは計算だけ（保存の読み書きは store/outputs.ts）。
 */

export type OutputStatus = 'check' | 'ok' | 'posted';

export const OUTPUT_STATUSES: { key: OutputStatus; label: string; hint: string }[] = [
  { key: 'check', label: '確認待ち', hint: '書き出したまま。まだ見ていない' },
  { key: 'ok', label: '確認済み', hint: '見て、問題なし。投稿できる' },
  { key: 'posted', label: '投稿済み', hint: '投稿した' },
];

export interface OutputItem {
  id: string;
  /** 作品名。 */
  project: string;
  /** 保存したファイルの名前。 */
  filename: string;
  /** どの版か（字幕あり・字幕なし など）。 */
  variant: string;
  /** 画角（9:16 など）と、縦の画素数。 */
  aspect: string;
  quality: number;
  /** 長さ（秒）と、ファイルの大きさ（バイト）。 */
  duration: number;
  bytes: number;
  /** 書き出した時刻（ミリ秒）。 */
  at: number;
  status: OutputStatus;
  /** 自分用のメモ（どこに投稿したか・直したい所など）。 */
  memo: string;
  /** 投稿メモ（タイトル・タグ・字幕の全文）。まとめ書き出しで作ったときだけ。 */
  postNote?: string;
}

/** 覚えておく数。古いものから捨てる。 */
export const OUTPUT_LIMIT = 200;

/** 足す。新しいものが先頭。 */
export function addOutput(items: OutputItem[], item: OutputItem): OutputItem[] {
  return [item, ...items.filter((i) => i.id !== item.id)].slice(0, OUTPUT_LIMIT);
}

export function updateOutput(items: OutputItem[], id: string, patch: Partial<Pick<OutputItem, 'status' | 'memo' | 'postNote'>>): OutputItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch, memo: (patch.memo ?? i.memo).slice(0, 500) } : i));
}

export function removeOutput(items: OutputItem[], id: string): OutputItem[] {
  return items.filter((i) => i.id !== id);
}

/** 状態ごとの件数。 */
export function outputCounts(items: OutputItem[]): Record<OutputStatus, number> {
  const counts: Record<OutputStatus, number> = { check: 0, ok: 0, posted: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** 次の状態（確認待ち → 確認済み → 投稿済み）。投稿済みの次は無い。 */
export function nextStatus(status: OutputStatus): OutputStatus | null {
  return status === 'check' ? 'ok' : status === 'ok' ? 'posted' : null;
}

/**
 * 同じ回に書き出したものをまとめる（字幕あり・なしを並べて見せるため）。
 * 同じ作品名で、書き出した時刻が 30 分以内のものを 1 組にする。新しい組が先。
 */
export function groupOutputs(items: OutputItem[]): OutputItem[][] {
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const groups: OutputItem[][] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    if (last && last[0].project === item.project && last[last.length - 1].at - item.at <= 30 * 60 * 1000) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** 保存してあったものを読み戻すときの検査（壊れた行は捨てる）。 */
export function sanitizeOutputs(raw: unknown): OutputItem[] {
  if (!Array.isArray(raw)) return [];
  const out: OutputItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Partial<OutputItem>;
    if (typeof o.id !== 'string' || typeof o.filename !== 'string') continue;
    out.push({
      id: o.id,
      project: typeof o.project === 'string' ? o.project : '',
      filename: o.filename,
      variant: typeof o.variant === 'string' ? o.variant : '',
      aspect: typeof o.aspect === 'string' ? o.aspect : '',
      quality: typeof o.quality === 'number' ? o.quality : 0,
      duration: typeof o.duration === 'number' ? o.duration : 0,
      bytes: typeof o.bytes === 'number' ? o.bytes : 0,
      at: typeof o.at === 'number' ? o.at : 0,
      status: o.status === 'ok' || o.status === 'posted' ? o.status : 'check',
      memo: typeof o.memo === 'string' ? o.memo.slice(0, 500) : '',
      postNote: typeof o.postNote === 'string' ? o.postNote : undefined,
    });
  }
  return out.slice(0, OUTPUT_LIMIT);
}
