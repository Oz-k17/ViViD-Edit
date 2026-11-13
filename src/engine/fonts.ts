/**
 * 自分で足したフォント（テキストスタイルの画面から）。
 *
 * 2 通りで足せる:
 * - **フォントのファイル**（.ttf / .otf / .woff / .woff2）: この端末の中（IndexedDB）に取っておき、開くたびに読み込む。
 *   ネットが無くても使える。iPad のアプリでも同じ
 * - **Google Fonts の名前**（例: Dela Gothic One）: 名前だけを覚えておき、開くたびに Google Fonts から読む（ネットが要る）
 *
 * 足したフォントは `document.fonts` に登録するので、プレビューも書き出しも同じ字形で描ける
 * （書き出しは `document.fonts.ready` を待ってから描く）。
 * 日本語の無い英字フォントでも日本語が豆腐にならないよう、指定には Noto Sans JP を後ろに付ける。
 */

export interface CustomFont {
  id: string;
  /** CSS のフォント名（登録した名前）。 */
  family: string;
  /** 一覧に出す名前。 */
  label: string;
  source: 'file' | 'google';
  /** ファイルのとき、元のファイル名。 */
  fileName?: string;
  createdAt: number;
}

interface StoredFont extends CustomFont {
  blob?: Blob;
}

const DB_NAME = 'vivid-fonts';
const STORE = 'fonts';
/** 日本語の字が無いフォントでも、その字は Noto Sans JP で出す。 */
const FALLBACK = '"Noto Sans JP", system-ui, sans-serif';

export const FONT_FILE_ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';

/** テキストの `fontFamily` に入れる値。 */
export function fontCss(font: Pick<CustomFont, 'family'>): string {
  return `"${font.family.replace(/"/g, '')}", ${FALLBACK}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll(): Promise<StoredFont[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredFont[]);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(font: StoredFont): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(font);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Google Fonts の CSS の URL 候補。太さを持たないフォントでは、太さ付きの指定が丸ごと断られるので、順に試す。 */
function googleUrls(name: string): string[] {
  const family = encodeURIComponent(name.trim()).replace(/%20/g, '+');
  return [
    `https://fonts.googleapis.com/css2?family=${family}:wght@100..900&display=swap`,
    `https://fonts.googleapis.com/css2?family=${family}:wght@400;700;900&display=swap`,
    `https://fonts.googleapis.com/css2?family=${family}:wght@400;700&display=swap`,
    `https://fonts.googleapis.com/css2?family=${family}&display=swap`,
  ];
}

/** 名前（家族名）として使えるように整える。 */
function cleanFamily(raw: string): string {
  const base = raw.replace(/\.(ttf|otf|woff2?|ttc)$/i, '').replace(/["'\\;{}]/g, '').trim();
  return base || 'フォント';
}

class FontRegistry {
  private fonts: CustomFont[] = [];
  private listeners = new Set<() => void>();
  private restoring: Promise<void> | null = null;
  private loadedGoogle = new Set<string>();

  list(): CustomFont[] {
    return this.fonts;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    this.fonts = [...this.fonts];
    for (const fn of this.listeners) fn();
  }

  /** 取っておいたフォントを読み込んで登録する。何度呼んでも 1 度だけ。 */
  restore(): Promise<void> {
    if (!this.restoring) this.restoring = this.load();
    return this.restoring;
  }

  private async load() {
    if (typeof indexedDB === 'undefined' || typeof document === 'undefined') return;
    let stored: StoredFont[] = [];
    try {
      stored = await dbAll();
    } catch {
      return;
    }
    stored.sort((a, b) => a.createdAt - b.createdAt);
    for (const font of stored) {
      try {
        if (font.source === 'file' && font.blob) await this.registerFile(font.family, font.blob);
        if (font.source === 'google') await this.registerGoogle(font.family);
      } catch {
        // 読めなくなったフォント（ネットが無いときの Google Fonts など）も、一覧には残す（次に開いたときに読める）。
      }
      const { blob: _blob, ...meta } = font;
      this.fonts.push(meta);
    }
    this.emit();
  }

  private async registerFile(family: string, blob: Blob) {
    const face = new FontFace(family, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
  }

  private async registerGoogle(name: string) {
    if (this.loadedGoogle.has(name)) return;
    let css: string | null = null;
    for (const url of googleUrls(name)) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          css = await res.text();
          break;
        }
      } catch {
        /* 次の候補へ */
      }
    }
    if (!css || !/@font-face/.test(css)) throw new Error('Google Fonts にそのフォントが見つかりませんでした（名前を確かめてください）');
    const style = document.createElement('style');
    style.dataset.googleFont = name;
    style.textContent = css;
    document.head.appendChild(style);
    // 日本語の字形があるフォントなら日本語で、無ければ英字で読み込みを確かめる。
    await document.fonts.load(`700 40px "${name}"`, 'あAa');
    if (!document.fonts.check(`40px "${name}"`, 'Aa')) throw new Error('フォントを読み込めませんでした');
    this.loadedGoogle.add(name);
  }

  private uniqueFamily(base: string): string {
    const taken = new Set(this.fonts.map((f) => f.family));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  /** フォントのファイルを足す。読めないファイルなら投げる（何も足さない）。 */
  async addFile(file: File): Promise<CustomFont> {
    await this.restore();
    const family = this.uniqueFamily(cleanFamily(file.name));
    try {
      await this.registerFile(family, file);
    } catch {
      throw new Error(`「${file.name}」はフォントとして読めませんでした（.ttf・.otf・.woff・.woff2 が使えます）`);
    }
    const font: CustomFont = { id: `font_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, family, label: family, source: 'file', fileName: file.name, createdAt: Date.now() };
    await dbPut({ ...font, blob: file });
    this.fonts.push(font);
    this.emit();
    return font;
  }

  /** Google Fonts のフォントを、名前で足す。見つからなければ投げる。 */
  async addGoogle(rawName: string): Promise<CustomFont> {
    await this.restore();
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('フォントの名前を入れてください');
    const existing = this.fonts.find((f) => f.source === 'google' && f.family.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    await this.registerGoogle(name);
    const font: CustomFont = { id: `font_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, family: name, label: name, source: 'google', createdAt: Date.now() };
    await dbPut(font);
    this.fonts.push(font);
    this.emit();
    return font;
  }

  async remove(id: string): Promise<void> {
    await dbDelete(id);
    this.fonts = this.fonts.filter((f) => f.id !== id);
    this.emit();
  }
}

export const fontRegistry = new FontRegistry();
