/**
 * プレビュー用の軽い複製（プロキシ）を作る。
 *
 * 長尺・高解像度の素材（3 時間の 1080p など）は、プレビューで「デコードするだけ」で重い。
 * キャンバスを小さくしてもデコードの重さは変わらないので、素材そのものを軽くした複製を作り、
 * プレビューと再生にはそちらを使う。**書き出しと自動解析は元の素材を使う**（画質は落ちない）。
 *
 * 複製の中身:
 * - 長辺 640px・最大 30fps・低めのビットレート
 * - **キーフレームを 1 秒ごと**に入れる。飛ばし飛ばしに見るとき、シークのたびに戻ってデコードする量が
 *   元素材（数秒〜十数秒ごとが多い）より大幅に減る
 * - 音も入れる（再生要素が音も鳴らすため）
 *
 * 置き場所はブラウザ内のファイル領域（OPFS）。3 時間ぶんでも数百 MB になるので、メモリに溜めずに
 * そのままファイルへ書く。OPFS へ書けない環境では、メモリで作って IndexedDB に入れる（長尺は厳しい）。
 */
import {
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  UrlSource,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type StreamTargetChunk,
} from 'mediabunny';
import { useSyncExternalStore } from 'react';
import { VIDEO_INPUT_FORMATS } from './formats';
import { deleteProxyFile, mediaRegistry, PROXY_DIR, type ProxyInfo } from './media';

const LONG_SIDE = 640;
const MAX_FPS = 30;
const VIDEO_BITRATE = 700_000;
const AUDIO_BITRATE = 96_000;
const KEYFRAME_SECONDS = 1;
/** OPFS が使えないとき、メモリで作ってよい大きさの上限。 */
const MEMORY_LIMIT_BYTES = 350 * 1024 * 1024;

/** 素材ごとの作業の様子。 */
export type ProxyJob =
  | { state: 'queued' }
  | { state: 'running'; progress: number }
  | { state: 'error'; message: string };

let jobs: Record<string, ProxyJob> = {};
const listeners = new Set<() => void>();
const queue: string[] = [];
let running: { id: string; conversion: Conversion | null; canceled: boolean } | null = null;

function setJob(id: string, job: ProxyJob | null) {
  const next = { ...jobs };
  if (job) next[id] = job;
  else delete next[id];
  jobs = next;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useProxyJobs(): Record<string, ProxyJob> {
  return useSyncExternalStore(subscribe, () => jobs, () => jobs);
}

/** この素材は軽量版を作る意味があるか（動画で、まだ無いもの）。 */
export function canMakeProxy(id: string): boolean {
  const asset = mediaRegistry.get(id);
  return !!asset && asset.kind === 'video' && !asset.proxy && !asset.warning;
}

/** 長尺・高解像度で、軽量版を勧めたほうがよい素材か。 */
export function shouldSuggestProxy(id: string): boolean {
  const asset = mediaRegistry.get(id);
  if (!asset || !canMakeProxy(id)) return false;
  return asset.duration >= 10 * 60 || Math.max(asset.width, asset.height) > 1280;
}

/** 作る順番待ちに入れる（同じものは二重に入れない）。 */
export function requestProxies(ids: string[]) {
  for (const id of ids) {
    if (!canMakeProxy(id) || jobs[id]?.state === 'queued' || jobs[id]?.state === 'running') continue;
    queue.push(id);
    setJob(id, { state: 'queued' });
  }
  void pump();
}

/** 作っている途中・待っているものをやめる。 */
export async function cancelProxy(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  if (running?.id === id) {
    running.canceled = true;
    await running.conversion?.cancel().catch(() => undefined);
  }
  setJob(id, null);
}

export async function removeProxy(id: string) {
  await mediaRegistry.detachProxy(id);
}

async function pump() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  running = { id, conversion: null, canceled: false };
  setJob(id, { state: 'running', progress: 0 });
  try {
    await build(id);
    if (!running.canceled) setJob(id, null);
  } catch (error) {
    if (!running.canceled) {
      setJob(id, { state: 'error', message: error instanceof Error ? error.message : '軽量版を作れませんでした' });
    }
  } finally {
    running = null;
    void pump();
  }
}

/** 偶数に丸める（多くのエンコーダは奇数の幅・高さを受け付けない）。 */
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

async function openWritable(name: string): Promise<{ writable: FileSystemWritableFileStream; done: () => Promise<File> } | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(PROXY_DIR, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== 'function') return null;
    const writable = await handle.createWritable();
    return { writable, done: () => handle.getFile() };
  } catch {
    return null;
  }
}

