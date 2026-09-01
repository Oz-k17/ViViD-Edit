/**
 * 再生エンジン（マルチトラック）。
 * 壁時計（performance.now）でタイムライン時刻を進め、各クリップの <video>/<audio> をそこへ追従させる。
 * 映像側の currentTime を基準にすると、カットをまたぐたびに時間が飛んで同期が崩れるため。
 */

import { audioGraph } from './audio';
import { mediaRegistry } from './media';
import { fadeEnvelope, type RenderSources } from './renderer';
import { clipAtTime, previousAdjacent, sequenceDuration } from '../model/ops';
import { sourceTimeAt, type Clip, type Sequence } from '../model/types';

/**
 * 映像の追従。
 *
 * ズレるたびにシークすると、シークがキーフレームまで戻ってデコードし直すぶん
 * さらに遅れ、また閾値を超えて再びシーク…という悪循環に入る。
 * 重い素材（4K や高ビットレート）ほど起きやすく、これがカクつきの元になる。
 * そこで小さなズレは再生速度の微調整で吸収し、シークは大きく飛んだときだけにする。
 */
/** これ以下のズレは直さない（秒）。 */
const DRIFT_IGNORE = 0.05;
/** ここまでのズレは再生速度で吸収する（秒）。 */
const DRIFT_SOFT_LIMIT = 0.5;
/** 速度で追いつかせるときの倍率。大きくすると音程が目立つ。 */
const CATCH_UP_RATE = 0.03;
/** シークの連発を防ぐ間隔（ミリ秒）。 */
const SEEK_COOLDOWN_MS = 700;
/** 次のクリップを何秒前から頭出ししておくか。 */
const PREROLL = 1.2;

type Listener = () => void;

interface ActiveClip {
  clip: Clip;
  /** トランジションで前のカットを引き延ばして鳴らしている状態。 */
  trailing: boolean;
}

export class Player {
  private sequence: Sequence | null = null;
  private raf = 0;
  private lastNow = 0;
  private timeListeners = new Set<Listener>();
  private stateListeners = new Set<Listener>();
  /** 毎フレーム呼ぶ購読。React の再描画を挟まず DOM を直接書き換える用。 */
  private frameListeners = new Set<(time: number) => void>();
  private onFrame: ((time: number) => void) | null = null;
  /** クリップごとの最後にシークした時刻（連発防止）。 */
  private lastSeekAt = new Map<string, number>();

  time = 0;
  playing = false;
  loop = false;
  duration = 0;

