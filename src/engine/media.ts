/**
 * 素材の置き場。
 * 実体（Blob / HTMLMediaElement）は JSON にできないので、プロジェクト側は mediaId だけを持ち、
 * ここが Blob・再生要素・サムネイル・フォルダ分けを面倒みる。
 * Blob は IndexedDB に保存するので、リロードやページ移動をしても素材は残る。
 *
 * 素材の実体の持ち方は 2 通りある。
 *
 *  - **取り込み** … ファイルを選んで入れたもの。Blob ごと IndexedDB に入る。
 *    その端末のそのブラウザの中にしか無いので、人に渡せない。
 *  - **参照**（`src` あり）… NAS などに置いてある物を URL で指しているだけ。
 *    実体は持たないので容量を食わず、同じ URL が見える人なら誰でも同じ素材を開ける。
 *
 * どちらも外向きは `url` に揃うので、再生・サムネイル・書き出しの側は区別しなくてよい。
 */

import { BlobSource, Input, UrlSource } from 'mediabunny';
import { VIDEO_INPUT_FORMATS } from './formats';
import { scopedDbName } from '../store/profile';

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
  /** 素材そのもののフレームレート。読み取れなかったら undefined。 */
  fps?: number;
  thumbnail: string;
  size: number;
  folder: string;
  createdAt: number;
  /** 解析しきれなかった素材に付く注意書き（登録自体はする）。 */
  warning?: string;
  /**
   * 参照している素材の在り処。取り込んだ素材では undefined。
   * **ページからの相対パスのまま持つ**（`media/a.mp4` など）。
   * 絶対 URL で持つと、NAS のホスト名や口を変えた瞬間に全プロジェクトが壊れる。
   */
  src?: string;
}

export const UNSORTED = '未分類';
export const SFX_FOLDER = '効果音';
/** テロップに絵文字として挿入できる画像を置いておくフォルダ。 */
export const EMOJI_FOLDER = '絵文字';

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

// ---------- IndexedDB ----------

const DB_NAME = scopedDbName('vivid-edit');
/** アプリ名を変える前に使っていた DB。中身があれば引き継いでから捨てる。 */
const LEGACY_DB_NAME = 'tateyoko-studio';
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
  /** 取り込んだ実体。参照（src あり）の素材では持たない。 */
  blob?: Blob;
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

/**
 * 旧名の DB に残っている素材を読む。
 * open は存在しない DB を作ってしまうので、onupgradeneeded が走ったら
 * 「元々無かった」とみなして作った分を消す。
 */
function legacyRecords(): Promise<StoredAsset[]> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve([]);
    let created = false;
    const request = indexedDB.open(LEGACY_DB_NAME);
    request.onupgradeneeded = () => {
      created = true;
    };
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (created || !db.objectStoreNames.contains(STORE)) {
        db.close();
        if (created) indexedDB.deleteDatabase(LEGACY_DB_NAME);
        return resolve([]);
      }
      const tx = db.transaction(STORE, 'readonly');
      const all = tx.objectStore(STORE).getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result as StoredAsset[]);
      };
      all.onerror = () => {
        db.close();
        resolve([]);
      };
    };
  });
}

/** 旧 DB の素材を新しい DB へ移す（アプリ名変更にともなう一度きりの処理）。 */
async function migrateLegacyAssets(): Promise<void> {
  const records = await legacyRecords();
  if (records.length === 0) return;
  for (const record of records) await dbPut(record);
  if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(LEGACY_DB_NAME);
}

// ---------- 参照素材の在り処 ----------

/**
 * 相対パスで覚えている在り処を、いまのページを基準に絶対 URL へ直す。
 * 解けなければそのまま返す（絶対 URL を直に入れられた場合もここを通る）。
 */
export function absoluteSrc(src: string): string {
  try {
    return new URL(src, document.baseURI).href;
  } catch {
    return src;
  }
}

// ---------- 解析 ----------

/** 拡張子だけで種類を決める。URL 参照の素材では MIME が手元に無いので、こちらしか使えない。 */
export function kindOfName(name: string): MediaKind | null {
  const ext = name.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(ext)) return 'audio';
  return null;
}

function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  return kindOfName(file.name);
}

/**
 * 解析全体の締め切り。
 * iOS Safari のようにメタデータの読み込みを遅らせるブラウザだと loadedmetadata が
 * いつまでも来ないことがあり、待ち続けると「読込中…」のまま素材が増えなくなる。
 * 分かった範囲だけで先へ進めるため、必ずどこかで決着させる。
 */
const PROBE_DEADLINE_MS = 12_000;

function withDeadline<T>(work: Promise<T>, fallback: () => T, ms = PROBE_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(fallback()), ms);
    work.then(finish, () => finish(fallback()));
  });
}

