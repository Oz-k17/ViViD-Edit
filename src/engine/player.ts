import { audioGraph } from './audio';
import { mediaRegistry } from './media';
import { fadeEnvelope, type RenderSources } from './renderer';
import { clipAtTime, previousAdjacent, sequenceDuration } from '../model/ops';
import { sourceTimeAt, type Clip, type Sequence } from '../model/types';

/**
 * 映像・音声の追従。
 *
 * ズレるたびに単純にシークすると、シークがキーフレームまで戻ってデコードし直すぶん
 * さらに遅れ、また閾値を超えて再びシーク…という悪循環に入る（重い素材ほど起きやすい）。
 * また、生の currentTime を毎フレームそのまま判定に使うと1フレームのジッターにも
 * 反応してしまい、閾値付近でモードがバタつく。
 *
 * そこで DriftController が
 *   1) ズレを平滑化(EMA)してから判定し、
 *   2) 状態遷移にヒステリシス（入る閾値と抜ける閾値を分ける）を持たせ、
 *   3) 音が鳴っているクリップと鳴っていないクリップでプロファイル（許容幅・補正強度）を分け、
 *   4) 適用する playbackRate 自体も毎フレーム目標値へ少しずつ近づける（lerp）
 * ことで、シーク連発による映像のカクつきと、playbackRate の頻繁な書き換えによる
 * 音声のプチノイズの両方を抑える。
 */

/** シーク連発を防ぐ初期クールダウン（ミリ秒）。連発するほど自動で伸びる。 */
const SEEK_COOLDOWN_MS = 700;
/** クールダウンの上限（ミリ秒）。 */
const SEEK_COOLDOWN_MAX_MS = 4000;
/** クールダウンが伸びていく倍率。 */
const SEEK_COOLDOWN_BACKOFF = 1.6;
/** ズレの平滑化の重み。大きいほど反応が早いがジッターも拾う。 */
const DRIFT_SMOOTHING = 0.25;
/** playbackRate 書き換えを間引く最小差分。 */
const RATE_EPSILON = 0.005;
/** currentTime 書き換えを間引く最小差分（一時停止中の頭出し用）。 */
const SEEK_EPSILON = 0.02;
/**
 * シーク直後にミュートしておく時間（ミリ秒）。
 * シークはデコード位置を強制的に飛ばすため、直前・直後の音声データが不連続になり、
 * 必ず「プツッ」というクリックノイズが乗る。これはズレの補正がどれだけ賢くなっても
 * 原理的に避けられないので、シークの瞬間だけ音量を落として聞こえなくする。
 */
const SEEK_DUCK_MS = 160;
/** 次のクリップを何秒前から頭出ししておくか。 */
const PREROLL = 1.2;
/**
 * 再生開始時にデコードの立ち上がりを待つ上限（ミリ秒）。
 * play() を呼んだ瞬間から壁時計を進めてしまうと、<video> の再生開始（バッファ待ち含む）は
 * 非同期でそれより遅れるため、重い素材ほど開始直後だけ大きなズレが生じて
 * DriftController がいきなり補正モードに入り、カクつく。そこで実際に描画できる状態
 * （readyState が十分）になるまで、この上限まで壁時計の進行を待つ。
 */
const STARTUP_GRACE_MS = 600;

type DriftProfile = 'audible' | 'silent';

interface DriftBounds {
  /** これを超えたら補正モードに入る。 */
  enterCorrect: number;
  /** これを下回ったら補正モードを抜ける（enterCorrect より小さい＝ヒステリシス）。 */
  exitCorrect: number;
  /** これを超えたら強制シークを検討する。 */
  enterResync: number;
  /** これを下回ったらシークモードを抜ける。 */
  exitResync: number;
  /** 速度補正の最大強度（比率）。 */
  maxRate: number;
  /** 目標 playbackRate への毎フレームの近づき方（0-1、大きいほど速く追従）。 */
  lerp: number;
}

const PROFILE_BOUNDS: Record<DriftProfile, DriftBounds> = {
  // 音が鳴っているクリップ：音の破綻を最優先で避ける。ズレの許容は広め、補正は緩やか。
  // 速度補正は 1% までにしてある。数 % 動かすと速度そのものと音程の変化が聞き取れてしまい、
  // 「ズレを直すための補正」が「周期的なカクつき」として出てしまうため。
  audible: {
    enterCorrect: 0.12,
    exitCorrect: 0.05,
    enterResync: 1,
    exitResync: 0.3,
    maxRate: 0.01,
    lerp: 0.05,
  },
  // 無音のクリップ：見た目のズレを詰めることを優先。多少強引な補正も許容。
  silent: {
    enterCorrect: 0.05,
    exitCorrect: 0.02,
    enterResync: 0.4,
    exitResync: 0.12,
    maxRate: 0.12,
    lerp: 0.25,
  },
};