  start(onFrame: (time: number) => void) {
    this.onFrame = onFrame;
    if (this.raf) return;
    this.lastNow = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - this.lastNow) / 1000);
      this.lastNow = now;
      if (this.playing) {
        let next = this.time + dt;
        if (next >= this.duration) {
          if (this.loop && this.duration > 0) {
            next = 0;
          } else {
            next = this.duration;
            this.playing = false;
            this.emitState();
            this.emitTime();
          }
        }
        this.time = next;
      }
      this.sync();
      this.onFrame?.(this.time);
      // 再生中の時刻表示は React を通さない。毎フレーム再描画すると
      // それだけでコマ落ちの原因になるため。
      this.frameListeners.forEach((fn) => fn(this.time));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** シーケンスが変わるたびに呼ぶ。再生要素の生成 / 破棄と尺の更新。 */
  update(sequence: Sequence) {
    this.sequence = sequence;
    this.duration = sequenceDuration(sequence);
    if (this.time > this.duration) this.time = this.duration;

    const live = new Set<string>();
    for (const clip of sequence.clips) {
      if (clip.kind === 'video' || clip.kind === 'audio') {
        live.add(clip.id);
        mediaRegistry.mediaElement(clip.id, clip.mediaId);
      }
    }
    for (const key of mediaRegistry.activeKeys()) {
      if (!live.has(key)) mediaRegistry.releaseElement(key);
    }
  }

  play() {
    if (!this.sequence || this.duration <= 0) return;
    audioGraph.ensure();
    if (this.time >= this.duration - 0.01) this.time = 0;
    this.playing = true;
    this.lastNow = performance.now();
    this.emitState();
    this.emitTime();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.pauseAll();
    this.emitState();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(time: number) {
    this.time = Math.max(0, Math.min(this.duration, time));
    this.emitTime();
  }

  nudge(delta: number) {
    this.seek(this.time + delta);
  }

  setLoop(on: boolean) {
    this.loop = on;
    this.emitState();
  }

  private pauseAll() {
    const sequence = this.sequence;
    if (!sequence) return;
    for (const clip of sequence.clips) {
      const el = mediaRegistry.mediaElement(clip.id, clip.mediaId);
      if (el && !el.paused) el.pause();
    }
  }

  /** その時刻に鳴っている / 映っているクリップ（トランジション中の前カットを含む）。 */
  activeClips(time = this.time): ActiveClip[] {
    const sequence = this.sequence;
    if (!sequence) return [];
    const out: ActiveClip[] = [];
    for (const track of sequence.tracks) {
      if (track.kind === 'text') continue;
      const current = clipAtTime(sequence, track.id, time);
      if (!current) continue;
      out.push({ clip: current, trailing: false });
      const transition = current.transitionIn;
      if (
        track.kind === 'video' &&
        transition.type !== 'none' &&
        transition.duration > 0 &&
        time < current.start + transition.duration
      ) {
        const previous = previousAdjacent(sequence, current);
        if (previous) out.push({ clip: previous, trailing: true });
      }
    }
    return out;
  }

  private targetSourceTime(clip: Clip, time: number): number {
    const asset = mediaRegistry.get(clip.mediaId);
    const raw = sourceTimeAt(clip, time);
    if (!clip.loop || !asset || asset.duration <= 0) return raw;
    const span = Math.max(0.1, asset.duration - clip.sourceIn);
    return clip.sourceIn + ((raw - clip.sourceIn) % span);
  }

  private sync() {
    const sequence = this.sequence;
    if (!sequence) return;

    const active = new Map<string, ActiveClip>();
    for (const entry of this.activeClips()) active.set(entry.clip.id, entry);

    // トラックは毎フレーム find で探すと クリップ数 × トラック数 の走査になる。
    const trackById = new Map(sequence.tracks.map((t) => [t.id, t]));

    for (const clip of sequence.clips) {
      if (clip.kind === 'text' || clip.kind === 'image') continue;
      const el = mediaRegistry.mediaElement(clip.id, clip.mediaId);
      if (!el) continue;
      const entry = active.get(clip.id);

      if (!entry) {
        if (!el.paused) el.pause();
        audioGraph.setGain(el, 0);
        const distance = clip.start - this.time;
        if (distance > 0 && distance < PREROLL && Math.abs(el.currentTime - clip.sourceIn) > 0.1) {
          try {
            el.currentTime = clip.sourceIn;
          } catch {
            /* メタデータ待ち */
          }
        }
        continue;
      }

      const track = trackById.get(clip.trackId);
      const target = this.targetSourceTime(clip, this.time);
      const speed = Math.max(0.0625, Math.min(16, clip.speed || 1));

      const env = fadeEnvelope(this.time - clip.start, clip.duration, clip.fadeIn, clip.fadeOut);
      const silent = clip.muted || track?.muted || entry.trailing;
      audioGraph.setGain(el, silent ? 0 : clip.volume * env);

      if (this.playing) {
  const drift = el.currentTime - target;
  const distance = Math.abs(drift);
  const now = performance.now();
  const cooldownActive =
    now - (this.lastSeekAt.get(clip.id) ?? -Infinity) < SEEK_COOLDOWN_MS;

  if (distance > DRIFT_SOFT_LIMIT && !cooldownActive) {
    // 大きく飛んでいて、かつシークしてよいタイミングのときだけシーク。
    this.lastSeekAt.set(clip.id, now);
    try {
      el.currentTime = target;
    } catch {
      /* noop */
    }
    if (el.playbackRate !== speed) el.playbackRate = speed;
  } else if (distance > DRIFT_IGNORE) {
    // シークできない/しない間も、等倍に戻さず補正をかけ続ける。
    // ズレが大きいほど強くかけることで、ソフトリミットに達する前に収束させる。
    const strength = Math.min(1, distance / DRIFT_SOFT_LIMIT);
    const rate =
      CATCH_UP_RATE_MIN + (CATCH_UP_RATE_MAX - CATCH_UP_RATE_MIN) * strength;
    const adjusted = speed * (drift < 0 ? 1 + rate : 1 - rate);
    if (el.playbackRate !== adjusted) el.playbackRate = adjusted;
  } else if (el.playbackRate !== speed) {
    el.playbackRate = speed;
  }

  if (el.paused) void el.play().catch(() => undefined);
}

      } else {
        if (!el.paused) el.pause();
        if (el.playbackRate !== speed) el.playbackRate = speed;
        if (Math.abs(el.currentTime - target) > 0.02) {
          try {
            el.currentTime = target;
          } catch {
            /* noop */
          }
        }
      }
    }
  }

  /** renderFrame へ渡す描画ソース。 */
  renderSources(): RenderSources {
    return {
      frameFor: (clip) => {
        if (clip.kind === 'image') {
          const img = mediaRegistry.imageElement(clip.mediaId);
          return img?.complete ? img : null;
        }
        if (clip.kind !== 'video') return null;
        const el = mediaRegistry.mediaElement(clip.id, clip.mediaId);
        return el instanceof HTMLVideoElement && el.readyState >= 2 ? el : null;
      },
      sizeFor: (clip) => {
        const asset = mediaRegistry.get(clip.mediaId);
        return asset ? { width: asset.width, height: asset.height } : null;
      },
    };
  }

  // --- React 連携（useSyncExternalStore） ---
  subscribeTime = (fn: Listener) => {
    this.timeListeners.add(fn);
    return () => this.timeListeners.delete(fn);
  };

  /** 毎フレームの通知。React の state ではなく DOM を直接更新する用途に使う。 */
  subscribeFrame = (fn: (time: number) => void) => {
    this.frameListeners.add(fn);
    return () => {
      this.frameListeners.delete(fn);
    };
  };

  subscribeState = (fn: Listener) => {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  };

  getTime = () => this.time;
  getPlaying = () => this.playing;

  private emitTime() {
    this.timeListeners.forEach((fn) => fn());
  }

  private emitState() {
    this.stateListeners.forEach((fn) => fn());
  }
}

export const player = new Player();
