/**
 * `model/sound.ts` の並びを、WebAudio の部品につないで返す。
 * プレビュー（AudioContext）と書き出し（OfflineAudioContext）の両方から呼ぶので、型は BaseAudioContext。
 */
import type { SoundStage } from '../model/sound';

export interface SoundChain {
  input: AudioNode;
  output: AudioNode;
  nodes: AudioNode[];
}

/** 並びが空なら null（つなぎ直さず、いままでどおり素通しにする）。 */
export function buildSoundChain(ctx: BaseAudioContext, stages: readonly SoundStage[]): SoundChain | null {
  if (stages.length === 0) return null;
  const nodes: AudioNode[] = stages.map((stage) => {
    if (stage.kind === 'filter') {
      const f = ctx.createBiquadFilter();
      f.type = stage.type;
      f.frequency.value = stage.frequency;
      f.gain.value = stage.gain;
      f.Q.value = stage.q;
      return f;
    }
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = stage.threshold;
    c.ratio.value = stage.ratio;
    c.attack.value = stage.attack;
    c.release.value = stage.release;
    c.knee.value = stage.knee;
    return c;
  });
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].connect(nodes[i + 1]);
  return { input: nodes[0], output: nodes[nodes.length - 1], nodes };
}

export function disposeSoundChain(chain: SoundChain | null): void {
  if (!chain) return;
  for (const node of chain.nodes) {
    try {
      node.disconnect();
    } catch {
      /* 既に外れている */
    }
  }
}
