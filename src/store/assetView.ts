/**
 * 素材一覧の並び順（キーと向き）。このブラウザに覚えておく。
 * エディタの素材パネルと素材管理ページで共通。
 */
import { useSyncExternalStore } from 'react';
import type { AssetSortKey, SortDirection } from '../model/assetView';

const KEY = 'vivid-edit.assetView.v1';
const KEYS: AssetSortKey[] = ['added', 'name', 'duration', 'size', 'kind'];

interface ViewState {
  sortKey: AssetSortKey;
  direction: SortDirection;
}

const DEFAULT: ViewState = { sortKey: 'added', direction: 'desc' };

function load(): ViewState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ViewState> | null;
    const sortKey = KEYS.includes(raw?.sortKey as AssetSortKey) ? (raw!.sortKey as AssetSortKey) : DEFAULT.sortKey;
    const direction = raw?.direction === 'asc' || raw?.direction === 'desc' ? raw.direction : DEFAULT.direction;
    return { sortKey, direction };
  } catch {
    return DEFAULT;
  }
}

let state = load();
const listeners = new Set<() => void>();

function commit(next: ViewState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 覚えられなくても、この画面の間は動く */
  }
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useAssetView(): ViewState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** 同じキーをもう一度選ぶと向きが逆になる。違うキーなら、そのキーの自然な向き（名前は昇順、他は新しい／大きい順）。 */
export function chooseSort(key: AssetSortKey) {
  if (key === state.sortKey) {
    commit({ ...state, direction: state.direction === 'asc' ? 'desc' : 'asc' });
  } else {
    commit({ sortKey: key, direction: key === 'name' || key === 'kind' ? 'asc' : 'desc' });
  }
}

export function toggleDirection() {
  commit({ ...state, direction: state.direction === 'asc' ? 'desc' : 'asc' });
}
