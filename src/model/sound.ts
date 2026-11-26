/**
 * 音の仕上げ: 声をくっきり・低い唸りとハムを消す・BGM を声の間だけ下げる（ダッキング）。
 *
 * 組み立て方は openreel-video（MIT, Augustus Otu and Contributors）の Essential Sound に倣った。
 * 声には「80Hz より下を切る + 3kHz（言葉の聞き取りやすさの帯）を持ち上げる + 軽く圧縮」、
 * BGM には「声と重なる 1.5kHz 辺りを少し下げる」。数値もそちらと同じにしてある。
 * ダッキングの決め方は `lab/auto-cut/src/ducking.ts`（attack・hold・release）をそのまま持ってきた。
 *
 * ここは画面にも WebAudio にも依らない「何を掛けるか」の計算だけ（`npm run test:model` で試せる）。
 * 実際の音の部品を組むのは `engine/soundChain.ts`。プレビューも書き出しも同じ並びを使うので、
 * 聞いた音と書き出した音が食い違わない。
 *
 * openreel の「広い帯域のノイズ除去（スペクトルで引く方式）」は入れていない。
 * 実時間の部品（BiquadFilter など）では作れず、プレビューで鳴らせないため。
 * 代わりに、原因のはっきりした 2 つ（エアコンや風の低い唸り・電源のハム）だけを実時間で消す。
 */

export type SoundRole = 'voice' | 'music';

export interface SoundFx {
  /** 声か BGM か。未定義なら何もしない（いままでどおり）。 */
  role?: SoundRole;
  /** 声をくっきり（声）／声の帯を空ける（BGM）の強さ。0〜1。0 なら掛けない。 */
  clarity?: number;
  /** エアコン・風・机の振動のような、100Hz より下の唸りを切る。 */
  rumble?: boolean;
  /** 電源のハム（ブーン）を消す。東日本は 50Hz、西日本は 60Hz。 */
  hum?: 50 | 60 | null;
  /** BGM だけ: 声が鳴っているあいだ下げる量（dB, 正の数）。0 / 未定義なら下げない。 */
  duckDb?: number;
}

export const SOUND_ROLE_LABELS: Record<SoundRole, string> = {
  voice: '声・話し声',
  music: 'BGM・音楽',
};

/** 1 つの音の部品。WebAudio の BiquadFilter / DynamicsCompressor にそのまま渡せる値。 */
export type SoundStage =
  | { kind: 'filter'; type: 'highpass' | 'peaking' | 'notch'; frequency: number; gain: number; q: number }
  | { kind: 'compressor'; threshold: number; ratio: number; attack: number; release: number; knee: number };

const round = (v: number, digits = 2) => Number(v.toFixed(digits));

/** 掛ける部品を、掛ける順に。何も掛けないなら空。 */
export function planSoundChain(fx: SoundFx | null | undefined): SoundStage[] {
  if (!fx || !fx.role) return [];
  const stages: SoundStage[] = [];
  // 直す（唸り・ハム）→ 整える（くっきり）の順。先に濁りを取らないと、持ち上げたときに濁りも上がる。
  if (fx.rumble) stages.push({ kind: 'filter', type: 'highpass', frequency: 100, gain: 0, q: 0.9 });
  if (fx.hum) {
    // 基音と、目立つ倍音 2 つ。細い切り込み（Q が高い）なので、声そのものはほとんど削らない。
    for (const n of [1, 2, 3]) stages.push({ kind: 'filter', type: 'notch', frequency: fx.hum * n, gain: 0, q: 30 });
  }
  const amount = Math.max(0, Math.min(1, fx.clarity ?? 0));
  if (amount > 0) {
    if (fx.role === 'voice') {
      if (!fx.rumble) stages.push({ kind: 'filter', type: 'highpass', frequency: 80, gain: 0, q: 0.707 });
      stages.push({ kind: 'filter', type: 'peaking', frequency: 3000, gain: round(1 + 4 * amount), q: 1 });
      stages.push({ kind: 'compressor', threshold: -20, ratio: 2.5, attack: 0.01, release: 0.15, knee: 30 });
    } else {
      stages.push({ kind: 'filter', type: 'peaking', frequency: 1500, gain: -round(1 + 5 * amount), q: 0.8 });
    }
  }
  return stages;
}

