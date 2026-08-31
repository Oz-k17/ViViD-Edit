/**
 * 音声のミキサ。
 * 各メディア要素を WebAudio に通し、クリップ音量 / BGM 音量 / フェードを GainNode で処理する。
 * 書き出し時は同じグラフから MediaStream を取り出して MediaRecorder に渡す。
 */

interface Channel {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

export class AudioGraph {
  private ctx: AudioContext | null = null;
  private channels = new Map<HTMLMediaElement, Channel>();
  private master: GainNode | null = null;
  private monitor: GainNode | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;

  /** ユーザー操作の中で呼ぶこと（自動再生ポリシー対策）。 */
  ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.monitor = ctx.createGain();
    this.recordDest = ctx.createMediaStreamDestination();
    this.master.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.master.connect(this.recordDest);
    return ctx;
  }

  /** 要素をグラフに接続し、その音量ノードを返す。未初期化なら null（プレビューは素の音声で鳴る）。 */
  private channel(el: HTMLMediaElement): Channel | null {
    const ctx = this.ctx;
    if (!ctx || !this.master) return null;
    const found = this.channels.get(el);
    if (found) return found;
    try {
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(this.master);
      const channel = { source, gain };
      this.channels.set(el, channel);
      return channel;
    } catch {
      // 既に別グラフへ接続済みなど。素の element.volume にフォールバックする。
      return null;
    }
  }

  setGain(el: HTMLMediaElement, value: number) {
    const clamped = Math.max(0, Math.min(4, value));
    const channel = this.channel(el);
    if (channel && this.ctx) {
      // 細かいカクつきを避けるため少しだけならす
      channel.gain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
      el.volume = 1;
    } else {
      el.volume = Math.max(0, Math.min(1, clamped));
    }
  }

  forget(el: HTMLMediaElement) {
    const channel = this.channels.get(el);
    if (!channel) return;
    try {
      channel.source.disconnect();
      channel.gain.disconnect();
    } catch {
      /* noop */
    }
    this.channels.delete(el);
  }

  /** 書き出し中はスピーカーへの出力を切れる。 */
  setMonitor(on: boolean) {
    if (this.monitor && this.ctx) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  recordStream(): MediaStream | null {
    this.ensure();
    return this.recordDest?.stream ?? null;
  }

  get isReady(): boolean {
    return this.ctx !== null;
  }
}

export const audioGraph = new AudioGraph();

/** フェードイン / フェードアウトの音量係数（0〜1）。 */
export function fadeEnvelope(local: number, duration: number, fadeIn: number, fadeOut: number): number {
  let v = 1;
  if (fadeIn > 0) v = Math.min(v, local / fadeIn);
  if (fadeOut > 0) v = Math.min(v, (duration - local) / fadeOut);
  return Math.max(0, Math.min(1, v));
}