/** 1クリップぶんの同期状態を保持し、毎フレームの目標 playbackRate / シーク要否を決める。 */
class DriftController {
  private smoothed = 0;
  private mode: 'locked' | 'correcting' | 'resyncing' = 'locked';
  private lastSeekAt = -Infinity;
  private seekCooldown = SEEK_COOLDOWN_MS;
  appliedRate = 1;

  constructor(private profile: DriftProfile) {}

  setProfile(profile: DriftProfile) {
    this.profile = profile;
  }

  /**
   * @param raw current - target（正なら進みすぎ、負なら遅れている）
   * @param baseSpeed そのクリップの基準速度（clip.speed）
   * @param now performance.now()
   * @returns 適用すべき playbackRate と、必要ならシークすべきという指示
   */
  update(raw: number, baseSpeed: number, now: number): { rate: number; shouldSeek: boolean } {
    const b = PROFILE_BOUNDS[this.profile];

    this.smoothed += (raw - this.smoothed) * DRIFT_SMOOTHING;
    const distance = Math.abs(this.smoothed);

    if (this.mode === 'locked' && distance > b.enterCorrect) this.mode = 'correcting';
    if (this.mode === 'correcting' && distance < b.exitCorrect) this.mode = 'locked';
    if (distance > b.enterResync) this.mode = 'resyncing';
    if (this.mode === 'resyncing' && distance < b.exitResync) this.mode = 'correcting';

    let shouldSeek = false;
    if (this.mode === 'resyncing' && now - this.lastSeekAt > this.seekCooldown) {
      shouldSeek = true;
      this.lastSeekAt = now;
      // 立て続けにシークが必要になる = 環境がデコードに追いついていない、という判断で
      // クールダウンを段階的に伸ばす（指数バックオフ）。安定したらリセットする。
      this.seekCooldown = Math.min(SEEK_COOLDOWN_MAX_MS, this.seekCooldown * SEEK_COOLDOWN_BACKOFF);
      this.smoothed = 0;
      this.mode = 'correcting';
    } else if (this.mode === 'locked') {
      this.seekCooldown = SEEK_COOLDOWN_MS;
    }

    const desired =
      this.mode === 'correcting'
        ? baseSpeed * (1 - Math.sign(this.smoothed) * Math.min(b.maxRate, distance))
        : baseSpeed;

    // スナップさせず、目標値へ毎フレーム少しずつ近づける。
    this.appliedRate += (desired - this.appliedRate) * b.lerp;
    return { rate: this.appliedRate, shouldSeek };
  }

  reset(rate = 1) {
    this.smoothed = 0;
    this.mode = 'locked';
    this.appliedRate = rate;
  }
}

type Listener = () => void;

