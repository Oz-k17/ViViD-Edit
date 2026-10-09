/**
 * 書き出した動画の置き場。
 *
 * 出力を全部メモリに溜める（`BufferTarget`）と、長い動画は入りきらず、ブラウザのタブごと落ちる
 * （3 時間 × 8Mbps なら約 10GB）。出力が大きいときは、ブラウザ内のファイル領域（OPFS）へ
 * 書きながら逃がし、終わったら**ファイルを指す Blob** のまま保存へ渡す（メモリには載せない）。
 *
 * - 小さい出力（既定 150MB 未満）は、今までどおりメモリ。MP4 の先頭にメタデータを置ける（どこでも再生しやすい）
 * - 大きい出力は、ファイルへ。MP4 はメタデータが末尾になる（`fastStart: false`）。
 *   先頭に置くには全部をメモリに溜める必要があるので、長い動画では諦める
 * - OPFS に書けない環境（Safari・iOS アプリ版）は、大きくてもメモリで書き出す。落ちるおそれがあるので知らせる
 */
import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from 'mediabunny';

const DIR = 'vivid-exports';
/** これ以上の出力は、ファイルへ書く。 */
export const FILE_SINK_THRESHOLD_BYTES = 150 * 1024 * 1024;

export interface ExportSink {
  target: Target;
  kind: 'memory' | 'file';
  /** 書き終えたあとに呼ぶ。保存へ渡す Blob を返す。 */
  finish(mimeType: string): Promise<Blob>;
  /** 失敗・中止のときに呼ぶ。書きかけを片付ける。 */
  discard(): Promise<void>;
}

/** OPFS へ直接書けるか（Chrome・Edge・Firefox。Safari の主スレッドでは書けない）。 */
export async function canWriteFiles(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const probe = await dir.getFileHandle('.probe', { create: true });
    if (typeof probe.createWritable !== 'function') return false;
    await dir.removeEntry('.probe').catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function purgeOldExports(dir: FileSystemDirectoryHandle) {
  // 前の書き出しの残り。いま新しく書き出すので、もう要らない。
  // （終わった直後は、保存のために残しておく必要があるので、消すのは次の書き出しの始めにする。）
  const names: string[] = [];
  for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) names.push(name);
  for (const name of names) await dir.removeEntry(name).catch(() => undefined);
}

export class NotEnoughSpace extends Error {}

/**
 * `estimateBytes` 見込みの出力の置き場を用意する。
 * `forceThreshold` は試験用（小さい出力でもファイルへ書かせる）。
 */
export async function openExportSink(
  estimateBytes: number,
  ext: string,
  threshold = FILE_SINK_THRESHOLD_BYTES,
): Promise<ExportSink & { wantedFile: boolean }> {
  const wantedFile = estimateBytes >= threshold;
  const memory = (): ExportSink & { wantedFile: boolean } => {
    const target = new BufferTarget();
    return {
      wantedFile,
      target,
      kind: 'memory',
      finish: async (mimeType) => {
        const buffer = target.buffer;
        if (!buffer) throw new Error('書き出したデータを取り出せませんでした');
        return new Blob([buffer], { type: mimeType });
      },
      discard: async () => undefined,
    };
  };
  if (!wantedFile || !(await canWriteFiles())) return memory();

  // 保存領域に入るか。入らないと、書いている途中で QuotaExceededError になり、時間を無駄にする。
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota !== undefined && estimate.usage !== undefined) {
      const free = estimate.quota - estimate.usage;
      if (estimateBytes * 1.2 > free) {
        throw new NotEnoughSpace(
          `書き出しに必要な保存領域が足りません（約 ${Math.round(estimateBytes / 1024 / 1024)}MB 必要、空き 約 ${Math.max(
            0,
            Math.round(free / 1024 / 1024),
          )}MB）。ブラウザの保存領域を空けるか、画質・ビットレートを下げてください。`,
        );
      }
    }
  } catch (error) {
    if (error instanceof NotEnoughSpace) throw error;
    /* 調べられない環境では、そのまま書いてみる */
  }

  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(DIR, { create: true });
  await purgeOldExports(dir);
  const name = `export-${Date.now()}.${ext}`;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  // chunked: 小さな書き込みを溜めて、まとめて書く（細かい書き込みが多いと遅い）。
  const target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, {
    chunked: true,
    chunkSize: 8 * 1024 * 1024,
  });
  return {
    wantedFile,
    target,
    kind: 'file',
    finish: async (mimeType) => {
      // finalize で書き込み先は閉じられている。ファイルを指す Blob にして返す（読むのは保存するとき）。
      const file = await handle.getFile();
      return file.slice(0, file.size, mimeType);
    },
    discard: async () => {
      await writable.abort().catch(() => undefined);
      await dir.removeEntry(name).catch(() => undefined);
    },
  };
}
