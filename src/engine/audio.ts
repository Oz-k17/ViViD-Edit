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

  private resetListeners = new Set<() => void>();
  private woken = false;

  /**
   * 音の文脈を作り直したときに呼ばれる。つないでいた再生要素は古い文脈につながったままで、
   * 新しい文脈へはつなぎ直せない（`createMediaElementSource` は 1 つの要素に 1 度だけ）ので、
   * 呼ばれた側は要素を手放して作り直すこと。
   */
  onReset(fn: () => void): () => void {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }

  /**
   * 止まった音を起こす。iPad（Safari・WKWebView）の音の文脈は、電話・ほかのアプリの音・画面ロックのあと
   * `interrupted`（Safari だけの状態）になり、長く裏にいると `closed` になることもある。
   * 以前は `suspended` のときしか起こしていなかったので、戻ってきて再生しても無音のままになりえた。
   * `running` 以外なら起こし、`closed` なら作り直す。
   */
  private wake() {
    const ctx = this.ctx;
    if (!ctx) return;
    const state = ctx.state as string;
    if (state === 'closed') {
      this.rebuild();
      return;
    }
    if (state !== 'running') void ctx.resume().catch(() => undefined);
  }

  private rebuild() {
    this.ctx = null;
    this.master = null;
    this.monitor = null;
    this.recordDest = null;
    this.channels.clear();
    this.create();
    for (const fn of this.resetListeners) fn();
  }

  /**
   * 次に触ったとき・アプリへ戻ってきたときにも起こす。iOS は、音の文脈を起こせるのを
   * 利用者の操作の中に限るので、再生ボタン以外を触ったときにも試しておく（起こせなければ何もしない）。
   */
  private listenForWake() {
    if (this.woken || typeof document === 'undefined') return;
    this.woken = true;
    const wake = () => this.wake();
    document.addEventListener('pointerdown', wake, true);
    document.addEventListener('keydown', wake, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
  }

  /** ユーザー操作の中で呼ぶこと（自動再生ポリシー対策）。 */
  ensure(): AudioContext | null {
    if (this.ctx) {
      this.wake();
      return this.ctx;
    }
    return this.create();
  }

  private create(): AudioContext | null {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.listenForWake();
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