interface ActiveClip {
  clip: Clip;
  /** トランジションで前のカットを引き延ばして鳴らしている状態。 */
  trailing: boolean;
  /**
   * trailing のときのみ有効。次クリップとのトランジション進捗（0=開始, 1=完了）。
   * 前クリップの音量をこの進捗に応じてフェードアウトさせるために使う。
   */
  transitionProgress?: number;
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
  /** クリップごとのドリフト補正状態。 */
  private drift = new Map<string, DriftController>();
  /** クリップごとの「この時刻までミュートしておく」（シーク直後のクリックノイズ隠し用）。 */
  private duckUntil = new Map<string, number>();
  /** 再生開始直後、実際に再生できる状態になるまで壁時計の進行を待っている間 true。 */
  private starting = false;
  private startingSince = 0;
  /**
   * 時刻の基準にしているクリップ（映像／音声）の id。
   * このクリップだけは速度補正もシークもしない。基準そのものを動かしたら意味がないため。
   */
  private masterId: string | null = null;
  /** 手動シークの直後だけ、全要素の位置を強制的に合わせ直す。 */
  private needsAlign = false;

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
      if (this.playing && this.starting) {
        // まだ実際に再生できる状態になっていない間は壁時計を止める。sync() は毎フレーム
        // 呼び続けるので、その中で el.play() の呼び出し自体は進む。
        if (this.readyToAdvance() || now - this.startingSince > STARTUP_GRACE_MS) {
          this.starting = false;
          for (const controller of this.drift.values()) controller.reset();
        }
      } else if (this.playing) {
        // 映像／音声が鳴っている間は、その要素自身の時計を基準にする（下の masterTime を参照）。
        // 鳴っていない区間（テロップだけなど）だけ壁時計で進める。
        let next = this.masterTime() ?? this.time + dt;
        if (next >= this.duration) {
          if (this.loop && this.duration > 0) {
            next = 0;
            // 先頭へ戻るときは、基準クリップも含めて頭出しし直す。
            this.needsAlign = true;
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
      if (!live.has(key)) {
        mediaRegistry.releaseElement(key);
        this.drift.delete(key);
        this.duckUntil.delete(key);
      }
    }
  }

  play() {
    if (!this.sequence || this.duration <= 0) return;
    audioGraph.ensure();
    if (this.time >= this.duration - 0.01) this.time = 0;
    this.playing = true;
    this.starting = true;
    // 再生開始時も、基準クリップを含めて位置を合わせてから走り出す。
    this.needsAlign = true;
    this.startingSince = performance.now();
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
    // 手動シーク後は、蓄積していたドリフト補正の状態を持ち越さない。
    for (const controller of this.drift.values()) controller.reset();
    // 再生中のシークでは、基準クリップも含めて位置を合わせ直す必要がある
    // （基準は普段シークしないので、指示しないと元の位置へ引き戻されてしまう）。
    this.needsAlign = true;
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
        if (previous) {
          // トランジション内での経過割合。0=開始直後、1=完了直前。
          const progress = (time - current.start) / transition.duration;
          out.push({
            clip: previous,
            trailing: true,
            transitionProgress: Math.min(1, Math.max(0, progress)),
          });
        }
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

  /**
   * 時刻の基準にする要素を選ぶ。
   *
   * 壁時計を基準にして映像をそこへ追従させると、映像の時計（実際には音声ハードウェアの
   * 時計）と壁時計は必ず少しずつズレていくため、その差を毎回 playbackRate やシークで
   * 埋めることになる。実測では 1 秒あたり 20ms 近くズレるので、補正は止まらず、
   * 数秒周期で速度が上下し、音程が揺れ、ときどきシークで映像と音が飛ぶ。
   *
   * そこで向きを逆にする。鳴っている映像／音声の時計をそのまま正とし、
   * タイムラインの時刻をそこから逆算する。こうすると埋めるべき差が原理的に生じない。
   */
  private clockMaster(): { clip: Clip; el: HTMLMediaElement } | null {
    const sequence = this.sequence;
    if (!sequence) return null;
    for (const kind of ['video', 'audio'] as const) {
      for (const track of sequence.tracks) {
        if (track.kind !== kind) continue;
        const clip = clipAtTime(sequence, track.id, this.time);
        if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) continue;
        // ループ指定のクリップは currentTime が巻き戻るので基準にできない。
        if (clip.loop) continue;
        const el = mediaRegistry.mediaElement(clip.id, clip.mediaId);
        // シーク中や停止中でも「基準はこのクリップ」という選択自体は変えない。
        // ここで基準を手放すと、その隙にドリフト補正が基準クリップへ介入してしまい、
        // シーク → 補正 → またシーク…という取り合いになる。
        if (el) return { clip, el };
      }
    }
    return null;
  }

  /** 基準クリップの再生位置から、タイムライン上の時刻を逆算する。 */
  private masterTime(): number | null {
    const master = this.clockMaster();
    this.masterId = master?.clip.id ?? null;
    if (!master) return null;
    const { clip, el } = master;
    // 基準として「選ばれてはいる」が、いま時刻を読める状態ではない場合。
    // 壁時計へ一時的に任せる（基準の座は手放さない）。
    if (el.paused || el.seeking || el.readyState < 2) return null;
    const speed = Math.max(0.0625, Math.min(16, clip.speed || 1));
    const time = clip.start + (el.currentTime - clip.sourceIn) / speed;
    if (!Number.isFinite(time)) return null;
    // 要素がクリップの範囲外を指しているときは、まだ頭出し中などなので使わない。
    const end = clip.start + clip.duration;
    if (time < clip.start - 0.25 || time > end + 0.25) return null;
    // 時刻が戻ると見た目がガタつくので、進む方向にだけ従う。
    return Math.max(this.time, Math.min(end, time));
  }

  /** 再生開始直後のゲート用。現在アクティブなクリップが、途切れずに再生を始められそうか。 */
  private readyToAdvance(): boolean {
    for (const entry of this.activeClips()) {
      if (entry.clip.kind !== 'video' && entry.clip.kind !== 'audio') continue;
      const el = mediaRegistry.mediaElement(entry.clip.id, entry.clip.mediaId);
      // HAVE_FUTURE_DATA 未満は、次のフレームがまだ手元に無く止まって見える状態。
      if (!el || el.readyState < 3) return false;
    }
    return true;
  }

  private controllerFor(clipId: string, profile: DriftProfile): DriftController {
    let controller = this.drift.get(clipId);
    if (!controller) {
      controller = new DriftController(profile);
      this.drift.set(clipId, controller);
    } else {
      controller.setProfile(profile);
    }
    return controller;
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
        if (distance > 0 && distance < PREROLL && Math.abs(el.currentTime - clip.sourceIn) > SEEK_EPSILON) {
          try {
            el.currentTime = clip.sourceIn;
          } catch {
            /* メタデータ待ち */
          }
        }
        this.drift.get(clip.id)?.reset();
        this.duckUntil.delete(clip.id);
        continue;
      }

      const track = trackById.get(clip.trackId);
      const target = this.targetSourceTime(clip, this.time);
      const speed = Math.max(0.0625, Math.min(16, clip.speed || 1));

      const env = fadeEnvelope(this.time - clip.start, clip.duration, clip.fadeIn, clip.fadeOut);
      // ミュート判定は本来の mute 設定のみで行う。trailing（前カットの引き延ばし）は
      // 「鳴らし続ける」ための状態であり、ここで一律に silent 扱いにすると
      // トランジション開始の瞬間に前クリップの音量が 0 へスナップし、
      // クリックノイズ（プツッという音切れ）の原因になる。
      const silent = clip.muted || track?.muted;
      // trailing のときは、トランジションの進捗に応じて音量を滑らかにフェードアウトさせる。
      // 通常のクリップ（trailing=false）は 1 のまま、fadeOut に影響しない。
      const trailingFade = entry.trailing ? Math.max(0, 1 - (entry.transitionProgress ?? 1)) : 1;
      const baseGain = silent ? 0 : clip.volume * env * trailingFade;

      if (this.playing) {
        const now = performance.now();

        if (this.needsAlign) {
          // 手動シークや先頭へ戻ったときだけ、基準クリップも含めて位置を合わせ直す。
          // すでに合っているならシークしない。無駄にシークすると、その 1 回のために
          // 音が 160ms 途切れて「再生開始のたびにカクつく」ことになる。
          if (Math.abs(el.currentTime - target) > SEEK_EPSILON) {
            this.duckUntil.set(clip.id, now + SEEK_DUCK_MS);
            try {
              el.currentTime = target;
            } catch {
              /* noop */
            }
          }
          this.drift.get(clip.id)?.reset(speed);
          if (el.playbackRate !== speed) el.playbackRate = speed;
        } else if (clip.id === this.masterId) {
          // 基準にしているクリップは補正しない。ここを動かすと基準そのものが揺れる。
          this.drift.get(clip.id)?.reset(speed);
          if (el.playbackRate !== speed) el.playbackRate = speed;
        } else {
          const profile: DriftProfile = silent ? 'silent' : 'audible';
          const controller = this.controllerFor(clip.id, profile);
          const raw = el.currentTime - target;
          const { rate, shouldSeek } = controller.update(raw, speed, now);

          if (shouldSeek) {
            // シークの瞬間は必ずクリックノイズが乗るので、その前後をミュートして隠す。
            this.duckUntil.set(clip.id, now + SEEK_DUCK_MS);
            try {
              el.currentTime = target;
            } catch {
              /* noop */
            }
          }
          if (Math.abs(el.playbackRate - rate) > RATE_EPSILON) {
            el.playbackRate = rate;
          }
        }

        if (el.paused) void el.play().catch(() => undefined);

        const ducked = now < (this.duckUntil.get(clip.id) ?? 0);
        audioGraph.setGain(el, ducked ? 0 : baseGain);
      } else {
        audioGraph.setGain(el, baseGain);
        if (!el.paused) el.pause();
        if (el.playbackRate !== speed) el.playbackRate = speed;
        if (Math.abs(el.currentTime - target) > SEEK_EPSILON) {
          try {
            el.currentTime = target;
          } catch {
            /* noop */
          }
        }
        this.drift.get(clip.id)?.reset(speed);
      }
    }
    // 位置合わせは 1 巡で終わり。
    this.needsAlign = false;
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
      emojiFor: (mediaId) => {
        const img = mediaRegistry.imageElement(mediaId);
        return img?.complete ? img : null;
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