async function build(id: string) {
  const asset = mediaRegistry.get(id);
  if (!asset) throw new Error('素材が見つかりません');
  const job = running!;

  // 参照（NAS）の素材は Range で読む。取り込んだ素材は手元の Blob から読む。
  const source = asset.src
    ? new UrlSource(asset.url)
    : new BlobSource(await (await fetch(asset.url)).blob());
  const input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
  let partial: string | null = null;
  let openFile: { writable: FileSystemWritableFileStream } | null = null;
  let finished = false;

  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('映像が入っていません');
    const w = track.displayWidth || asset.width || 1920;
    const h = track.displayHeight || asset.height || 1080;
    const scale = Math.min(1, LONG_SIDE / Math.max(w, h));
    const width = even(w * scale);
    const height = even(h * scale);

    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp8', 'vp9'], { width, height });
    if (!videoCodec) throw new Error('この環境では軽量版の映像を書き出せません');
    const mp4 = videoCodec === 'avc';
    const audioCodec = await getFirstEncodableAudioCodec(mp4 ? ['aac', 'opus'] : ['opus'], {
      numberOfChannels: 2,
      sampleRate: 48_000,
    });
    const ext = mp4 ? 'mp4' : 'webm';
    const fileName = `${id}.${ext}`;

    const file = await openWritable(fileName);
    // ファイル領域（OPFS）が使えないと、軽量版を丸ごとメモリに溜めることになる。長い動画では持たないので、始める前に止める。
    if (!file) {
      const duration = await input.computeDuration().catch(() => asset.duration);
      const estimate = (duration * (VIDEO_BITRATE + AUDIO_BITRATE)) / 8;
      if (estimate > MEMORY_LIMIT_BYTES) {
        throw new Error(
          'この開き方ではブラウザ内のファイル領域が使えず、長い動画の軽量版はメモリに収まりません' +
            `（約 ${Math.round(estimate / 1024 / 1024)}MB）。index.html を直接開いている場合は、Web サーバ経由で開いてください。`,
        );
      }
    }
    if (file) {
      partial = fileName;
      openFile = file;
    }
    const target = file
      ? new StreamTarget(file.writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true })
      : new BufferTarget();
    const output = new Output({
      format: mp4 ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target,
    });

    const fps = await track
      .computePacketStats(120)
      .then((s) => s.averagePacketRate)
      .catch(() => MAX_FPS);
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: {
        width,
        height,
        fit: 'fill',
        codec: videoCodec,
        quality: new Quality({ bitrate: VIDEO_BITRATE }),
        frameRate: Math.min(MAX_FPS, Math.round(fps) || MAX_FPS),
        keyFrameInterval: KEYFRAME_SECONDS,
        forceTranscode: true,
      },
      audio: audioCodec ? { codec: audioCodec, quality: new Quality({ bitrate: AUDIO_BITRATE }), numberOfChannels: 2 } : { discard: true },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
      throw new Error(`この素材は軽量版に変換できません（${reasons || '理由不明'}）`);
    }
    job.conversion = conversion;
    let shown = 0;
    conversion.onProgress = (progress) => {
      // 毎回知らせると画面の再描画が増えるので、1% 刻みにする。
      const p = Math.floor(progress * 100);
      if (p !== shown) {
        shown = p;
        setJob(id, { state: 'running', progress: p / 100 });
      }
    };
    await conversion.execute();
    if (job.canceled) return;

    let blob: Blob;
    let store: ProxyInfo['store'];
    if (file) {
      blob = await file.done();
      store = 'opfs';
    } else {
      const buffer = (target as BufferTarget).buffer;
      if (!buffer) throw new Error('軽量版を取り出せませんでした');
      blob = new Blob([buffer], { type: mp4 ? 'video/mp4' : 'video/webm' });
      store = 'idb';
    }
    await mediaRegistry.attachProxy(id, { store, file: fileName, width, height, size: blob.size, createdAt: Date.now() }, blob);
    finished = true;
  } finally {
    input.dispose();
    // 中止・失敗で書きかけのファイルが残らないようにする。
    if (!finished && partial) {
      // 書き込み途中のまま消すと一時ファイル（.crswap）が残るので、先に中断する。
      await openFile?.writable.abort().catch(() => undefined);
      await deleteProxyFile(partial);
    }
  }
}