/** currentTime への代入は端末によっては例外を投げるので、必ず包む。 */
function seekQuietly(el: HTMLMediaElement, time: number) {
  try {
    el.currentTime = time;
  } catch {
    /* まだシークできない状態。呼び出し側のフォールバックに任せる。 */
  }
}

/** duration が Infinity になる webm/mov 対策。 */
function resolveDuration(el: HTMLMediaElement): Promise<number> {
  if (Number.isFinite(el.duration) && el.duration > 0) return Promise.resolve(el.duration);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeEventListener('timeupdate', onUpdate);
      seekQuietly(el, 0);
      resolve(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0);
    };
    const onUpdate = () => {
      if (el.currentTime > 0) done();
    };
    el.addEventListener('timeupdate', onUpdate);
    seekQuietly(el, 1e6);
    const timer = window.setTimeout(done, 3000);
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

/** よくあるフレームレートに寄せる（29.97 → 30 など、表示と設定のブレを無くすため）。 */
const COMMON_RATES = [12, 15, 24, 25, 30, 48, 50, 60, 90, 120, 240];
export function normalizeFps(rate: number): number | undefined {
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const near = COMMON_RATES.find((r) => Math.abs(rate - r) / r < 0.03);
  return near ?? Math.round(rate * 100) / 100;
}

/**
 * 素材のフレームレートを、入れ物（コンテナ）を読んで求める。
 * <video> 側からは取れない値なので mediabunny に任せる。デコードはしないため、
 * このブラウザで再生できないコーデックでも数えられる。
 */
/**
 * 素材そのもののフレームレートを読む。
 * URL を渡した場合も全部は落とさない（mediabunny が Range で頭だけ読む）。
 */
async function probeFrameRate(from: Blob | string): Promise<number | undefined> {
  let input: Input | undefined;
  try {
    const source = typeof from === 'string' ? new UrlSource(from) : new BlobSource(from);
    input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return undefined;
    // 全パケットを数えると長尺で時間がかかるので、頭の方だけで平均を取る。
    const stats = await track.computePacketStats(180);
    return normalizeFps(stats.averagePacketRate);
  } catch {
    return undefined;
  } finally {
    input?.dispose();
  }
}

interface VideoProbe {
  duration: number;
  width: number;
  height: number;
  thumb: string;
  /** 読み込めなかった場合の理由。素材自体は登録したうえで、UI で注意書きに使う。 */
  warning?: string;
}

/**
 * 動画のメタデータとサムネイルを取れるだけ取る。
 * ここで失敗しても素材は登録する。サムネイルが無くても編集はできるし、
 * 「読み込めないので追加できません」で弾くより、置いてから直せる方が扱いやすい。
 */
function probeVideo(url: string): Promise<VideoProbe> {
  const el = document.createElement('video');
  const release = () => {
    el.removeAttribute('src');
    try {
      el.load();
    } catch {
      /* noop */
    }
  };

  const work = new Promise<VideoProbe>((resolve, reject) => {
    el.preload = 'auto';
    el.muted = true;
    el.playsInline = true;
    el.addEventListener('error', () => reject(new Error('decode failed')));
    el.addEventListener('loadedmetadata', async () => {
      const duration = await resolveDuration(el);
      const width = el.videoWidth || 1080;
      const height = el.videoHeight || 1920;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({ duration, width, height, thumb: snapshot(el, width, height) });
        release();
      };
      el.addEventListener('seeked', finish, { once: true });
      seekQuietly(el, Math.min(duration > 0 ? duration / 2 : 0, 1));
      // シークが返ってこなくても、その時点で描ければサムネイルを作る（描けなければ空のまま）。
      const timer = window.setTimeout(finish, 2500);
    });
    el.src = url;
  });

  return withDeadline<VideoProbe>(work, () => {
    // メタデータすら取れなかった。尺は 0（=既定の長さで置かれる）にしておく。
    const probe: VideoProbe = {
      duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0,
      width: el.videoWidth || 1080,
      height: el.videoHeight || 1920,
      thumb: '',
      warning: 'この動画は情報を読み取れませんでした（再生できない形式の可能性があります）',
    };
    release();
    return probe;
  });
}

function probeImage(url: string): Promise<{ width: number; height: number; thumb: string } | null> {
  const work = new Promise<{ width: number; height: number; thumb: string }>((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight, thumb: snapshot(img, img.naturalWidth, img.naturalHeight) });
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
  return withDeadline<{ width: number; height: number; thumb: string } | null>(work, () => null);
}

function probeAudio(url: string): Promise<number> {
  const work = new Promise<number>((resolve, reject) => {
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.addEventListener('error', () => reject(new Error('decode failed')));
    el.addEventListener('loadedmetadata', async () => resolve(await resolveDuration(el)));
    el.src = url;
  });
  return withDeadline<number>(work, () => 0);
}

