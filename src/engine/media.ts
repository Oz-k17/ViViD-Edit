/**
 * 素材の置き場。
 * 実体（Blob / HTMLMediaElement）は JSON にできないので、プロジェクト側は mediaId だけを持ち、
 * ここが Blob・再生要素・サムネイル・フォルダ分けを面倒みる。
 * Blob は IndexedDB に保存するので、リロードやページ移動をしても素材は残る。
 */

export type MediaKind = 'video' | 'image' | 'audio';

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  url: string;
  /** 秒。画像は 0。 */
  duration: number;
  width: number;
  height: number;
  thumbnail: string;
  size: number;
  folder: string;
  createdAt: number;
}

export const UNSORTED = '未分類';
export const SFX_FOLDER = '効果音';

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

// ---------- IndexedDB ----------

const DB_NAME = 'tateyoko-studio';
const STORE = 'assets';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

interface StoredAsset extends Omit<MediaAsset, 'url'> {
  blob: Blob;
}

async function dbPut(record: StoredAsset): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function dbDelete(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function dbAll(): Promise<StoredAsset[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as StoredAsset[]);
    request.onerror = () => resolve([]);
  });
}

// ---------- 解析 ----------

function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(ext)) return 'audio';
  return null;
}

/** duration が Infinity になる webm/mov 対策。 */
function resolveDuration(el: HTMLMediaElement): Promise<number> {
  if (Number.isFinite(el.duration) && el.duration > 0) return Promise.resolve(el.duration);
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener('timeupdate', onUpdate);
      el.currentTime = 0;
      resolve(Number.isFinite(el.duration) ? el.duration : 0);
    };
    const onUpdate = () => {
      if (el.currentTime > 0) done();
    };
    el.addEventListener('timeupdate', onUpdate);
    el.currentTime = 1e6;
    setTimeout(done, 3000);
  });
}

function snapshot(source: HTMLVideoElement | HTMLImageElement, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 240 / Math.max(width, height, 1));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return '';
  }
}

function probeVideo(url: string): Promise<{ duration: number; width: number; height: number; thumb: string }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.muted = true;
    el.playsInline = true;
    el.src = url;
    el.addEventListener('error', () => reject(new Error('動画を読み込めませんでした')));
    el.addEventListener('loadedmetadata', async () => {
      const duration = await resolveDuration(el);
      const width = el.videoWidth || 1080;
      const height = el.videoHeight || 1920;
      const finish = () => {
        resolve({ duration, width, height, thumb: snapshot(el, width, height) });
        el.removeAttribute('src');
        el.load();
      };
      el.addEventListener('seeked', finish, { once: true });
      el.currentTime = Math.min(duration > 0 ? duration / 2 : 0, 1);
      setTimeout(() => {
        if (el.readyState >= 2) finish();
      }, 2500);
    });
  });
}

function probeImage(url: string): Promise<{ width: number; height: number; thumb: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight, thumb: snapshot(img, img.naturalWidth, img.naturalHeight) });
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

function probeAudio(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.src = url;
    el.addEventListener('error', () => reject(new Error('音声を読み込めませんでした')));
    el.addEventListener('loadedmetadata', async () => resolve(await resolveDuration(el)));
  });
}

// ---------- レジストリ ----------

