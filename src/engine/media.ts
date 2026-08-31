/**
 * 読み込んだ素材（動画 / 画像 / 音声）の置き場。
 * File と HTMLMediaElement は JSON にできないので、プロジェクト状態からは id だけを参照し
 * 実体はこのレジストリが持つ。
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
  /** タイムライン / ライブラリ用のサムネイル（dataURL）。音声は空文字。 */
  thumbnail: string;
  size: number;
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  // 拡張子で救済（type が空のことがある）
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

function loadVideoMeta(url: string): Promise<{ duration: number; width: number; height: number; thumb: string }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.muted = true;
    el.playsInline = true;
    el.src = url;
    const fail = () => reject(new Error('動画を読み込めませんでした'));
    el.addEventListener('error', fail);
    el.addEventListener('loadedmetadata', async () => {
      const duration = await resolveDuration(el);
      const width = el.videoWidth || 1080;
      const height = el.videoHeight || 1920;
      const seekTo = Math.min(duration > 0 ? duration / 2 : 0, 1);
      const grab = () => {
        resolve({ duration, width, height, thumb: snapshot(el, width, height) });
        el.removeAttribute('src');
        el.load();
      };
      el.addEventListener('seeked', grab, { once: true });
      el.currentTime = seekTo;
      setTimeout(() => {
        // seeked が来ないブラウザ / コーデックでも先に進む
        if (el.readyState >= 2) grab();
      }, 2500);
    });
  });
}

function snapshot(source: HTMLVideoElement | HTMLImageElement, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 240 / Math.max(width, height));
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

function loadImageMeta(url: string): Promise<{ width: number; height: number; thumb: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight, thumb: snapshot(img, img.naturalWidth, img.naturalHeight) });
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

function loadAudioMeta(url: string): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.src = url;
    el.addEventListener('error', () => reject(new Error('音声を読み込めませんでした')));
    el.addEventListener('loadedmetadata', async () => {
      resolve({ duration: await resolveDuration(el) });
    });
  });
}

class MediaRegistry {
  private assets = new Map<string, MediaAsset>();
  private listeners = new Set<() => void>();
  /** クリップごとの専用 <video>。同じ素材を別々のイン点で使えるようにキー分けする。 */
  private elements = new Map<string, HTMLVideoElement | HTMLAudioElement>();
  private images = new Map<string, HTMLImageElement>();
  private snapshotCache: MediaAsset[] = [];

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): MediaAsset[] => this.snapshotCache;

  private emit() {
    this.snapshotCache = [...this.assets.values()];
    this.listeners.forEach((fn) => fn());
  }

  get(id: string): MediaAsset | undefined {
    return this.assets.get(id);
  }

  async add(file: File): Promise<MediaAsset> {
    const kind = kindOf(file);
    if (!kind) throw new Error(`${file.name} は対応していない形式です`);
    const url = URL.createObjectURL(file);
    const base = { id: uid('m'), name: file.name, kind, url, size: file.size };

    let asset: MediaAsset;
    if (kind === 'video') {
      const meta = await loadVideoMeta(url);
      asset = { ...base, duration: meta.duration, width: meta.width, height: meta.height, thumbnail: meta.thumb };
    } else if (kind === 'image') {
      const meta = await loadImageMeta(url);
      asset = { ...base, duration: 0, width: meta.width, height: meta.height, thumbnail: meta.thumb };
    } else {
      const meta = await loadAudioMeta(url);
      asset = { ...base, duration: meta.duration, width: 0, height: 0, thumbnail: '' };
    }

    this.assets.set(asset.id, asset);
    this.emit();
    return asset;
  }

  remove(id: string) {
    const asset = this.assets.get(id);
    if (!asset) return;
    URL.revokeObjectURL(asset.url);
    this.assets.delete(id);
    for (const [key, el] of this.elements) {
      if (el.dataset.mediaId === id) {
        el.pause();
        el.removeAttribute('src');
        this.elements.delete(key);
      }
    }
    this.images.delete(id);
    this.emit();
  }

  /** クリップ専用の再生要素を取得（無ければ生成）。 */
  mediaElement(key: string, mediaId: string): HTMLVideoElement | HTMLAudioElement | null {
    const asset = this.assets.get(mediaId);
    if (!asset || asset.kind === 'image') return null;
    const existing = this.elements.get(key);
    if (existing && existing.dataset.mediaId === mediaId) return existing;
    if (existing) this.releaseElement(key);

    const el = asset.kind === 'video' ? document.createElement('video') : document.createElement('audio');
    el.dataset.mediaId = mediaId;
    el.preload = 'auto';
    el.src = asset.url;
    el.crossOrigin = 'anonymous';
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
    }
    el.load();
    this.elements.set(key, el);
    return el;
  }

  imageElement(mediaId: string): HTMLImageElement | null {
    const asset = this.assets.get(mediaId);
    if (!asset || asset.kind !== 'image') return null;
    let el = this.images.get(mediaId);
    if (!el) {
      el = new Image();
      el.src = asset.url;
      this.images.set(mediaId, el);
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
  const f = Math.floor((safe % 1) * fps);
  return `${body}.${f.toString().padStart(2, '0')}`;
}
