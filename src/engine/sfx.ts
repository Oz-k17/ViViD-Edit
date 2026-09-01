/**
 * 効果音プリセット。
 * 音源ファイルを同梱する代わりに、WebAudio でその場で合成して WAV に書き出す。
 * これならリポジトリを重くせずに、初回起動時から使える効果音が 8 種そろう。
 */

export interface SfxPreset {
  key: string;
  name: string;
  duration: number;
  build: (ctx: OfflineAudioContext) => void;
}

function envelope(node: GainNode, start: number, attack: number, decay: number, peak = 0.9) {
  node.gain.setValueAtTime(0.0001, start);
  node.gain.exponentialRampToValueAtTime(peak, start + attack);
  node.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
}

function tone(
  ctx: OfflineAudioContext,
  type: OscillatorType,
  frequency: number,
  start: number,
  duration: number,
  peak = 0.7,
  glideTo?: number,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(glideTo, start + duration);
  envelope(gain, start, Math.min(0.02, duration / 4), duration, peak);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

function noise(ctx: OfflineAudioContext, start: number, duration: number, filter: number, peak = 0.5, sweepTo?: number) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(filter, start);
  if (sweepTo !== undefined) band.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);
  band.Q.value = 1.2;
  const gain = ctx.createGain();
  envelope(gain, start, Math.min(0.03, duration / 3), duration, peak);
  source.connect(band).connect(gain).connect(ctx.destination);
  source.start(start);
  source.stop(start + duration + 0.05);
}

export const SFX_PRESETS: SfxPreset[] = [
  {
    key: 'pilorin',
    name: 'ピロリン',
    duration: 0.9,
    build: (ctx) => {
      tone(ctx, 'sine', 988, 0, 0.28, 0.6);
      tone(ctx, 'sine', 1319, 0.12, 0.55, 0.55);
      tone(ctx, 'sine', 2637, 0.12, 0.4, 0.18);
    },
  },
  {
    key: 'notify',
    name: '通知音',
    duration: 0.8,
    build: (ctx) => {
      tone(ctx, 'triangle', 880, 0, 0.22, 0.7);
      tone(ctx, 'triangle', 1174, 0.16, 0.45, 0.6);
    },
  },
  {
    key: 'pon',
    name: 'ポン',
    duration: 0.4,
    build: (ctx) => {
      tone(ctx, 'sine', 720, 0, 0.28, 0.9, 220);
    },
  },
  {
    key: 'swoosh',
    name: 'シュワ',
    duration: 0.7,
    build: (ctx) => {
      noise(ctx, 0, 0.6, 600, 0.45, 4200);
    },
  },
  {
    key: 'shutter',
    name: 'カシャ',
    duration: 0.35,
    build: (ctx) => {
      noise(ctx, 0, 0.06, 2600, 0.7);
      noise(ctx, 0.09, 0.14, 1400, 0.5);
    },
  },
  {
    key: 'tap',
    name: 'タッ',
    duration: 0.2,
    build: (ctx) => {
      tone(ctx, 'square', 1400, 0, 0.05, 0.35, 700);
      noise(ctx, 0, 0.05, 3200, 0.3);
    },
  },
  {
    key: 'sparkle',
    name: 'キラキラ',
    duration: 1.1,
    build: (ctx) => {
      [1568, 2093, 2637, 3136].forEach((frequency, index) => {
        tone(ctx, 'sine', frequency, index * 0.11, 0.35, 0.32);
      });
    },
  },
  {
    key: 'buzz',
    name: 'ブー',
    duration: 0.7,
    build: (ctx) => {
      tone(ctx, 'square', 165, 0, 0.5, 0.4);
      tone(ctx, 'square', 110, 0.02, 0.5, 0.35);
    },
  },
];

/** AudioBuffer を 16bit PCM の WAV にする。 */
function toWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * channels * 2, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function renderPreset(preset: SfxPreset): Promise<File> {
  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctor) throw new Error('この環境では効果音を生成できません');
  const sampleRate = 44100;
  const ctx = new Ctor(1, Math.ceil(sampleRate * preset.duration), sampleRate);
  preset.build(ctx);
  const buffer = await ctx.startRendering();
  return new File([toWav(buffer)], `${preset.name}.wav`, { type: 'audio/wav' });
}
