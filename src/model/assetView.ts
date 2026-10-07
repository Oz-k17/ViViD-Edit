/**
 * 素材一覧の見せ方: 並び替えと、複数選択のクリックの解釈。DOM を使わない純粋関数。
 */

export type AssetSortKey = 'added' | 'name' | 'duration' | 'size' | 'kind';
export type SortDirection = 'asc' | 'desc';

export const ASSET_SORT_LABELS: Record<AssetSortKey, string> = {
  added: '追加順',
  name: '名前',
  duration: '長さ',
  size: 'サイズ',
  kind: '種類',
};

interface Sortable {
  id: string;
  name: string;
  kind: string;
  duration: number;
  size: number;
  createdAt: number;
}

const KIND_ORDER: Record<string, number> = { video: 0, image: 1, audio: 2 };

/**
 * 並び替えた新しい配列を返す。同じ値のものは名前順 → 追加順で安定させる。
 * 名前は「clip2 < clip10」になる自然順（数字を数として比べる）。
 * `added` の既定は新しい順（`desc`）— 追加したばかりの素材が先頭に来る。
 */
export function sortAssets<T extends Sortable>(assets: T[], key: AssetSortKey, direction: SortDirection): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' });
  const primary = (a: T, b: T): number => {
    switch (key) {
      case 'name':
        return byName(a, b);
      case 'duration':
        return a.duration - b.duration;
      case 'size':
        return a.size - b.size;
      case 'kind':
        return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
      default:
        return a.createdAt - b.createdAt;
    }
  };
  return [...assets].sort((a, b) => {
    const p = primary(a, b);
    if (p !== 0) return p * sign;
    const n = byName(a, b);
    if (n !== 0) return n;
    return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  });
}

export interface PickState {
  selected: string[];
  /** 範囲選択の起点（最後に普通に選んだもの）。 */
  anchor: string | null;
}

export interface PickModifiers {
  /** Ctrl / ⌘: 1 つずつ足し引き。 */
  toggle?: boolean;
  /** Shift: 起点から押した所までの範囲。 */
  range?: boolean;
}

/**
 * 素材をクリックしたときの選択の変わり方。
 *
 * - 修飾なし: それだけを選ぶ
 * - Ctrl/⌘: その 1 つを足す / 外す（起点も移る）
 * - Shift: 起点からの範囲に置き換える（Ctrl も押していれば、いまの選択に範囲を足す）。起点は動かさない
 *
 * `ordered` は**いま見えている順**の id（並び替え・絞り込みのあと）。範囲はこの順で数える。
 */
export function pick(state: PickState, ordered: string[], id: string, mods: PickModifiers = {}): PickState {
  if (mods.range && state.anchor && ordered.includes(state.anchor)) {
    const a = ordered.indexOf(state.anchor);
    const b = ordered.indexOf(id);
    if (b === -1) return state;
    const span = ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
    const selected = mods.toggle ? [...new Set([...state.selected, ...span])] : span;
    return { selected, anchor: state.anchor };
  }
  if (mods.toggle) {
    const has = state.selected.includes(id);
    return { selected: has ? state.selected.filter((x) => x !== id) : [...state.selected, id], anchor: id };
  }
  return { selected: [id], anchor: id };
}

/** 一覧から消えた id を選択から外す（絞り込み・削除のあと）。変わらなければ同じ参照を返す。 */
export function prune(state: PickState, existing: Iterable<string>): PickState {
  const alive = new Set(existing);
  const selected = state.selected.filter((id) => alive.has(id));
  const anchor = state.anchor && alive.has(state.anchor) ? state.anchor : null;
  return selected.length === state.selected.length && anchor === state.anchor ? state : { selected, anchor };
}