class MediaRegistry {
  private assets = new Map<string, MediaAsset>();
  private listeners = new Set<() => void>();
  private elements = new Map<string, HTMLVideoElement | HTMLAudioElement>();
  private images = new Map<string, HTMLImageElement>();
  private cache: MediaAsset[] = [];
  private restored = false;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): MediaAsset[] => this.cache;

  private emit() {
    // 追加したばかりの素材が 1 ページ目に出るよう、新しい順に並べる。
    this.cache = [...this.assets.values()].sort((a, b) => b.createdAt - a.createdAt);
    this.listeners.forEach((fn) => fn());
  }

  get(id: string | null): MediaAsset | undefined {
    return id ? this.assets.get(id) : undefined;
  }

  all(): MediaAsset[] {
    return this.cache;
  }

  folders(): string[] {
    const names = new Set<string>([UNSORTED]);
    this.assets.forEach((a) => names.add(a.folder || UNSORTED));
    return [...names];
  }

  /** IndexedDB から復元する（起動時に 1 度だけ）。 */
  async restore(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    for (const record of await dbAll()) {
      const { blob, ...rest } = record;
      this.assets.set(rest.id, { ...rest, url: URL.createObjectURL(blob) });
    }
    this.emit();
  }

  async add(file: File, folder = UNSORTED): Promise<MediaAsset> {
    const kind = kindOf(file);
    if (!kind) throw new Error(`${file.name} は対応していない形式です`);
    const url = URL.createObjectURL(file);
    const base = { id: uid('m'), name: file.name, kind, size: file.size, folder, createdAt: Date.now() };

    let asset: MediaAsset;
    if (kind === 'video') {
      const meta = await probeVideo(url);
      asset = { ...base, url, duration: meta.duration, width: meta.width, height: meta.height, thumbnail: meta.thumb };
    } else if (kind === 'image') {
      const meta = await probeImage(url);
      asset = { ...base, url, duration: 0, width: meta.width, height: meta.height, thumbnail: meta.thumb };
    } else {
      asset = { ...base, url, duration: await probeAudio(url), width: 0, height: 0, thumbnail: '' };
    }

    this.assets.set(asset.id, asset);
    this.emit();
    const { url: _ignored, ...rest } = asset;
    void dbPut({ ...rest, blob: file });
    return asset;
  }

  update(id: string, patch: Partial<Pick<MediaAsset, 'name' | 'folder'>>) {
    const asset = this.assets.get(id);
    if (!asset) return;
    const next = { ...asset, ...patch };
    this.assets.set(id, next);
    this.emit();
    void (async () => {
      const stored = (await dbAll()).find((r) => r.id === id);
      if (stored) void dbPut({ ...stored, ...patch });
    })();
  }

  remove(id: string) {
    const asset = this.assets.get(id);
    if (!asset) return;
    URL.revokeObjectURL(asset.url);
    this.assets.delete(id);
    for (const [key, el] of [...this.elements]) {
      if (el.dataset.mediaId === id) this.releaseElement(key);
    }
    this.images.delete(id);
    this.emit();
    void dbDelete(id);
  }

  /** クリップ専用の再生要素（同じ素材を別のイン点で同時に使えるようキーで分ける）。 */
  mediaElement(key: string, mediaId: string | null): HTMLVideoElement | HTMLAudioElement | null {
    const asset = this.get(mediaId);
    if (!asset || asset.kind === 'image') return null;
    const existing = this.elements.get(key);
    if (existing && existing.dataset.mediaId === asset.id) return existing;
    if (existing) this.releaseElement(key);

    const el = asset.kind === 'video' ? document.createElement('video') : document.createElement('audio');
    el.dataset.mediaId = asset.id;
    el.preload = 'auto';
    el.src = asset.url;
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
    }
    el.load();
    this.elements.set(key, el);
    return el;
  }

  imageElement(mediaId: string | null): HTMLImageElement | null {
    const asset = this.get(mediaId);
    if (!asset || asset.kind !== 'image') return null;
    let el = this.images.get(asset.id);
    if (!el) {
      el = new Image();
      el.src = asset.url;
      this.images.set(asset.id, el);
    }
    return el;
  }

  releaseElement(key: string) {
    const el = this.elements.get(key);
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    el.load();
    this.elements.delete(key);
  }

  activeKeys(): string[] {
    return [...this.elements.keys()];
  }
}

export const mediaRegistry = new MediaRegistry();

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(seconds: number, withFrames = false, fps = 30): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const body = `${m}:${s.toString().padStart(2, '0')}`;
  if (!withFrames) return body;
  return `${body}.${Math.floor((safe % 1) * fps).toString().padStart(2, '0')}`;
}
