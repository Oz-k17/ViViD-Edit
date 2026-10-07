/**
 * 素材ビンの保存と操作。
 *
 * 素材が入っているビンは素材の `folder` から分かるので、ここで持つのは
 * **空のビン**（作っただけで素材がまだ無いもの）と、**ツリーの開き具合**だけ。
 * どちらもこのブラウザの localStorage に置く（無くても動く。消えても素材は失われない）。
 *
 * ビンの名前変更・移動は、そのビンより下にある素材の `folder` をまとめて付け替える。
 * **ビンを消しても素材は消さない**（ひとつ上のビンへ上げる）。
 */
import { useSyncExternalStore } from 'react';
import { EMOJI_FOLDER, mediaRegistry, SFX_FOLDER, UNSORTED } from '../engine/media';
import {
  allBinPaths,
  ancestorsOf,
  binNameProblem,
  checkMoveBin,
  isWithin,
  joinPath,
  parentOf,
  rebase,
  renamedPath,
  siblingExists,
} from '../model/bins';

const KEY = 'vivid-edit.bins.v1';

/** アプリが場所を決め打ちで使うビン。名前変更・移動・削除はさせない（中に作るのは自由）。 */
export const PROTECTED_BINS: readonly string[] = [UNSORTED, SFX_FOLDER, EMOJI_FOLDER];
/** 最上位でいつも先頭に出す順。 */
export const PINNED_BINS: readonly string[] = [UNSORTED, SFX_FOLDER, EMOJI_FOLDER];

export const isProtected = (path: string) => PROTECTED_BINS.includes(path);

interface BinState {
  extra: string[];
  expanded: string[];
}

function load(): BinState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<BinState> | null;
    return {
      extra: Array.isArray(raw?.extra) ? raw.extra.filter((v): v is string => typeof v === 'string') : [],
      expanded: Array.isArray(raw?.expanded) ? raw.expanded.filter((v): v is string => typeof v === 'string') : [],
    };
  } catch {
    return { extra: [], expanded: [] };
  }
}

let state: BinState = load();
const listeners = new Set<() => void>();

function commit(next: BinState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 保存できない環境でも、この画面の間は動く */
  }
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => state;

export function useBinState(): BinState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 素材と空のビンを合わせた、いま存在するビンのパス全部。 */
export function existingBins(): string[] {
  return allBinPaths(mediaRegistry.all().map((a) => a.folder || UNSORTED), state.extra);
}

export function toggleExpanded(path: string) {
  const set = new Set(state.expanded);
  if (set.has(path)) set.delete(path);
  else set.add(path);
  commit({ ...state, expanded: [...set] });
}

/** 指定したビンが見えるよう、祖先をすべて開く。 */
export function revealBin(path: string) {
  const set = new Set(state.expanded);
  let changed = false;
  for (const a of ancestorsOf(path)) if (!set.has(a)) (set.add(a), (changed = true));
  if (changed) commit({ ...state, expanded: [...set] });
}

export function setAllExpanded(paths: string[]) {
  commit({ ...state, expanded: paths });
}

export type BinResult = { ok: true; path: string } | { ok: false; reason: string };

export function createBin(parent: string, name: string): BinResult {
  const problem = binNameProblem(name);
  if (problem) return { ok: false, reason: problem };
  if (siblingExists(existingBins(), parent, name.trim())) return { ok: false, reason: `「${name.trim()}」は既にあります` };
  const path = joinPath(parent, name.trim());
  commit({ ...state, extra: [...state.extra, path], expanded: [...new Set([...state.expanded, ...(parent ? [parent] : [])])] });
  return { ok: true, path };
}

/** `from` 以下の素材と空のビンを、`to` 以下へ付け替える。 */
function relocate(from: string, to: string) {
  const changes: Array<[string, string]> = [];
  for (const asset of mediaRegistry.all()) {
    const folder = asset.folder || UNSORTED;
    if (isWithin(folder, from)) changes.push([asset.id, rebase(folder, from, to)]);
  }
  mediaRegistry.moveToFolders(changes);
  commit({
    ...state,
    extra: state.extra.map((p) => rebase(p, from, to)),
    expanded: state.expanded.map((p) => rebase(p, from, to)),
  });
}

export function renameBin(path: string, newName: string): BinResult {
  if (isProtected(path)) return { ok: false, reason: 'このビンは名前を変えられません' };
  const problem = binNameProblem(newName);
  if (problem) return { ok: false, reason: problem };
  const to = renamedPath(path, newName, existingBins());
  if (to === null) return { ok: false, reason: `「${newName.trim()}」は同じ場所に既にあります` };
  if (to === path) return { ok: true, path };
  relocate(path, to);
  return { ok: true, path: to };
}

export function moveBin(path: string, newParent: string): BinResult {
  if (isProtected(path)) return { ok: false, reason: 'このビンは動かせません' };
  const check = checkMoveBin(path, newParent, existingBins());
  if (!check.ok || !check.to) return { ok: false, reason: check.reason ?? '動かせません' };
  relocate(path, check.to);
  revealBin(check.to);
  return { ok: true, path: check.to };
}

/** ビンを消す。中の素材は消さず、ひとつ上のビン（最上位なら未分類）へ上げる。 */
export function deleteBin(path: string): BinResult {
  if (isProtected(path)) return { ok: false, reason: 'このビンは消せません' };
  const parent = parentOf(path);
  const changes: Array<[string, string]> = [];
  for (const asset of mediaRegistry.all()) {
    const folder = asset.folder || UNSORTED;
    if (isWithin(folder, path)) changes.push([asset.id, rebase(folder, path, parent) || UNSORTED]);
  }
  mediaRegistry.moveToFolders(changes);
  commit({
    ...state,
    extra: state.extra.filter((p) => !isWithin(p, path)),
    expanded: state.expanded.filter((p) => !isWithin(p, path)),
  });
  return { ok: true, path: parent };
}

export function moveAssetsToBin(assetIds: string[], path: string) {
  mediaRegistry.moveToFolders(assetIds.map((id) => [id, path || UNSORTED]));
}