/** 部品の並びを、同じかどうか比べられる文字列に（プレビューで毎コマ組み直さないため）。 */
export function soundChainKey(stages: readonly SoundStage[]): string {
  return stages
    .map((s) =>
      s.kind === 'filter' ? `${s.type}:${s.frequency}:${s.gain}:${s.q}` : `comp:${s.threshold}:${s.ratio}:${s.attack}:${s.release}:${s.knee}`,
    )
    .join('|');
}

// ---------- ダッキング（lab/auto-cut/src/ducking.ts） ----------

export interface DuckOptions {
  /** 声があるときに何 dB 下げるか（負の値）。 */
  duckDb: number;
  /** 下げきるまでの時間（秒）。短すぎると「ヒュッ」と鳴る。 */
  attack: number;
  /** 戻しきるまでの時間（秒）。 */
  release: number;
  /** 声が途切れてから戻し始めるまでの待ち（秒）。息継ぎのたびに戻ると落ち着かない。 */
  hold: number;
  /** 声とみなすしきい値（dBFS）。 */
  thresholdDb: number;
}

export const DEFAULT_DUCK: DuckOptions = {
  duckDb: -12,
  attack: 0.12,
  release: 0.45,
  hold: 0.3,
  thresholdDb: -45,
};

export interface GainPoint {
  time: number;
  gain: number;
}

/** 声の大きさの列（`analysis/audio/loudness.ts` の LoudnessTrack と同じ形）。 */
export interface VoiceLevels {
  hop: number;
  db: Float32Array;
  duration: number;
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** 声が鳴っている区間。hold のぶん後ろへ伸ばしてから繋ぐので、短い息継ぎは 1 区間にまとまる。 */
export function voiceRanges(voice: VoiceLevels, thresholdDb: number, hold: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < voice.db.length; i += 1) {
    if (voice.db[i] <= thresholdDb) continue;
    const start = i * voice.hop;
    const end = Math.min(voice.duration, (i + 1) * voice.hop + hold);
    const last = out[out.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

/** BGM に掛ける音量の折れ線（タイムラインの秒）。2 点の間は直線で繋ぐ。 */
export function planDucking(voice: VoiceLevels, options: Partial<DuckOptions> = {}): GainPoint[] {
  const opts = { ...DEFAULT_DUCK, ...options };
  const ducked = dbToGain(opts.duckDb);
  const ranges = voiceRanges(voice, opts.thresholdDb, opts.hold);
  if (ranges.length === 0) return [{ time: 0, gain: 1 }];

  const points: GainPoint[] = [];
  const push = (time: number, gain: number) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last.time - time) < 1e-4) last.gain = gain;
    else points.push({ time: Math.max(0, time), gain });
  };

  push(0, 1);
  for (const range of ranges) {
    // 下げ始めは「声より attack だけ前」。声が出た瞬間にはもう下がりきっている。
    push(Math.max(points[points.length - 1].time, range.start - opts.attack), points[points.length - 1].gain);
    push(range.start, ducked);
    push(range.end, ducked);
    push(range.end + opts.release, 1);
  }
  return points;
}

/** 折れ線の、時刻 t の音量。 */
export function duckGainAt(points: readonly GainPoint[], t: number): number {
  if (points.length === 0) return 1;
  if (t <= points[0].time) return points[0].gain;
  for (let i = 1; i < points.length; i += 1) {
    const b = points[i];
    if (t > b.time) continue;
    const a = points[i - 1];
    const span = b.time - a.time;
    return span <= 0 ? b.gain : a.gain + (b.gain - a.gain) * ((t - a.time) / span);
  }
  return points[points.length - 1].gain;
}

/**
 * 声のクリップごとの大きさの列を、タイムライン全体の 1 本に重ねる（同じ時刻はいちばん大きいほう）。
 * `at` はそのクリップの頭のタイムラインの秒。
 */
export function mergeVoiceLevels(
  parts: readonly { at: number; levels: VoiceLevels }[],
  duration: number,
  hop = 0.02,
): VoiceLevels {
  const frames = Math.max(1, Math.ceil(duration / hop));
  const db = new Float32Array(frames).fill(-100);
  for (const { at, levels } of parts) {
    for (let i = 0; i < levels.db.length; i += 1) {
      const t = at + i * levels.hop;
      const j = Math.floor(t / hop);
      if (j < 0 || j >= frames) continue;
      if (levels.db[i] > db[j]) db[j] = levels.db[i];
    }
  }
  return { hop, db, duration };
}

/** ダッキングを掛ける BGM のクリップか。 */
export function ducks(fx: SoundFx | null | undefined): boolean {
  return fx?.role === 'music' && (fx.duckDb ?? 0) > 0;
}
