/**
 * 編集内容の控え（自動保存）。
 *
 * ふだんは localStorage に控える（同期で読めるので、開いた瞬間に元の編集へ戻れる）。
 * ただし localStorage は 1 つのサイトで 5MB ほどしか使えず、iPad の WKWebView でも同じくらい。
 * 長い作品（字幕が数百枚・まとめたクリップがいくつも）だと超えることがあり、
 * 以前はそのとき黙って諦めていた（閉じると編集が消える）。
 *
 * いまは、入りきらなかったら次の順に手を打つ:
 * 1. 消してよい控え（素材の読み込みの記録）を消して、もう 1 度入れる
 * 2. IndexedDB（ずっと大きく使える）の予備の置き場へ入れ、localStorage には「予備にある」という印だけ残す
 *    （古い控えは消す。開いたときに古いほうへ戻ってしまわないように）
 * 3. それも駄目なら、画面の上で知らせる（ファイルに保存できるボタン付き）
 *
 * 控えが小さくなって localStorage へまた入るようになったら、予備と印は消す。
 */

export type SaveState = 'ok' | 'spare' | 'failed';

const DB_NAME = 'vivid-project-spare';
const STORE = 'projects';
/** 予備の置き場にあるという印（控えのキーの後ろに付ける）。 */
export const SPARE_MARK = '.spare';
/** 入りきらないときに消してよい控え（作り直せる・なくても困らないもの）。 */
const DISPOSABLE_KEYS = ['vivid-edit.media-log'];

let state: SaveState = 'ok';
const listeners = new Set<() => void>();

export function saveState(): SaveState {
  return state;
}

export function subscribeSaveState(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(next: SaveState) {
  if (next === state) return;
  state = next;
  for (const fn of listeners) fn();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function hasMark(key: string): boolean {
  try {
    return localStorage.getItem(key + SPARE_MARK) !== null;
  } catch {
    return false;
  }
}

function tryLocal(key: string, text: string): boolean {
  try {
    localStorage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

async function write(key: string, text: string): Promise<SaveState> {
  let saved = tryLocal(key, text);
  if (!saved) {
    for (const k of DISPOSABLE_KEYS) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* そのまま */
      }
    }
    saved = tryLocal(key, text);
  }
  if (saved) {
    if (hasMark(key)) {
      try {
        localStorage.removeItem(key + SPARE_MARK);
        await idb('readwrite', (s) => s.delete(key));
      } catch {
        /* 予備が残っても、印が無ければ読まない */
      }
    }
    return 'ok';
  }
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
    await idb('readwrite', (s) => s.put({ text, at: Date.now() }, key));
    // 古い控えは消す（開いたとき、予備より古いほうへ戻らないように）。印は小さいので、消したあとなら必ず入る。
    try {
      localStorage.removeItem(key);
      localStorage.setItem(key + SPARE_MARK, String(Date.now()));
    } catch {
      /* 印が書けなければ、次に開いたときは localStorage の側（無ければ新しい作品）になる */
    }
    return 'spare';
  } catch {
    return 'failed';
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** 控える。続けて呼ばれても、呼んだ順に 1 つずつ書く（古いものが後から上書きしないように）。 */
export function saveProjectText(key: string, text: string): Promise<SaveState> {
  const run = queue.then(() => write(key, text));
  queue = run.catch(() => undefined);
  return run.then((result) => {
    setState(result);
    return result;
  });
}

/** 予備の置き場に控えがあるか（あれば、開いたあとにそちらを読む）。 */
export function hasSpareProject(key: string): boolean {
  return hasMark(key);
}

/** 予備の置き場の控えを読む。無ければ null。 */
export async function loadSpareProject(key: string): Promise<string | null> {
  if (!hasMark(key)) return null;
  try {
    const row = await idb<{ text: string }>('readonly', (s) => s.get(key));
    if (row?.text) setState('spare');
    return row?.text ?? null;
  } catch {
    return null;
  }
}
