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
import { sanitizeLabels, type LabelColor } from '../model/labels';

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
  /**
   * 動画に音が入っているか。false のときだけ、置いても音声レーンに音を作らない。
   * 調べられなかった・古い素材は undefined（あるものとして扱う）。
   */
  hasAudio?: boolean;
  thumbnail: string;
  size: number;
  folder: string;
  createdAt: number;
  /** 色タグ（整理用）。付けていなければ undefined。 */
  color?: LabelColor;
  /** メモ（自由な文章）。無ければ undefined。 */
  note?: string;
  /** 解析しきれなかった素材に付く注意書き（登録自体はする）。 */
  warning?: string;
  /**
   * 参照している素材の在り処。取り込んだ素材では undefined。
   * **ページからの相対パスのまま持つ**（`media/a.mp4` など）。
   * 絶対 URL で持つと、NAS のホスト名や口を変えた瞬間に全プロジェクトが壊れる。
   */
  src?: string;
  /**
   * NAS の軽量版（プロキシ）の情報。見つかったときだけ付く（Docker の `deploy/nas/proxy.sh` が作ったもの）。
   * ブラウザの中で軽量版を作る機能は無い（以前はあったが、失敗しやすく画面も複雑になるので外した）。
   */
  proxy?: ProxyInfo;
  /** 軽量版を読むための URL（保存しない。開くたびに探す）。 */
  proxyUrl?: string;
}

export interface ProxyInfo {
  /** NAS の Docker（`deploy/nas/proxy.sh`）が作ったもの。保存せず、開くたびに探す。 */
  store: 'server';
  file: string;
  width: number;
  height: number;
  size: number;
  createdAt: number;
}

export const PROXY_DIR = 'vivid-proxies';

/**
 * NAS の軽量版の場所。参照素材 `media/a/b.mp4` → `proxy/media/a/b.mp4.proxy.mp4`。
 * 規則は `deploy/nas/proxy.sh` と揃えてある（変えるなら両方）。
 */
export function serverProxyPath(src: string): string {
  return `proxy/${src.replace(/^\/+/, '')}.proxy.mp4`;
}

/** 以前のバージョンがブラウザ内に作った軽量版のファイルを片付ける（いまは作らない）。 */
export async function deleteProxyFile(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(PROXY_DIR);
    await dir.removeEntry(name);
  } catch {
    /* もう無い */
  }
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

interface StoredAsset extends Omit<MediaAsset, 'url' | 'proxyUrl'> {
  /** 取り込んだ実体。参照（src あり）の素材では持たない。 */
  blob?: Blob;
  /** 以前のバージョンが作った軽量版の実体（読み込み時に捨てる）。 */
  proxyBlob?: Blob;
}

