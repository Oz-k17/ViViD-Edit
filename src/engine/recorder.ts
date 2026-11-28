/**
 * カメラ・画面の録画（録ったものは素材に入れる）。
 *
 * - カメラ: `getUserMedia`。iPad の Safari・アプリ（WKWebView、iOS 14.3 から）でも使える。アプリ版はカメラとマイクの許可（Package.swift の capabilities）が要る
 * - 画面: `getDisplayMedia`。パソコンのブラウザだけ（iPad の Safari・WKWebView には無い）
 * 収録は MediaRecorder。入れ物は、Safari は MP4、Chromium・Firefox は WebM（尺が書かれないので、止めたあとに書き足す）。
 */

import { withWebmDuration } from './webm';

export type RecordSource = 'camera' | 'screen';

export interface RecordSupport {
  camera: boolean;
  screen: boolean;
  recorder: boolean;
}

export function recordSupport(): RecordSupport {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return {
    camera: typeof md?.getUserMedia === 'function',
    screen: typeof md?.getDisplayMedia === 'function',
    recorder: typeof MediaRecorder !== 'undefined',
  };
}

/** 録画の入れ物。MP4（H.264・AAC）を先に（カメラロール・ほかのアプリで扱いやすい）、無ければ WebM。 */
const RECORD_TYPES = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

export function pickRecordType(isSupported: (mime: string) => boolean = (m) => MediaRecorder.isTypeSupported(m)): { mime: string; ext: string } | null {
  for (const t of RECORD_TYPES) if (isSupported(t.mime)) return t;
  return null;
}

/** 録画のファイル名（素材の一覧で並べやすいように、日時を入れる）。 */
export function recordingName(source: RecordSource, ext: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${source === 'camera' ? 'カメラ' : '画面'}録画_${stamp}.${ext}`;
}

/** 映像（と音）の流れを開く。断られたら、分かる言葉で投げる。 */
export async function openStream(source: RecordSource, options: { facing: 'user' | 'environment'; mic: boolean }): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  try {
    if (source === 'camera') {
      return await md.getUserMedia({
        video: { facingMode: options.facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: options.mic,
      });
    }
    const screen = await md.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    // 画面の音とは別に、マイクの声も入れたいとき（ナレーション）は、マイクの音を足す。
    if (options.mic && screen.getAudioTracks().length === 0) {
      try {
        const mic = await md.getUserMedia({ audio: true });
        for (const t of mic.getAudioTracks()) screen.addTrack(t);
      } catch {
        /* マイクが無くても、画面だけは録る */
      }
    }
    return screen;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error(
        source === 'camera'
          ? 'カメラ（とマイク）を使う許可がありません。設定でこのアプリ（またはブラウザ）にカメラとマイクを許可してください'
          : '画面の録画が許可されませんでした',
      );
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('カメラ（またはマイク）が見つかりません');
    throw new Error(`録画を始められませんでした（${name ?? String(error)}）`);
  }
}

export interface Recording {
  stop(): Promise<File>;
  cancel(): void;
}

/** 流れを録り始める。stop で、素材に入れられるファイルを返す。 */
export function startRecording(stream: MediaStream, source: RecordSource): Recording {
  const type = pickRecordType();
  if (!type) throw new Error('この環境では録画できません');
  const recorder = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const startedAt = performance.now();
  // 1 秒ごとに受け取る（長く録ってもメモリに 1 塊で溜めない・止める前に落ちても途中まで残りやすい）。
  recorder.start(1000);
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () =>
      new Promise<File>((resolve, reject) => {
        recorder.onstop = async () => {
          stopTracks();
          const seconds = (performance.now() - startedAt) / 1000;
          try {
            let blob = new Blob(chunks, { type: type.mime.split(';')[0] });
            if (type.ext === 'webm') blob = await withWebmDuration(blob, seconds);
            if (blob.size === 0) throw new Error('何も録れていませんでした');
            resolve(new File([blob], recordingName(source, type.ext), { type: blob.type }));
          } catch (e) {
            reject(e);
          }
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      stopTracks();
    },
  };
}
