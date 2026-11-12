/**
 * おまかせ下書きのための、録画全体の「1 秒ごとの音の大きさ」。
 *
 * 3 時間の録画の音を丸ごと起こすと、それだけで 2GB 近くになる（48kHz・32bit）。iPad では落ちるので、
 * 2 分ずつ起こしては 1 秒ごとの大きさ（dBFS）だけを残し、起こした音はすぐ手放す。
 * 結果は素材ごとに覚えておく（下書きを作ったあと、別の候補を選び直すときに測り直さない）。
 */
import { decodeAssetAudioRange } from './offline-export';

const CHUNK_SECONDS = 120;
/** 1 秒ごとの音の大きさ（dBFS）と、高い成分の割合（dB）。 */
export interface ScanResult {
  levels: Float32Array;
  /**
   * 高い成分の割合（dB）。隣り合う値の差（高い音ほど大きく出る）の大きさを、音そのものの大きさで割ったもの。
   * 叫び・笑いのように声を張ると上がる。声の高まりの目安に使う（model/candidates.ts）。
   */
  bright: Float32Array;
}

const cache = new Map<string, ScanResult>();

export function cachedLevels(mediaId: string): Float32Array | null {
  return cache.get(mediaId)?.levels ?? null;
}

export function cachedScan(mediaId: string): ScanResult | null {
  return cache.get(mediaId) ?? null;
}

export class ScanCancelled extends Error {}

/** 1 秒ごとの音の大きさ（dBFS）。音の無い秒は -100。 */
export async function scanLevels(
  mediaId: string,
  duration: number,
  onProgress: (ratio: number) => void,
  cancelled: () => boolean,
): Promise<Float32Array> {
  return (await scanAudio(mediaId, duration, onProgress, cancelled)).levels;
}

/** 1 秒ごとの音の大きさと、高い成分の割合。 */
export async function scanAudio(
  mediaId: string,
  duration: number,
  onProgress: (ratio: number) => void,
  cancelled: () => boolean,
): Promise<ScanResult> {
  const hit = cache.get(mediaId);
  if (hit) return hit;
  const seconds = Math.max(0, Math.floor(duration));
  const sum = new Float64Array(seconds);
  const count = new Float64Array(seconds);
  const high = new Float64Array(seconds);
  for (let from = 0; from < seconds; from += CHUNK_SECONDS) {
    if (cancelled()) throw new ScanCancelled();
    const to = Math.min(seconds, from + CHUNK_SECONDS);
    const decoded = await decodeAssetAudioRange(mediaId, from, to);
    if (decoded) {
      const { buffer, start } = decoded;
      const rate = buffer.sampleRate;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      for (let i = 0; i < buffer.length; i++) {
        const second = Math.floor(start + i / rate);
        if (second < from || second >= to) continue;
        let s = 0;
        let d = 0;
        for (const ch of channels) {
          s += ch[i] * ch[i];
          const diff = i > 0 ? ch[i] - ch[i - 1] : 0;
          d += diff * diff;
        }
        sum[second] += s / channels.length;
        high[second] += d / channels.length;
        count[second] += 1;
      }
    }
    onProgress(to / Math.max(1, seconds));
    // 画面が固まらないよう、ひと区切りごとに描画へ譲る。
    await new Promise((r) => setTimeout(r, 0));
  }
  const levels = new Float32Array(seconds);
  for (let i = 0; i < seconds; i++) {
    const rms = count[i] > 0 ? Math.sqrt(sum[i] / count[i]) : 0;
    levels[i] = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }
  const bright = new Float32Array(seconds);
  for (let i = 0; i < seconds; i++) bright[i] = sum[i] > 0 && high[i] > 0 ? Math.max(-100, 10 * Math.log10(high[i] / sum[i])) : -100;
  const result = { levels, bright };
  cache.set(mediaId, result);
  return result;
}
