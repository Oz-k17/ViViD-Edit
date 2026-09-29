/**
 * 音から文字を起こす（アプリの中だけで完結する側）。
 *
 * 重い部分（transformers.js と onnxruntime、そしてモデル）は**同梱しない**。
 * 押されたときに `whisper/worker.js` を読み、そこから先を取りに行く。
 * 置いていなければ、その旨を返して素通りさせる。
 *
 * `file://` から開いた場合（iOS 版）は Worker も fetch も通らないので、
 * ここは必ず「使えません」を返す。取り込み（SRT / VTT / JSON）は今までどおり使える。
 */

import { cuesFromSegments, cuesFromWords, type Cue, type ResultChunk } from '../model/transcript';

/** whisper 一式を置く場所（index.html から見た相対）。 */
export const WHISPER_DIR = 'whisper/';

/**
 * transformers.js の版と、既定の取り寄せ先。
 *
 * リポジトリには入れていない。**最小化された JS には 32 文字の綴りが大量にあり、
 * GitHub の秘密検知が API 鍵と読み違えて push を止める**（中身はクラス名）。
 * 使う人が使うときだけ取りに行く形なら、その問題も起きない。
 * 手元に置きたい場合は `npm run whisper:pack` で `whisper/` へ写せる。
 */
export const TRANSFORMERS_VERSION = '4.3.0';
const CDN_LIBRARY = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;

/** 既定のモデル。日本語で使いものになる下限がこのあたり。 */
export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'large-v3-turbo（重い・いちばん良い）' },
  { id: 'onnx-community/whisper-small', label: 'small（軽い・ぎりぎり）' },
  { id: 'onnx-community/whisper-base', label: 'base（いちばん軽い・粗い）' },
] as const;

export type WhisperDevice = 'webgpu' | 'wasm';

/** いまの環境で回せそうかどうか。 */
export interface WhisperSupport {
  /** `whisper/worker.js` が置いてあるか。 */
  installed: boolean;
  /** WebGPU が使えるか。使えないと large は現実的でない。 */
  webgpu: boolean;
  /** transformers.js も手元に置いてあるか。無ければ CDN から取る。 */
  localLibrary: boolean;
  /** 使えないときの理由。 */
  reason: string | null;
}

/** 置いてあるかどうかだけ見る。無くても困らないものに使う。 */
async function exists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

function baseUrl(): string {
  return new URL(WHISPER_DIR, document.baseURI).href;
}

export async function checkWhisper(): Promise<WhisperSupport> {
  const webgpu = 'gpu' in navigator;
  const no = (reason: string): WhisperSupport => ({ installed: false, webgpu, localLibrary: false, reason });
  if (location.protocol === 'file:') {
    return no('ファイルから直接開いているときは使えません（NAS かサーバー越しに開いてください）');
  }
  const base = baseUrl();
  if (!(await exists(new URL('worker.js', base).href))) return no('whisper/worker.js が見つかりません');
  return {
    installed: true,
    webgpu,
    localLibrary: await exists(new URL('transformers.min.js', base).href),
    reason: null,
  };
}

/**
 * whisper が要る形（16kHz・モノラル）へ直す。
 * 元の音をそのまま渡すと、そもそも受け取ってもらえない。
 */
export async function toMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const rate = 16000;
  const length = Math.max(1, Math.ceil((buffer.duration || 0) * rate));
  const offline = new OfflineAudioContext(1, length, rate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

export interface TranscribeOptions {
  modelId: string;
  device: WhisperDevice;
  language?: string;
  /** 単語ごとの時刻も取る。行を割る位置が言った所と合うが、日本語では当てにならないこともある。 */
  words?: boolean;
  /** transformers.js を手元に置いているか。置いていなければ CDN から取る。 */
  localLibrary?: boolean;
  /** モデルを手元に置いている場合の場所（`whisper/` からの相対）。 */
  localModels?: string | null;
  /** onnxruntime の wasm を手元に置いている場合の場所。 */
  localWasm?: string | null;
  maxChars?: number;
  onStage?: (stage: string) => void;
  onProgress?: (percent: number, file: string) => void;
}

interface ProgressPayload {
  status?: string;
  file?: string;
  progress?: number;
}

/**
 * 1 本の音を文字にする。
 * Worker は 1 回ごとに作って捨てる。読み込んだモデルは持ち越せないが、
 * ブラウザがファイルを覚えているので 2 回目以降は取り直しにならない。
 */
export function transcribe(audio: Float32Array, options: TranscribeOptions): Promise<Cue[]> {
  const base = baseUrl();
  return new Promise<Cue[]>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('worker.js', base).href, { type: 'module' });
    } catch (error) {
      reject(new Error(`whisper を起動できませんでした: ${error instanceof Error ? error.message : error}`));
      return;
    }

    const done = (finish: () => void) => {
      worker.terminate();
      finish();
    };

    worker.addEventListener('error', (event) => done(() => reject(new Error(event.message || 'whisper が落ちました'))));
    worker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type: string; [key: string]: unknown };
      if (data.type === 'stage') {
        options.onStage?.(String(data.stage));
        return;
      }
      if (data.type === 'progress') {
        const p = data.progress as ProgressPayload | undefined;
        if (p && p.status === 'progress' && typeof p.progress === 'number') {
          options.onProgress?.(p.progress, p.file ?? '');
        }
        return;
      }
      if (data.type === 'ready') {
        worker.postMessage(
          { type: 'run', audio, language: options.language ?? 'ja', words: options.words === true },
          [audio.buffer],
        );
        return;
      }
      if (data.type === 'result') {
        const chunks = (data.chunks ?? []) as ResultChunk[];
        const cues = options.words
          ? cuesFromWords(chunks, { maxChars: options.maxChars })
          : cuesFromSegments(chunks);
        done(() => resolve(cues));
        return;
      }
      if (data.type === 'error') {
        done(() => reject(new Error(String(data.message))));
      }
    });

    worker.postMessage({
      type: 'load',
      modelId: options.modelId,
      device: options.device,
      libraryUrl: options.localLibrary ? new URL('transformers.min.js', base).href : CDN_LIBRARY,
      localPath: options.localModels ? new URL(options.localModels, base).href : undefined,
      wasmPath: options.localWasm ? new URL(options.localWasm, base).href : undefined,
    });
  });
}
