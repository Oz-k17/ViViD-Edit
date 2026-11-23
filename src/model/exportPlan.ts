/**
 * 書き出しの段取りの計算: 残り時間の見積もりと、ファイルの大きさから画質を決めること。
 *
 * どちらも openreel-video（MIT, Augustus Otu and Contributors）の
 * `export/progress-estimator.ts` と `export/compression.ts` から持ってきた（式と数値はそのまま、言葉を日本語にした）。
 * 画面にも書き出しの部品にも依らない（`npm run test:model` で、時計を差し替えて試せる）。
 */

// ---------- 残り時間 ----------

export interface EtaSnapshot {
  /** 0〜1。戻らない。 */
  fraction: number;
  elapsedSeconds: number;
  /** 残りの秒。まだ言えるほど進んでいなければ null。 */
  etaSeconds: number | null;
}

/**
 * 正直な残り時間。
 * - 進み具合は戻らない
 * - 始まってすぐ（2 秒未満・2% 未満）は言わない（当てずっぽうを出さない）
 * - 直近 10 秒の速さと、全体の速さを混ぜる（遅くなった・速くなったにはついていき、揺れは抑える）
 * - 表示は実時間で数え下げ、新しい見積もりへ 4 割ずつ寄せる（数字が跳ねない）
 */
export class ProgressEstimator {
  private readonly windowMs = 10_000;
  private readonly minElapsedMs = 2_000;
  private readonly minFraction = 0.02;
  private startedAt: number | null = null;
  private samples: { t: number; f: number }[] = [];
  private fraction = 0;
  private shownEta: number | null = null;
  private shownAt = 0;

  private readonly now: () => number;

  // Node が .ts をそのまま読めるよう、引数で中身を持つ書き方（parameter property）は使わない。
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  start(): void {
    this.startedAt = this.now();
    this.samples = [{ t: this.startedAt, f: 0 }];
    this.fraction = 0;
    this.shownEta = null;
    this.shownAt = this.startedAt;
  }

  /** 進み具合の知らせの合間に呼ぶ: 前に出した残りを、経った時間だけ数え下げる（終わるまでは 1 秒より下げない）。 */
  tick(): EtaSnapshot {
    if (this.startedAt === null) this.start();
    const t = this.now();
    const base = { fraction: this.fraction, elapsedSeconds: (t - (this.startedAt as number)) / 1000 };
    if (this.fraction >= 1) return { ...base, etaSeconds: 0 };
    if (this.shownEta === null) return { ...base, etaSeconds: null };
    return { ...base, etaSeconds: Math.max(1, this.shownEta - (t - this.shownAt) / 1000) };
  }

  update(rawFraction: number): EtaSnapshot {
    if (this.startedAt === null) this.start();
    const startedAt = this.startedAt as number;
    const t = this.now();
    const clamped = Number.isFinite(rawFraction) ? Math.min(1, Math.max(0, rawFraction)) : this.fraction;
    this.fraction = Math.max(this.fraction, clamped);
    const f = this.fraction;
    this.samples.push({ t, f });
    const cutoff = t - this.windowMs;
    while (this.samples.length > 2 && this.samples[1].t < cutoff) this.samples.shift();

    const elapsedMs = t - startedAt;
    const base = { fraction: f, elapsedSeconds: elapsedMs / 1000 };
    if (f >= 1) {
      this.shownEta = 0;
      this.shownAt = t;
      return { ...base, etaSeconds: 0 };
    }
    if (elapsedMs < this.minElapsedMs || f < this.minFraction) return { ...base, etaSeconds: null };

    const overallRate = f / elapsedMs;
    const oldest = this.samples[0];
    const windowMs = t - oldest.t;
    const recentRate = windowMs > 0 ? (f - oldest.f) / windowMs : 0;
    const w = Math.min(1, windowMs / this.windowMs) ** 2;
    const rate = recentRate > 0 ? w * recentRate + (1 - w) * overallRate : 0.5 * overallRate;
    if (!(rate > 0)) return { ...base, etaSeconds: null };
    const target = (1 - f) / rate / 1000;

    let eta: number;
    if (this.shownEta === null) {
      eta = target;
    } else {
      const counted = Math.max(0, this.shownEta - (t - this.shownAt) / 1000);
      eta = counted + 0.4 * (target - counted);
    }
    this.shownEta = eta;
    this.shownAt = t;
    return { ...base, etaSeconds: Math.max(0, eta) };
  }
}

