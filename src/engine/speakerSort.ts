/**
 * テロップを「誰が喋っているか」で振り分ける。
 *
 * 手順書と同じ組み立てにしてある。**人が手本を示し、残りをそれとの近さで決める**。
 * 手本無しに 2 つへ割る（クラスタリング）のは、手順書自身が「両者が同じ側に寄る」と
 * 書いているので採らない。
 *
 * 近さの計算そのものは `voiceprint.ts`（画面にも WebAudio にも依存しない）。
 * こちらは「タイムラインのどこの音を渡すか」を受け持つ。
 */

import { clipEnd, sourceTimeAt, type Clip, type Sequence } from '../model/types';
import { decodeAssetAudio } from './offline-export';
import { pickSpeaker, voicePrint, type Anchor, type Decision, type VoicePrint } from './voiceprint';

/** 判定が済んだ 1 行ぶん。 */
export interface SpeakerResult {
  clipId: string;
  /** 手本のどれに近かったか。null は音が取れなかった行。 */
  decision: Decision<string> | null;
  /** 音が取れなかった理由。 */
  reason?: string;
}

/**
 * その時刻に鳴っている素材のうち、いちばん下のトラックのもの。
 * 効果音や BGM ではなく本編の音を拾いたいので、映像に付いている音を先に見る。
 */
function soundingAt(sequence: Sequence, from: number, to: number): Clip | null {
  const candidates = sequence.clips.filter(
    (c) => (c.kind === 'video' || c.kind === 'audio') && c.mediaId && !c.muted && c.start < to && clipEnd(c) > from,
  );
  if (candidates.length === 0) return null;
  const video = candidates.filter((c) => c.kind === 'video');
  return (video.length ? video : candidates)[0];
}

/** AudioBuffer の一部を、モノラルの列として取り出す。 */
function monoSlice(buffer: AudioBuffer, from: number, to: number): Float32Array | null {
  const start = Math.max(0, Math.floor(from * buffer.sampleRate));
  const end = Math.min(buffer.length, Math.ceil(to * buffer.sampleRate));
  const length = end - start;
  if (length <= 0) return null;
  const out = new Float32Array(length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) out[i] += data[start + i] / buffer.numberOfChannels;
  }
  return out;
}

/**
 * そのクリップの範囲に鳴っている音から、声の指紋を取る。
 * 音が無い／取れないときは null。
 */
async function printFor(
  sequence: Sequence,
  clip: Clip,
  cache: Map<string, AudioBuffer | null>,
): Promise<{ print: VoicePrint | null; reason?: string }> {
  const source = soundingAt(sequence, clip.start, clipEnd(clip));
  if (!source || !source.mediaId) return { print: null, reason: 'この時間に鳴っている素材がありません' };

  if (!cache.has(source.mediaId)) cache.set(source.mediaId, await decodeAssetAudio(source.mediaId));
  const buffer = cache.get(source.mediaId) ?? null;
  if (!buffer) return { print: null, reason: '素材から音を取り出せませんでした' };

  // テロップの範囲と、鳴っている素材の範囲が重なっている所だけを見る。
  const from = Math.max(clip.start, source.start);
  const to = Math.min(clipEnd(clip), clipEnd(source));
  const samples = monoSlice(buffer, sourceTimeAt(source, from), sourceTimeAt(source, to));
  if (!samples) return { print: null, reason: '範囲が短すぎます' };

  const print = voicePrint(samples, buffer.sampleRate);
  if (!print) return { print: null, reason: '声が見つかりませんでした（間や効果音だけの区間）' };
  return { print };
}

export interface SortOptions {
  /** 手本。テロップの id と、その人の名札。 */
  anchors: { clipId: string; speaker: string }[];
  /** 振り分ける相手。手本に挙げたものは除く。 */
  targets: Clip[];
}

/**
 * 手本を元に、テロップを話者へ振り分ける。
 *
 * 手本の音が取れなければ、その手本は使わない（黙って全部を残りの 1 人に
 * 寄せてしまうより、足りないことを伝えたほうがよい）。
 */
export async function sortSpeakers(
  sequence: Sequence,
  options: SortOptions,
): Promise<{ results: SpeakerResult[]; anchorsUsed: string[]; missing: string[] }> {
  const cache = new Map<string, AudioBuffer | null>();
  const anchors: Anchor<string>[] = [];
  const missing: string[] = [];

  for (const entry of options.anchors) {
    const clip = sequence.clips.find((c) => c.id === entry.clipId);
    if (!clip) continue;
    const { print } = await printFor(sequence, clip, cache);
    if (print) anchors.push({ id: entry.speaker, print });
    else missing.push(entry.speaker);
  }

  const results: SpeakerResult[] = [];
  if (anchors.length >= 2) {
    for (const clip of options.targets) {
      const { print, reason } = await printFor(sequence, clip, cache);
      results.push({ clipId: clip.id, decision: print ? pickSpeaker(print, anchors) : null, reason });
    }
  }

  return { results, anchorsUsed: anchors.map((a) => a.id), missing };
}
