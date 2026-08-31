/**
 * 再生エンジン。
 * 壁時計（performance.now）を基準にタイムライン時刻を進め、
 * 各クリップの <video> をそこへ追従させる。映像側の currentTime を基準にしないのは、
 * クリップをまたぐたびに時間が飛んで同期が崩れるため。
 */

import { audioGraph, fadeEnvelope } from './audio';
import { mediaRegistry } from './media';
import type { RenderContext } from './renderer';
import { clipAt, clipDuration, projectDuration, sourceTimeFor, type Clip, type Project } from '../types';

/** 追従がこれ以上ズレたらシークし直す（秒）。 */
const DRIFT_TOLERANCE = 0.28;
/** 次のクリップを何秒前から準備しておくか。 */
const PREROLL = 1.2;

type Listener = () => void;

export class Player {
  private project: Project | null = null;
  private raf = 0;
  private lastNow = 0;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<Listener>();
  private onFrame: ((time: number) => void) | null = null;

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
          }
        }
        this.time = next;
        this.emitTime();
      }
      this.sync();
      this.onFrame?.(this.time);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** プロジェクトが変わるたびに呼ぶ。要素の生成 / 破棄と尺の更新を行う。 */
  update(project: Project) {
    this.project = project;
    this.duration = projectDuration(project);
    if (this.time > this.duration) this.time = this.duration;

    const live = new Set<string>();
    for (const clip of project.clips) {
      if (clip.kind !== 'video') continue;
      live.add(clip.id);
      mediaRegistry.mediaElement(clip.id, clip.mediaId);
    }
    if (project.music) {
      live.add('music');
      mediaRegistry.mediaElement('music', project.music.mediaId);
    }
    for (const key of mediaRegistry.activeKeys()) {
      if (!live.has(key)) mediaRegistry.releaseElement(key);
    }
  }

  play() {
    if (!this.project || this.duration <= 0) return;
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

  nudge(deltaSeconds: number) {
    this.seek(this.time + deltaSeconds);
  }

  setLoop(on: boolean) {
    this.loop = on;
    this.emitState();
  }

  private pauseAll() {
    const project = this.project;
    if (!project) return;
    for (const clip of project.clips) {
      const el = clip.kind === 'video' ? mediaRegistry.mediaElement(clip.id, clip.mediaId) : null;
      if (el && !el.paused) el.pause();
    }
    if (project.music) {
      const el = mediaRegistry.mediaElement('music', project.music.mediaId);
      if (el && !el.paused) el.pause();
    }
  }

  private syncClip(clip: Clip, active: boolean) {
    const el = mediaRegistry.mediaElement(clip.id, clip.mediaId);
    if (!el) return;

    if (!active) {
      if (!el.paused) el.pause();
      audioGraph.setGain(el, 0);
      // 直前 / 直後のクリップは頭出ししておくと切り替わりが滑らか
      const distance = clip.start - this.time;
      if (distance > 0 && distance < PREROLL && Math.abs(el.currentTime - clip.in) > 0.1) {
        try {
          el.currentTime = clip.in;
        } catch {
          /* まだメタデータ待ち */
        }
      }
      return;
    }

    const target = sourceTimeFor(clip, this.time);
    const speed = Math.max(0.0625, Math.min(16, clip.speed || 1));
    if (el.playbackRate !== speed) el.playbackRate = speed;

    const dur = clipDuration(clip);
    const env = fadeEnvelope(this.time - clip.start, dur, clip.fadeIn, clip.fadeOut);
    audioGraph.setGain(el, clip.muted ? 0 : clip.volume * env);

    if (this.playing) {
      if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE) {
        try {
          el.currentTime = target;
        } catch {
          /* noop */
        }
      }
      if (el.paused) void el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.02) {
        try {
          el.currentTime = target;
        } catch {
          /* noop */
        }
      }
    }
  }

  private syncMusic(project: Project) {
    const music = project.music;
    if (!music) return;
    const el = mediaRegistry.mediaElement('music', music.mediaId);
    if (!el) return;
    const span = Math.max(0, music.out - music.in);
    const local = this.time - music.start;
    const inside = local >= 0 && (music.loop ? true : local < span);
    if (!inside || this.duration <= 0) {
      if (!el.paused) el.pause();
      audioGraph.setGain(el, 0);
      return;
    }
    const wrapped = music.loop && span > 0 ? local % span : local;
    const target = music.in + wrapped;
    const env = fadeEnvelope(wrapped, span, music.fadeIn, music.fadeOut);
    audioGraph.setGain(el, music.volume * env);
    if (this.playing) {
      if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE) el.currentTime = target;
      if (el.paused) void el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
    }
  }

  private sync() {
    const project = this.project;
    if (!project) return;
    const active = clipAt(project, this.time);
    for (const clip of project.clips) {
      if (clip.kind !== 'video') continue;
      this.syncClip(clip, active?.id === clip.id);
    }
    this.syncMusic(project);
  }

  /** renderFrame へ渡す描画ソース。 */
  renderContext(): RenderContext {
    return {
      frameFor: (clip) => {
        if (clip.kind === 'image') {
          const img = mediaRegistry.imageElement(clip.mediaId);
          return img?.complete ? img : null;
        }
        const el = mediaRegistry.mediaElement(clip.id, clip.mediaId);
        if (el instanceof HTMLVideoElement && el.readyState >= 2) return el;
        return null;
      },
      sizeFor: (clip) => {
        const asset = mediaRegistry.get(clip.mediaId);
        if (!asset) return null;
        return { width: asset.width, height: asset.height };
      },
    };
  }

  // --- React 連携（useSyncExternalStore） ---
  subscribeTime = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  subscribeState = (fn: Listener) => {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  };

  getTime = () => this.time;
  getPlaying = () => this.playing;

  private emitTime() {
    this.listeners.forEach((fn) => fn());
  }

  private emitState() {
    this.stateListeners.forEach((fn) => fn());
  }
}

export const player = new Player();
