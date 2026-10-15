/**
 * 素材の色タグとメモ。DOM を使わない純粋関数。
 *
 * 色は 7 色の固定。「あとで使う」「採用」「ボツ」のように、使う人が意味を決める。
 * メモは自由な文章（名前やビンでは言い表せないこと: どこが良いか、どこで切るか等）。
 */

export const LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const LABEL_NAMES: Record<LabelColor, string> = {
  red: '赤',
  orange: '橙',
  yellow: '黄',
  green: '緑',
  blue: '青',
  purple: '紫',
  gray: '灰',
};

/** 画面に出す色（暗い背景でも見分けがつく程度）。 */
export const LABEL_HEX: Record<LabelColor, string> = {
  red: '#ef5350',
  orange: '#ff9800',
  yellow: '#fdd835',
  green: '#66bb6a',
  blue: '#42a5f5',
  purple: '#ab7df0',
  gray: '#9e9e9e',
};

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === 'string' && (LABEL_COLORS as readonly string[]).includes(value);
}

/** 色での絞り込み。`null` は絞り込まない、`'none'` は色の付いていない素材だけ。 */
export type LabelFilter = LabelColor | 'none' | null;

interface Labeled {
  color?: LabelColor;
  note?: string;
}

export function matchesLabel(asset: Labeled, filter: LabelFilter): boolean {
  if (filter === null) return true;
  if (filter === 'none') return !asset.color;
  return asset.color === filter;
}

/** メモの長さの上限（保存・表示が重くならないように）。 */
export const NOTE_MAX = 500;

/** 保存する形に整える。空白だけなら「メモなし」（undefined）。 */
export function normalizeNote(raw: string): string | undefined {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (text === '') return undefined;
  return text.length > NOTE_MAX ? text.slice(0, NOTE_MAX) : text;
}

/**
 * 検索語に合うか。名前・ビンに加えて、**メモの中身**も探す。
 * 空白区切りは AND（全部の語がどこかに含まれること）。
 * 色の名前（「赤」）でも見つかる。
 */
export function matchesAssetQuery(asset: Labeled & { name: string; folder: string }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${asset.name} ${asset.folder} ${asset.note ?? ''} ${asset.color ? LABEL_NAMES[asset.color] : ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 色ごとの件数（絞り込みの見出しに出す）。 */
export function labelCounts(assets: Labeled[]): Record<LabelColor | 'none', number> {
  const counts = { red: 0, orange: 0, yellow: 0, green: 0, blue: 0, purple: 0, gray: 0, none: 0 };
  for (const a of assets) counts[a.color ?? 'none'] += 1;
  return counts;
}

/** 保存データから読み戻すときの検査（壊れた値は捨てる）。 */
export function sanitizeLabels(raw: { color?: unknown; note?: unknown }): Labeled {
  const out: Labeled = {};
  if (isLabelColor(raw.color)) out.color = raw.color;
  if (typeof raw.note === 'string') {
    const note = normalizeNote(raw.note);
    if (note) out.note = note;
  }
  return out;
}
