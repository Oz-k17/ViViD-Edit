/**
 * 書き出し。
 * ブラウザだけで完結させるため、キャンバスを実時間で再生しながら MediaRecorder で収録する。
 * （ffmpeg.wasm のような重い依存を持ち込まない代わりに、書き出し時間 ≒ 動画の長さになる）
 */

import { audioGraph } from './audio';
import type { Player } from './player';
import { withWebmDuration } from './webm';
import { ASPECT_PRESETS, type AspectKey, type Sequence } from '../model/types';

export interface ExportSettings {
  aspect: AspectKey;
  /** 短辺の解像度（1080 / 720 / 480）。 */
  quality: number;
  fps: number;
  /** Mbps */
  bitrate: number;
  format: 'auto' | 'mp4' | 'webm';
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  mimeType: string;
  durationMs: number;
}

/**
 * SNS へそのまま上げられる順に試す。
 * H.264 + AAC の MP4 が最も通りやすく、次点が VP9 + Opus の WebM。
 * コーデック指定のない 'video/mp4' は中身がブラウザ任せになるので最後に回す。
 */
const MIME_CANDIDATES = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm', ext: 'webm' },
];

export function pickMimeType(prefer: 'auto' | 'mp4' | 'webm' = 'auto'): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const ordered =
    prefer === 'auto' ? MIME_CANDIDATES : [...MIME_CANDIDATES].sort((a, b) => (a.ext === prefer ? -1 : b.ext === prefer ? 1 : 0));
  for (const candidate of ordered) {
    if (MediaRecorder.isTypeSupported(candidate.mime)) return candidate;
  }
  return null;
}

export function isExportSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && pickMimeType() !== null;
}

/** 書き出し先の解像度（短辺を quality に合わせる）。 */
export function exportSize(aspect: AspectKey, quality: number): { width: number; height: number } {
  const preset = ASPECT_PRESETS.find((p) => p.key === aspect) ?? ASPECT_PRESETS[0];
  const scale = quality / Math.min(preset.width, preset.height);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(preset.width), height: even(preset.height) };
}

/**
 * ダウンロード名は ASCII に落とす。
 * Chromium は <a download> に非 ASCII が混ざると名前ごと捨てて拡張子なしの "download" にしてしまうため、
 * 日本語のタイトルでも必ず拡張子付きで保存されるようにする。
 */
export function exportFilename(name: string, aspect: string, ext: string, now = new Date()): string {
  const ascii = name
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const base = /[A-Za-z0-9]/.test(ascii) ? ascii.slice(0, 40) : 'short';
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${base}_${aspect.replace(':', 'x')}_${stamp}.${ext}`;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Exporter {
  /** true の間、プレビューの描画ループがこのキャンバスにもフレームを描く。 */
  active = false;
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  /** 書き出し用に画角を差し替えたシーケンス。 */
  sequence: Sequence | null = null;
  private cancelled = false;

  cancel() {
    this.cancelled = true;
  }

  async run(
    name: string,
    sequence: Sequence,
    player: Player,
    settings: ExportSettings,
    onProgress: (ratio: number) => void,
  ): Promise<ExportResult> {
    const picked = pickMimeType(settings.format);
    if (!picked) throw new Error('このブラウザは録画書き出しに対応していません（Chrome / Edge / Safari 17+ を推奨）');
    if (player.duration <= 0) throw new Error('書き出す映像がありません');

    this.cancelled = false;
    const size = exportSize(settings.aspect, settings.quality);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('キャンバスを初期化できませんでした');

    this.canvas = canvas;
    this.ctx = ctx;
    // 画角を変えて書き出す場合は、その解像度でレイアウトし直す。
    this.sequence = { ...sequence, aspect: settings.aspect, width: size.width, height: size.height };

    const wasLooping = player.loop;
    player.setLoop(false);
    player.pause();
    player.seek(0);

    audioGraph.ensure();
    const videoStream = canvas.captureStream(settings.fps);
    const audioStream = audioGraph.recordStream();
    const stream = new MediaStream([...videoStream.getVideoTracks(), ...(audioStream?.getAudioTracks() ?? [])]);

    const recorder = new MediaRecorder(stream, {
      mimeType: picked.mime,
      videoBitsPerSecond: Math.round(settings.bitrate * 1_000_000),
      audioBitsPerSecond: 128_000,
    });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    const startedAt = performance.now();
    this.active = true;
    // 最初のフレームを描いてから録画を始める（先頭の黒コマ対策）
    await nextFrame();
    await nextFrame();

    try {
      recorder.start(200);
      audioGraph.setMonitor(false);
      player.play();

      while (!this.cancelled && player.playing && player.time < player.duration) {
        onProgress(player.duration > 0 ? player.time / player.duration : 0);
        await nextFrame();
      }
      await wait(250); // 最終フレームをキャプチャに乗せるための余白
      onProgress(1);
    } finally {
      player.pause();
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
      this.active = false;
      this.canvas = null;
      this.ctx = null;
      this.sequence = null;
      audioGraph.setMonitor(true);
      player.setLoop(wasLooping);
      videoStream.getTracks().forEach((t) => t.stop());
    }

    if (this.cancelled) throw new Error('書き出しを中止しました');

    const recorded = new Blob(chunks, { type: picked.mime });
    // WebM は MediaRecorder が尺を書かないので、ここで補う（シークできない動画になるのを防ぐ）。
    const blob = picked.ext === 'webm' ? await withWebmDuration(recorded, player.duration) : recorded;
    return {
      blob,
      filename: exportFilename(name, settings.aspect, picked.ext),
      mimeType: picked.mime,
      durationMs: performance.now() - startedAt,
    };
  }
}

/** プレビューの描画ループが参照するので、アプリ内で 1 つだけ持つ。 */
export const exporter = new Exporter();

interface HostDownloads {
  save(request: { filename: string; data: Blob }): Promise<unknown>;
}

/**
 * 書き出したファイルを保存する。
 * 埋め込みビューア（claude.ai の Artifact など）では <a download> が無効化されているので、
 * ホストが保存 API を用意していればそちらを使い、無ければ通常のダウンロードに落とす。
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const use = (window as { claude?: { use?: (name: string) => Promise<unknown> } }).claude?.use;
  if (typeof use === 'function') {
    const downloads = (await use('downloads')) as HostDownloads | null;
    if (downloads) {
      await downloads.save({ filename, data: blob });
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
