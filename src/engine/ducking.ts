/**
 * ダッキング（BGM を声の間だけ下げる）のための「声の大きさの列」を作って持っておく。
 *
 * 声のクリップの音をデコードして、20ms ごとの音量を測り、タイムライン全体の 1 本に重ねる。
 * 決め方そのもの（いつ下げ、いつ戻すか）は `model/sound.ts`（lab/auto-cut から持ってきたもの）。
 *
 * プレビューは毎コマ音量を決めるので、測った列をここに覚えておく。声のクリップの並びが
 * 変わったときだけ測り直す（測っている間は、下げずに鳴らす）。書き出しは同じ関数を直接呼ぶ。
 */
import { analyzeLoudness } from '../analysis/audio/loudness';
import { ducks, mergeVoiceLevels, planDucking, type GainPoint, type VoiceLevels } from '../model/sound';
import { sequenceDuration } from '../model/ops';
import type { Clip, Sequence } from '../model/types';
import { decodeAssetAudioRange } from './offline-export';

/** 声として聞くクリップ: 音を持ち、鳴らしていて、それ自身は下げられる側（BGM）でないもの。 */
function voiceClips(sequence: Sequence): Clip[] {
  const mutedTracks = new Set(sequence.tracks.filter((t) => t.muted).map((t) => t.id));
  return sequence.clips.filter(
    (c) =>
      (c.kind === 'video' || c.kind === 'audio') &&
      !!c.mediaId &&
      !c.muted &&
      !mutedTracks.has(c.trackId) &&
      c.volume > 0 &&
      c.sound?.role !== 'music',
  );
}

function voiceKey(clips: readonly Clip[]): string {
  return clips.map((c) => `${c.mediaId}@${c.start}+${c.duration}:${c.sourceIn}x${c.speed}`).join(';');
}

/** タイムラインの声の大きさを測る。声のクリップが無ければ null。 */
export async function measureVoiceLevels(sequence: Sequence, duration = sequenceDuration(sequence)): Promise<VoiceLevels | null> {
  const clips = voiceClips(sequence);
  if (clips.length === 0) return null;
  const parts: { at: number; levels: VoiceLevels }[] = [];
  for (const clip of clips) {
    const speed = clip.speed || 1;
    const decoded = await decodeAssetAudioRange(clip.mediaId as string, clip.sourceIn, clip.sourceIn + clip.duration * speed).catch(
      () => null,
    );
    if (!decoded) continue;
    const levels = analyzeLoudness(decoded.buffer);
    // 素材の秒 → タイムラインの秒（速さを変えたクリップは、1 コマの長さも縮む）。
    const at = clip.start + (decoded.start - clip.sourceIn) / speed;
    const end = clip.start + clip.duration;
    const frames = Math.max(0, Math.min(levels.db.length, Math.ceil((end - at) / (levels.hop / speed))));
    parts.push({ at, levels: { hop: levels.hop / speed, db: levels.db.subarray(0, frames), duration: levels.duration / speed } });
  }
  if (parts.length === 0) return null;
  return mergeVoiceLevels(parts, duration);
}

/** BGM のクリップに掛ける音量の折れ線（声が無ければ null）。 */
export function duckPointsFor(levels: VoiceLevels | null, duckDb: number): GainPoint[] | null {
  if (!levels || duckDb <= 0) return null;
  return planDucking(levels, { duckDb: -duckDb });
}

/** プレビュー用に、測った列を覚えておく所。 */
class DuckingStore {
  private key = '';
  private levels: VoiceLevels | null = null;
  private running: string | null = null;
  private plans = new Map<number, GainPoint[] | null>();

  /** 下げる BGM があるときだけ、声の並びが変わっていれば測り直しを始める（待たない）。 */
  ensure(sequence: Sequence) {
    if (!sequence.clips.some((c) => ducks(c.sound))) return;
    const key = voiceKey(voiceClips(sequence));
    if (key === this.key || key === this.running) return;
    this.running = key;
    void measureVoiceLevels(sequence)
      .then((levels) => {
        if (this.running !== key) return;
        this.key = key;
        this.levels = levels;
        this.plans.clear();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.running === key) this.running = null;
      });
  }

  /** いま覚えている列での折れ線（測り終えていなければ null = 下げない）。 */
  pointsFor(duckDb: number): GainPoint[] | null {
    if (!this.plans.has(duckDb)) this.plans.set(duckDb, duckPointsFor(this.levels, duckDb));
    return this.plans.get(duckDb) ?? null;
  }
}

export const duckingStore = new DuckingStore();
