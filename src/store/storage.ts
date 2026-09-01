/**
 * 保存キーの引き継ぎ。
 *
 * アプリ名を変えたときにキーも変えたが、旧名で保存された内容を捨てないよう
 * 一度だけ移し替える。移し終わったら旧キーは消す。
 * 新しい方に既に何かあれば、そちらを優先して何もしない。
 */
export function migrateStorageKey(legacyKey: string, key: string): void {
  try {
    if (localStorage.getItem(key) !== null) return;
    const value = localStorage.getItem(legacyKey);
    if (value === null) return;
    localStorage.setItem(key, value);
    localStorage.removeItem(legacyKey);
  } catch {
    /* localStorage が使えない環境では何もしない */
  }
}