/** 「残り 約 2 分 10 秒」。まだ分からなければ「残り時間を見積もっています」。 */
export function formatEta(etaSeconds: number | null): string {
  if (etaSeconds === null || !Number.isFinite(etaSeconds)) return '残り時間を見積もっています';
  const total = Math.max(0, Math.round(etaSeconds));
  if (total < 5) return 'まもなく終わります';
  if (total < 60) return `残り 約 ${Math.round(total / 5) * 5} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) return `残り 約 ${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
  return `残り 約 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

// ---------- 大きさから決める ----------

const MB = 1024 * 1024;

/** よく使う上限。送る先で決まっている大きさ。 */
export const TARGET_SIZE_PRESETS: { key: string; label: string; mb: number }[] = [
  { key: 'discord', label: 'Discord（10MB）', mb: 10 },
  { key: 'whatsapp', label: 'WhatsApp（16MB）', mb: 16 },
  { key: 'mail', label: 'メール添付（25MB）', mb: 25 },
  { key: 'x', label: 'X の無料（512MB）', mb: 512 },
];

/** 入れ物（MP4 / WebM）の分の余白。 */
const CONTAINER_OVERHEAD = 1.02;
/**
 * 映像はビットレートを「平均」として守るので、場面によって少し超える。
 * 上限ちょうどを狙うと超えることがあるので、5% 手前を狙う（ViViD で足した分）。
 */
const SAFETY = 0.95;
const MIN_VIDEO_BPS = 150_000;
/** 1 画素 1 コマあたりのビット数の下限。これを割ると、ブロックが目立ち始める。 */
const BITRATE_FLOOR_BPP = 0.035;

export interface TargetSizePlan {
  /** 映像のビットレート（bps）。 */
  videoBps: number;
  /** 見込みの大きさ（バイト）。 */
  bytes: number;
  /** この大きさなら、どの画質（縦か横の短い側 1080 / 720 / 480）にするとよいか。 */
  suggestedQuality: number;
  /** いまの画質のままだと粗くなりすぎるか。 */
  tooTightAtCurrent: boolean;
}

/**
 * 目標の大きさ（MB）に収まる映像のビットレートを出す。音は ViViD の書き出しと同じ 128kbps として引く。
 * 画質の段（1080 / 720 / 480）ごとに 1 画素あたりのビット数を見て、粗くなりすぎない段を薦める。
 */
export function planTargetSize(input: {
  targetMb: number;
  durationSec: number;
  fps: number;
  hasAudio: boolean;
  /** 画質の段ごとの出力の大きさ（`exportSize()` と同じもの）。大きい順に並べる。 */
  tiers: { quality: number; width: number; height: number }[];
  currentQuality: number;
}): TargetSizePlan {
  const duration = Math.max(0.1, input.durationSec);
  const audioBps = input.hasAudio ? 128_000 : 0;
  const totalBps = (Math.max(0.1, input.targetMb) * MB * 8 * SAFETY) / duration / CONTAINER_OVERHEAD;
  const videoBps = Math.max(MIN_VIDEO_BPS, Math.round(totalBps - audioBps));
  const bpp = (tier: { width: number; height: number }) => videoBps / (tier.width * tier.height * Math.max(1, input.fps));
  const suggested = input.tiers.find((tier) => bpp(tier) >= BITRATE_FLOOR_BPP) ?? input.tiers[input.tiers.length - 1];
  const current = input.tiers.find((tier) => tier.quality === input.currentQuality) ?? suggested;
  return {
    videoBps,
    bytes: Math.round((((videoBps + audioBps) * duration) / 8) * CONTAINER_OVERHEAD),
    suggestedQuality: suggested.quality,
    tooTightAtCurrent: bpp(current) < BITRATE_FLOOR_BPP,
  };
}