// ---------- 再生要素の置き場 ----------

/**
 * 再生用の <video> / <audio> を置いておく、画面には見えない場所。
 *
 * DOM から切り離したままの <video> は「表示されていない」と見なされ、
 * ブラウザがデコードを間引くことがある（プレビューがカクつく原因になる）。
 * 完全に隠すと同じ扱いになるので、ごく小さく・ほぼ透明にして
 * 「表示はされている」状態を保つ。
 */
let stage: HTMLElement | null = null;

function mediaStage(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (stage?.isConnected) return stage;
  stage = document.createElement('div');
  stage.dataset.role = 'media-stage';
  stage.setAttribute('aria-hidden', 'true');
  Object.assign(stage.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '2px',
    height: '2px',
    overflow: 'hidden',
    opacity: '0.01',
    pointerEvents: 'none',
    zIndex: '-1',
  });
  document.body.appendChild(stage);
  return stage;
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
    await migrateLegacyAssets();
    for (const record of await dbAll()) {
      const { blob, ...rest } = record;
      // 参照の素材は相対パスで持っているので、いまのページを基準に解く。
      // 取り込みの素材は Blob から一時 URL を作る。
      const url = rest.src ? absoluteSrc(rest.src) : blob ? URL.createObjectURL(blob) : '';
      if (!url) continue; // 実体も在り処も無い壊れたレコード。読み飛ばす。
      this.assets.set(rest.id, { ...rest, url });
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
      const [meta, fps] = await Promise.all([
        probeVideo(url),
        withDeadline<number | undefined>(probeFrameRate(file), () => undefined, 8000),
      ]);
      asset = {
        ...base,
        url,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps,
        thumbnail: meta.thumb,
        warning: meta.warning,
      };
    } else if (kind === 'image') {
      const meta = await probeImage(url);
      if (!meta) throw new Error(`${file.name} を画像として読み込めませんでした`);
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

  /**
   * NAS などに置いてある素材を、実体を持たずに参照として登録する。
   *
   * `src` はページからの相対パス（`media/a.mp4`）で渡すこと。絶対 URL で覚えると、
   * NAS のホスト名や口が変わった途端に、それを使った全プロジェクトが開けなくなる。
   * 同じ素材を二重に登録しても意味が無いので、既に同じ在り処のものがあればそれを返す。
   */
  async addFromUrl(src: string, folder = UNSORTED): Promise<MediaAsset> {
    const known = [...this.assets.values()].find((a) => a.src === src);
    if (known) return known;

    const name = decodeURIComponent(src.split('/').pop() || src);
    const kind = kindOfName(name);
    if (!kind) throw new Error(`${name} は対応していない形式です`);
    const url = absoluteSrc(src);
    const base = { id: uid('m'), name, kind, size: 0, folder, createdAt: Date.now(), src };

    let asset: MediaAsset;
    if (kind === 'video') {
      const [meta, fps] = await Promise.all([
        probeVideo(url),
        withDeadline<number | undefined>(probeFrameRate(url), () => undefined, 8000),
      ]);
      asset = {
        ...base,
        url,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps,
        thumbnail: meta.thumb,
        warning: meta.warning,
      };
    } else if (kind === 'image') {
      const meta = await probeImage(url);
      if (!meta) throw new Error(`${name} を画像として読み込めませんでした`);
      asset = { ...base, url, duration: 0, width: meta.width, height: meta.height, thumbnail: meta.thumb };
    } else {
      asset = { ...base, url, duration: await probeAudio(url), width: 0, height: 0, thumbnail: '' };
    }

    this.assets.set(asset.id, asset);
    this.emit();
    const { url: _ignored, ...rest } = asset;
    void dbPut(rest);
    return asset;
  }

  /**
   * もらったプロジェクトファイルに入っていた参照素材を、そのまま迎え入れる。
   * 在り処も寸法も向こうで調べ済みなので、ここでは読み直さない
   * （NAS に一瞬繋がらなくても、開くところまでは進める方がよい）。
   * 既にある id には触らない。自分の整理を、もらったファイルに崩されたくない。
   */
  async adopt(assets: (Omit<MediaAsset, 'url' | 'src'> & { src: string })[]): Promise<number> {
    await this.restore();
    let added = 0;
    for (const incoming of assets) {
      if (this.assets.has(incoming.id)) continue;
      this.assets.set(incoming.id, { ...incoming, url: absoluteSrc(incoming.src) });
      void dbPut({ ...incoming });
      added += 1;
    }
    if (added > 0) this.emit();
    return added;
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
    // 参照の素材の url は NAS を指しているだけなので、取り消すものが無い。
    if (!asset.src) URL.revokeObjectURL(asset.url);
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
    mediaStage()?.appendChild(el);
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
    el.remove();
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