async function dbGet(id: string): Promise<StoredAsset | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(STORE).objectStore(STORE).get(id);
    request.onsuccess = () => resolve((request.result as StoredAsset | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

const MEDIA_LOG_KEY = 'vivid-edit.media-log';
const MEDIA_LOG_LIMIT = 30;

/**
 * 再生まわりで起きたこと（読み込みの失敗・止まったシークの作り直しなど）を、この端末に残す。
 * iPad のように開発者ツールが使えない端末で、症状の手がかりにする（設定の「この端末の診断」に出る）。
 */
export function logMediaEvent(text: string) {
  try {
    const lines = JSON.parse(localStorage.getItem(MEDIA_LOG_KEY) ?? '[]') as string[];
    lines.push(`${new Date().toLocaleString('ja-JP')} ${text}`);
    localStorage.setItem(MEDIA_LOG_KEY, JSON.stringify(lines.slice(-MEDIA_LOG_LIMIT)));
  } catch {
    /* 残せなくても再生は続ける */
  }
}

export function mediaLog(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MEDIA_LOG_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
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

/**
 * 指定した素材のレコードだけを読んで書き直す（1 回の書き込み用トランザクションで）。
 *
 * 以前は、1 つ直すたびに**全部のレコード**を読み直していた（`dbAll`）。素材が 200 本あると 1 回 40〜60ms を
 * 主スレッドで使い、名前を打つたびに画面が引っかかっていた。必要な分だけ鍵で読む。
 * 同じストアへの書き込み用トランザクションは作った順に走るので、続けて直しても順番が入れ替わらない。
 * `edit` が null を返したレコードは書かない。
 */
async function dbModify(ids: Iterable<string>, edit: (record: StoredAsset) => StoredAsset | null): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as StoredAsset | undefined;
        if (!record) return;
        const next = edit(record);
        if (next) store.put(next);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
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
  } finally {
    // 使い終わったキャンバスは、領域ごと返す。WebKit は、持ち主が消えても領域をすぐには手放さず、
    // たまると「Total canvas memory use exceeds the maximum limit」で新しい絵が描けなくなる。
    canvas.width = 0;
    canvas.height = 0;
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
interface ContainerProbe {
  fps?: number;
  hasAudio?: boolean;
}

/** 入れ物（コンテナ）を直接読んで、フレームレートと、音が入っているかを調べる。 */
async function probeContainer(from: Blob | string): Promise<ContainerProbe> {
  let input: Input | undefined;
  try {
    const source = typeof from === 'string' ? new UrlSource(from) : new BlobSource(from);
    input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
    const hasAudio = (await input.getPrimaryAudioTrack().catch(() => undefined)) ? true : false;
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { hasAudio };
    // 全パケットを数えると長尺で時間がかかるので、頭の方だけで平均を取る。
    const stats = await track.computePacketStats(180);
    return { fps: normalizeFps(stats.averagePacketRate), hasAudio };
  } catch {
    return {};
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

/** まとめて取り込むあいだ、画面へ知らせる間隔（ミリ秒）。 */
const HOLD_NOTIFY_MS = 250;

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
    const wait = HOLD_NOTIFY_MS - (performance.now() - this.lastNotify);
    if (this.holding > 0 && wait > 0) {
      // 次の 1 本が遅くても（長い動画の下調べなど）、待たせすぎないよう時間が来たら出す。
      if (!this.pendingNotify) this.notifyTimer = window.setTimeout(() => this.notify(), wait);
      this.pendingNotify = true;
      return;
    }
    this.notify();
  }

  private notifyTimer: number | undefined;

  private notify() {
    window.clearTimeout(this.notifyTimer);
    this.pendingNotify = false;
    this.lastNotify = performance.now();
    this.listeners.forEach((fn) => fn());
  }

  private holding = 0;
  private pendingNotify = false;
  private lastNotify = 0;

  /**
   * まとめて取り込むあいだ、画面への知らせを間引く（最後には必ず知らせる）。
   * 1 本足すたびに知らせると、素材パネル・ビン・色の絞り込みが毎回描き直され、
   * 何百本もの取り込みでは、その描き直しが時間の大半を占める。中身（`all()` / `get()`）は常に最新。
   */
  async batch<T>(work: () => Promise<T>): Promise<T> {
    this.holding += 1;
    try {
      return await work();
    } finally {
      this.holding -= 1;
      if (this.holding === 0 && this.pendingNotify) this.notify();
    }
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
    const legacyProxyIds: string[] = [];
    for (const record of await dbAll()) {
      const { blob, proxyBlob: _proxyBlob, ...rest } = record;
      // 参照の素材は相対パスで持っているので、いまのページを基準に解く。
      // 取り込みの素材は Blob から一時 URL を作る。
      const url = rest.src ? absoluteSrc(rest.src) : blob ? URL.createObjectURL(blob) : '';
      if (!url) continue; // 実体も在り処も無い壊れたレコード。読み飛ばす。
      // 以前のバージョンがブラウザ内に作った軽量版は、もう使わない。場所を食うので片付ける。
      const legacy = rest.proxy as { store?: string; file?: string } | undefined;
      if (legacy && legacy.store !== 'server') {
        if (legacy.store === 'opfs' && legacy.file) void deleteProxyFile(legacy.file);
        legacyProxyIds.push(rest.id);
      }
      const labels = sanitizeLabels(rest);
      const { proxy: _proxy, ...base } = rest;
      this.assets.set(rest.id, { ...base, color: labels.color, note: labels.note, url });
    }
    this.emit();
    if (legacyProxyIds.length > 0) void this.dropLegacyProxies(legacyProxyIds);
    this.probeServerProxies(true);
    // NAS の軽量版は後から出来上がることがある。画面に戻ってきたときに探し直す（30 秒に 1 回まで）。
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.probeServerProxies();
      });
    }
  }

  async add(file: File, folder = UNSORTED): Promise<MediaAsset> {
    const kind = kindOf(file);
    if (!kind) throw new Error(`${file.name} は対応していない形式です`);
    const url = URL.createObjectURL(file);
    const base = { id: uid('m'), name: file.name, kind, size: file.size, folder, createdAt: Date.now() };

    let asset: MediaAsset;
    if (kind === 'video') {
      const [meta, { fps, hasAudio }] = await Promise.all([
        probeVideo(url),
        withDeadline<ContainerProbe>(probeContainer(file), () => ({}), 8000),
      ]);
      asset = {
        ...base,
        url,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps,
        hasAudio,
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
      const [meta, { fps, hasAudio }] = await Promise.all([
        probeVideo(url),
        withDeadline<ContainerProbe>(probeContainer(url), () => ({}), 8000),
      ]);
      asset = {
        ...base,
        url,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps,
        hasAudio,
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
    if (asset.src && asset.kind === 'video') this.probeServerProxy(asset.id);
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
    if (added > 0) {
      this.emit();
      this.probeServerProxies(true);
    }
    return added;
  }

  /**
   * 複数の素材の色タグ・メモを 1 度に変える（再描画と保存を 1 回にまとめる）。
   * `color: undefined` で色を外す。`note` は渡したものに置き換える（外すときは undefined）。
   */
  setLabels(ids: string[], patch: { color?: LabelColor | undefined; note?: string | undefined }) {
    const keys = Object.keys(patch) as Array<'color' | 'note'>;
    if (keys.length === 0) return;
    const changed = new Set<string>();
    for (const id of ids) {
      const asset = this.assets.get(id);
      if (!asset) continue;
      const next = { ...asset };
      let differs = false;
      for (const key of keys) {
        if (next[key] !== patch[key]) {
          (next as Record<string, unknown>)[key] = patch[key];
          differs = true;
        }
      }
      if (!differs) continue;
      this.assets.set(id, next);
      changed.add(id);
    }
    if (changed.size === 0) return;
    this.emit();
    void dbModify(changed, (record) => {
      const next = { ...record };
      for (const key of keys) (next as Record<string, unknown>)[key] = patch[key];
      return next;
    });
  }

  update(id: string, patch: Partial<Pick<MediaAsset, 'name' | 'folder'>>) {
    const asset = this.assets.get(id);
    if (!asset) return;
    const next = { ...asset, ...patch };
    this.assets.set(id, next);
    this.emit();
    void dbModify([id], (record) => ({ ...record, ...patch }));
  }

  /** 複数の素材のフォルダを 1 度に付け替える（再描画と保存を 1 回にまとめる）。 */
  moveToFolders(changes: Array<[id: string, folder: string]>) {
    const moved = new Map<string, string>();
    for (const [id, folder] of changes) {
      const asset = this.assets.get(id);
      if (!asset || asset.folder === folder) continue;
      this.assets.set(id, { ...asset, folder });
      moved.set(id, folder);
    }
    if (moved.size === 0) return;
    this.emit();
    void dbModify(moved.keys(), (record) => {
      const folder = moved.get(record.id);
      return folder === undefined ? null : { ...record, folder };
    });
  }

  /**
   * プレビューにプロキシを使うか。実時間収録の書き出し中は、元の画質で収録するために外す。
   * 切り替えると、使っている再生要素は次に呼ばれたときに作り直される。
   */
  useProxies = true;

  /** 同時に何本まで探しに行くか。起動時に素材が多くても、NAS へ一斉に問い合わせない。 */
  private proxyProbeQueue: string[] = [];
  private proxyProbeRunning = 0;
  private lastProbeAll = 0;

  /**
   * NAS 参照の素材に、サーバー（Docker）が作った軽量版があれば、それを使う。
   * HEAD で有無だけを見る（中身は読まない）。無ければ何もしない。
   * 軽量版は後から出来上がることもあるので、画面に戻ってきたときにも探し直す（`probeServerProxies`）。
   */
  probeServerProxy(id: string) {
    if (!this.proxyProbeQueue.includes(id)) this.proxyProbeQueue.push(id);
    void this.drainProxyProbes();
  }

  /** 軽量版の無い NAS 参照の動画すべてについて、探し直す。短時間に何度も呼ばれても 1 回にまとめる。 */
  probeServerProxies(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProbeAll < 30_000) return;
    this.lastProbeAll = now;
    for (const asset of this.assets.values()) {
      if (asset.kind === 'video' && asset.src && !asset.proxy) this.probeServerProxy(asset.id);
    }
  }

  private async drainProxyProbes() {
    while (this.proxyProbeRunning < 3 && this.proxyProbeQueue.length > 0) {
      const id = this.proxyProbeQueue.shift()!;
      this.proxyProbeRunning += 1;
      void this.probeOne(id).finally(() => {
        this.proxyProbeRunning -= 1;
        void this.drainProxyProbes();
      });
    }
  }

  private async probeOne(id: string) {
    const asset = this.assets.get(id);
    if (!asset?.src || asset.proxy) return;
    const url = absoluteSrc(serverProxyPath(asset.src));
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) return;
      const length = Number(response.headers.get('content-length') ?? 0);
      // 作りかけ・空のファイルは使わない（proxy.sh は .part で書いて完成後に差し替えるので、通常は起きない）。
      if (response.headers.get('content-type')?.startsWith('text/')) return;
      const current = this.assets.get(id);
      if (!current || current.proxy) return;
      this.assets.set(id, {
        ...current,
        proxyUrl: url,
        proxy: { store: 'server', file: serverProxyPath(asset.src), width: 0, height: 0, size: length, createdAt: Date.now() },
      });
      this.emit();
    } catch {
      /* NAS に繋がらない・CORS など。軽量版は無かったことにして、元の素材を使う */
    }
  }

  /** 保存してある、以前の軽量版の情報（と実体）を落とす。 */
  private async dropLegacyProxies(ids: string[]) {
    await dbModify(ids, (record) => {
      const { proxy: _p, proxyBlob: _b, ...plain } = record;
      return plain;
    });
  }

  /** いま再生に使う URL（プロキシがあって、使う設定ならプロキシ）。 */
  playbackUrl(asset: MediaAsset): string {
    return this.useProxies && asset.proxyUrl ? asset.proxyUrl : asset.url;
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

  /**
   * 取り込んだ素材の実体を、保存先（IndexedDB）から読み直して、新しい URL を作る。
   * iPad で長い録画を読んでいると、それまでの URL からの読み込みが失敗し続けることがあるため。
   * 参照の素材（NAS）は在り処が変わらないので何もしない。読み直せたら true。
   */
  async refreshUrl(id: string): Promise<boolean> {
    const asset = this.assets.get(id);
    if (!asset || asset.src) return false;
    const record = await dbGet(id);
    if (!record?.blob) return false;
    const url = URL.createObjectURL(record.blob);
    URL.revokeObjectURL(asset.url);
    this.assets.set(id, { ...asset, url });
    for (const [key, el] of [...this.elements]) {
      if (el.dataset.mediaId === id) this.releaseElement(key);
    }
    this.emit();
    return true;
  }

  /** クリップ専用の再生要素（同じ素材を別のイン点で同時に使えるようキーで分ける）。 */
  mediaElement(key: string, mediaId: string | null, as: 'video' | 'audio' = 'video'): HTMLVideoElement | HTMLAudioElement | null {
    const asset = this.get(mediaId);
    if (!asset || asset.kind === 'image') return null;
    // 動画の音だけを鳴らすクリップ（音声レーンに分けた音）は、<audio> で鳴らす。
    // <video> にすると映像まで読み解くことになり、iPad では読み解きの枠を 1 つ余計に使ってしまう。
    // 軽量版（プロキシ）は映像を軽くするためのものなので、音は元の素材から鳴らす。
    const soundOnly = as === 'audio' || asset.kind === 'audio';
    const url = soundOnly ? asset.url : this.playbackUrl(asset);
    const existing = this.elements.get(key);
    // 同じ素材でも、プロキシ ⇄ 元素材を切り替えたら作り直す。
    if (existing && existing.dataset.mediaId === asset.id && existing.dataset.src === url) return existing;
    if (existing) this.releaseElement(key);

    const el = soundOnly ? document.createElement('audio') : document.createElement('video');
    el.dataset.mediaId = asset.id;
    // 作った時点では先読みしない。長い素材をシーン分割などで何十クリップにすると、
    // 全クリップが一斉に同じ素材を読み込み始めてしまう。使う直前に player が 'auto' へ上げる。
    el.preload = 'metadata';
    el.dataset.src = url;
    el.src = url;
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
    }
    el.load();
    mediaStage()?.appendChild(el);
    this.elements.set(key, el);
    return el;
  }

  /** すでにある要素だけを返す（無ければ作らない）。後始末や一時停止など、作る必要のない場面用。 */
  peekElement(key: string): HTMLVideoElement | HTMLAudioElement | null {
    return (this.elements.get(key) as HTMLVideoElement | HTMLAudioElement | undefined) ?? null;
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

/** 置いた動画に、音声レーンへ分ける音があるか（調べられなかった素材は、あるものとする）。 */
export function assetHasSound(mediaId: string | null): boolean {
  return mediaRegistry.get(mediaId)?.hasAudio !== false;
}

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
