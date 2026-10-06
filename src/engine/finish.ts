import { finishAudio, type AudioFinishReport } from '../model/audioFinish';

/** ミックス済みの AudioBuffer に音量仕上げを当て、新しい AudioBuffer と報告を返す。 */
export function finishMix(mix: AudioBuffer): { buffer: AudioBuffer; report: AudioFinishReport } {
  const { buffer, report } = finishAudio(mix);
  if (buffer === mix) return { buffer: mix, report };
  const out = new AudioBuffer({
    length: buffer.length,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
  });
  for (let c = 0; c < buffer.numberOfChannels; c += 1) out.copyToChannel(buffer.getChannelData(c) as Float32Array<ArrayBuffer>, c);
  return { buffer: out, report };
}
