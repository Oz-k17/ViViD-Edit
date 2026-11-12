/**
 * 完成品の置き場（model/outputs.ts）の保存と、画面への知らせ。
 * 書き出しの窓と、完成品のページの両方から使うので、状態は部品の外に 1 つだけ持つ。
 */
import { useSyncExternalStore } from 'react';
import { addOutput, removeOutput, sanitizeOutputs, updateOutput, type OutputItem } from '../model/outputs';
import { sanitizeBatch, type BatchRecord } from '../model/exportProgress';
import { scopedKey } from './profile';

const OUTPUTS_KEY = scopedKey('vivid.outputs');
const BATCH_KEY = scopedKey('vivid.exportBatch');

function read(): OutputItem[] {
  try {
    return sanitizeOutputs(JSON.parse(localStorage.getItem(OUTPUTS_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

let items: OutputItem[] = read();
const listeners = new Set<() => void>();

function commit(next: OutputItem[]) {
  items = next;
  try {
    localStorage.setItem(OUTPUTS_KEY, JSON.stringify(items));
  } catch {
    /* 容量が足りなければ、この回は覚えないだけ */
  }
  listeners.forEach((fn) => fn());
}

export const outputsStore = {
  all: () => items,
  add: (item: OutputItem) => commit(addOutput(items, item)),
  update: (id: string, patch: Parameters<typeof updateOutput>[2]) => commit(updateOutput(items, id, patch)),
  remove: (id: string) => commit(removeOutput(items, id)),
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useOutputs(): OutputItem[] {
  return useSyncExternalStore(outputsStore.subscribe, outputsStore.all, outputsStore.all);
}

/** まとめ書き出しの途中の記録（model/exportProgress.ts）。 */
export function loadBatchRecord(): BatchRecord | null {
  try {
    return sanitizeBatch(JSON.parse(localStorage.getItem(BATCH_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function saveBatchRecord(record: BatchRecord | null): void {
  try {
    if (record) localStorage.setItem(BATCH_KEY, JSON.stringify(record));
    else localStorage.removeItem(BATCH_KEY);
  } catch {
    /* 覚えられなければ、再開できないだけ */
  }
}
