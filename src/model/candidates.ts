/**
 * 見どころの候補を、複数の「信号」の重なりで選ぶ。
 *
 * 音の大きさだけで選ぶと、ゲームの音が大きいだけの所や、物音まで拾ってしまう。
 * 面白い場面は、だいたい複数のことが同時に起きている（声が大きくなる＋声が高くなる＋チャットが流れる＋「やばい」と言う）。
 * だから **2 つ以上の信号が、約 30 秒以内に重なった所だけ** を候補にする。1 つだけの所は出さない。
 *
 * 信号（どれも 1 秒ごとの「強さ」。1 以上で「起きている」）:
 * - loud  … 音が大きくなった（ふだんより何 dB 大きいか）
 * - voice … 声が高まった（音の高い成分が増えた。叫び・笑いで増える。音だけの目安）
 * - words … 盛り上がる言葉が出た（文字起こしのファイルがあるとき）
 * - chat  … チャットが盛り上がった（チャットのファイルがあるとき）
 *
 * 文字起こしやチャットが無い日は、あるものだけで選ぶ（無いことで落ちない）。
 * 候補には「どの信号が重なったか」を理由として付ける。
 *
 * 「良い / 違う」の評価も、ここで扱う。評価が溜まると、良いと言われた候補に多かった信号を重く見る。
 *
 * ここは計算だけ（画面にも音の読み込みにも依存しない）。
 */

import { baselineLevels, loudnessLift, type Highlight } from './highlights';

export type SignalKey = 'loud' | 'voice' | 'words' | 'chat';

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  loud: '音が大きくなった',
  voice: '声が高まった',
  words: '盛り上がる言葉',
  chat: 'チャットが盛り上がった',
};

export interface Signal {
  key: SignalKey;
  /** 1 秒ごとの強さ。1 以上で「起きている」。 */
  strength: Float32Array;
}

export interface Candidate extends Highlight {
  /** 重なった信号（強い順）。 */
  signals: SignalKey[];
  /** なぜ候補にしたか（1 行）。 */
  reason: string;
}

export interface CandidateOptions {
  /** 候補の長さ（秒）。 */
  length?: number;
  /** 候補の数。 */
  count?: number;
  /** 何個の信号が重なったら候補にするか。 */
  minSignals?: number;
  /** 重なりと見なす幅（秒）。この幅の中に、それぞれの信号の山があればよい。 */
  within?: number;
}

/** 山が候補のどこに来るか（頭からの割合）。highlights.ts と同じ。 */
const PEAK_AT = 0.65;
/** 頭と終わりを静かな所へずらす幅（秒）。 */
const SNAP = 3;
/** 1 つの信号が点数に効く上限（1 つだけ飛び抜けて強くても、重なりのほうを重く見る）。 */
const STRENGTH_CAP = 3;

function percentile(values: ArrayLike<number>, ratio: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * (sorted.length - 1))))];
}

/** 前後 `half` 秒の最大。 */
function slidingMax(values: Float32Array, half: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

// ---------------------------------------------------------------- 信号を作る

/** 音が大きくなった。ふだんより 3dB 大きければ「起きている」。 */
export function loudSignal(levels: Float32Array): Signal {
  return { key: 'loud', strength: Float32Array.from(loudnessLift(levels), (v) => v / 3) };
}

/**
 * 声が高まった。`bright` は 1 秒ごとの「高い成分の割合」（dB）。
 * ふだん（前後 5 分の中央値）より 4dB 高く、かつ音が鳴っている秒を「起きている」とする
 *（静かな所は、雑音だけで高い成分の割合が上がるので見ない）。
 */
export function voiceSignal(bright: Float32Array, levels: Float32Array): Signal {
  const n = Math.min(bright.length, levels.length);
  const B = Float32Array.from(bright.subarray(0, n), (v) => (Number.isFinite(v) ? v : -100));
  const base = baselineLevels(B);
  const floor = percentile(levels, 0.1);
  const loud = percentile(levels, 0.9);
  const soundingLine = floor + 0.5 * (loud - floor);
  const strength = new Float32Array(n);
  for (let i = 0; i < n; i++) strength[i] = levels[i] > soundingLine ? Math.max(0, B[i] - base[i]) / 4 : 0;
  return { key: 'voice', strength };
}

/**
 * 出来事の回数（チャットの発言・盛り上がる言葉）から、信号を作る。
 * `times` は出来事の時刻（秒）。10 秒の窓で数え、ふだん（前後 5 分の中央値）の `ratio` 倍、かつ `min` 回以上で「起きている」。
 */
export function countSignal(key: SignalKey, times: number[], seconds: number, min: number, ratio: number): Signal {
  const perSecond = new Float32Array(seconds);
  for (const t of times) {
    const i = Math.floor(t);
    if (i >= 0 && i < seconds) perSecond[i] += 1;
  }
  const rate = new Float32Array(seconds);
  let sum = 0;
  for (let i = 0; i < seconds + 5; i++) {
    if (i < seconds) sum += perSecond[i];
    if (i - 10 >= 0) sum -= perSecond[i - 10];
    const center = i - 5;
    if (center >= 0 && center < seconds) rate[center] = sum;
  }
  const base = baselineLevels(rate);
  const strength = new Float32Array(seconds);
  for (let i = 0; i < seconds; i++) strength[i] = rate[i] / Math.max(min, ratio * (base[i] + 1));
  return { key, strength };
}

/** チャットが盛り上がった。10 秒に 4 件以上、かつふだんの 2 倍。 */
export function chatSignal(times: number[], seconds: number): Signal {
  return countSignal('chat', times, seconds, 4, 2);
}

/**
 * 盛り上がる言葉（笑い・驚き・叫び・勝ち負け）。配信でよく出る言い回しを、短い一覧で持つ。
 * ここに無い言葉は拾わない。足りなければ、ここへ足す。
 */
export const HYPE_WORDS = [
  'やば', 'ヤバ', 'すご', 'スゴ', 'すげ', 'うわ', 'うお', 'うそ', '嘘', 'まじ', 'マジ', 'えぐ', 'エグ', '神', 'ナイス',
  '勝った', '勝ち', '負けた', 'きた', 'キタ', '来た', 'よっしゃ', 'やった', '最高', '天才', 'うま', '強', 'つよ', '死ん', '死ぬ',
  '笑', 'ｗｗ', 'ww', '草', 'あはは', 'はは', 'えー', 'ええ', 'なんで', '何で', 'ちょっと待', 'まって', '待って', 'あぶな', '危な',
  'おい', 'こわ', '怖', 'ひど', 'ずる', '嬉し', 'うれし', '助け', '逃げ', 'いけ', '行け', '倒し', 'キル', 'エース', '!?', '！？',
];

/** 文の中の、盛り上がる言葉の数。 */
export function hypeCount(text: string): number {
  let count = 0;
  for (const word of HYPE_WORDS) if (text.includes(word)) count += 1;
  return count;
}

/** 盛り上がる言葉。10 秒に 2 つ以上、かつふだんの 2 倍。`cues` は文字起こし（開始秒と文）。 */
export function wordsSignal(cues: { start: number; text: string }[], seconds: number): Signal {
  const times: number[] = [];
  for (const cue of cues) for (let i = hypeCount(cue.text); i > 0; i--) times.push(cue.start);
  return countSignal('words', times, seconds, 2, 2);
}

// ---------------------------------------------------------------- チャットのファイル

/**
 * チャットのファイルから、発言の時刻（録画の頭からの秒）を取り出す。読めなければ空。
 *
 * 読める形:
 * - TwitchDownloader の JSON … `{ comments: [{ content_offset_seconds }] }`
 * - chat-downloader の JSON … `[{ time_in_seconds }]`（1 行 1 件の JSON Lines も）
 * - テキスト … 行の頭が `[1:23:45]` や `1:23:45` のもの
 */
export function parseChatTimes(source: string): number[] {
  const out: number[] = [];
  const push = (v: unknown) => {
    const t = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(t) && t >= 0) out.push(t);
  };
  const fromItem = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const o = item as Record<string, unknown>;
    if ('content_offset_seconds' in o) push(o.content_offset_seconds);
    else if ('time_in_seconds' in o) push(o.time_in_seconds);
    else if ('offset_seconds' in o) push(o.offset_seconds);
  };
  const text = source.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const data = JSON.parse(text) as unknown;
      const list = Array.isArray(data) ? data : ((data as { comments?: unknown[] }).comments ?? []);
      if (Array.isArray(list)) list.forEach(fromItem);
      if (out.length > 0) return out.sort((a, b) => a - b);
    } catch {
      /* JSON Lines かもしれない。下で 1 行ずつ読む。 */
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        fromItem(JSON.parse(trimmed));
      } catch {
        /* 読めない行は飛ばす */
      }
      continue;
    }
    const m = /^\[?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?\]?/.exec(trimmed);
    if (m) out.push(Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- 候補を選ぶ

/**
 * 候補。`levels` は 1 秒ごとの音の大きさ（頭と終わりを静かな所へ合わせるのに使う）。点数の高い順。
 * 2 つ以上の信号が重なる所が無ければ、空になる（弱い所で数を埋めない）。
 */
export function findCandidates(levels: Float32Array, signals: Signal[], options: CandidateOptions = {}): Candidate[] {
  const n = levels.length;
  const length = Math.max(5, Math.round(options.length ?? 45));
  const count = Math.max(1, options.count ?? 5);
  const minSignals = Math.max(1, options.minSignals ?? 2);
  const half = Math.round((options.within ?? 30) / 2);
  if (n < length || signals.length === 0) return [];

  const L = Float32Array.from(levels, (v) => (Number.isFinite(v) ? Math.max(-100, v) : -100));
  const own = signals.map((s) => Float32Array.from({ length: n }, (_, i) => (i < s.strength.length ? Math.max(0, s.strength[i]) : 0)));
  const near = own.map((s) => slidingMax(s, half));

  // その秒を山にしたときの点数。重なった信号の強さの合計に、その秒そのものの強さを少し足す（山を、本当に何か起きた秒に置く）。
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let present = 0;
    let total = 0;
    let here = 0;
    for (let k = 0; k < signals.length; k++) {
      if (near[k][i] >= 1) {
        present += 1;
        total += Math.min(STRENGTH_CAP, near[k][i]);
      }
      here += Math.min(STRENGTH_CAP, own[k][i]);
    }
    score[i] = present >= minSignals ? total + 0.5 * here : 0;
  }

  const floor = percentile(L, 0.1);
  const loud = percentile(L, 0.9);
  const soundingLine = floor + 0.35 * (loud - floor);
  const lift = loudnessLift(L);
  const quietest = (from: number, to: number) => {
    let best = Math.max(0, Math.min(n - 1, from));
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) if (L[i] < L[best]) best = i;
    return best;
  };

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => score[b] - score[a]);
  const chosen: Candidate[] = [];
  for (const p of order) {
    if (chosen.length >= count) break;
    if (score[p] <= 0) break;
    if (chosen.some((h) => p >= h.start - 2 && p < h.end + 2)) continue;

    let start = Math.round(p - PEAK_AT * length);
    start = Math.min(Math.max(0, start), n - length);
    start = quietest(start - SNAP, start + SNAP + 1);
    let end = Math.min(n, start + length);
    end = Math.min(n, quietest(end - SNAP, end + SNAP + 1) + 1);
    if (end - start < length * 0.6 || p < start || p >= end) continue;
    if (chosen.some((h) => start < h.end && h.start < end)) continue;

    const strengths = signals
      .map((s, k) => ({ key: s.key, value: near[k][p] }))
      .filter((s) => s.value >= 1)
      .sort((a, b) => b.value - a.value);
    const window = Array.from(lift.subarray(start, end)).sort((a, b) => b - a);
    const top = window.slice(0, Math.max(1, Math.round(window.length * 0.25)));
    let sounding = 0;
    for (let i = start; i < end; i++) if (L[i] > soundingLine) sounding++;
    chosen.push({
      start,
      end,
      peak: p,
      lift: top.reduce((a, b) => a + b, 0) / top.length,
      talk: sounding / (end - start),
      score: score[p],
      signals: strengths.map((s) => s.key),
      reason: strengths.map((s) => SIGNAL_LABELS[s.key]).join(' ＋ '),
    });
  }
  return chosen.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- 「良い / 違う」の評価

export interface Rating {
  /** どの録画か（名前と長さで見分ける。素材を入れ直しても同じ録画だと分かるように）。 */
  asset: string;
  start: number;
  end: number;
  good: boolean;
  /** 評価したとき、その候補に重なっていた信号。 */
  signals: SignalKey[];
  /** 評価した時刻（ミリ秒）。 */
  at: number;
}

/** 好みを点数に効かせ始める評価の数。これより少ないうちは、まだ傾向と言えない。 */
export const RATINGS_TO_LEARN = 6;

/** 録画を見分ける名前。 */
export function ratingAssetKey(asset: { name: string; duration: number }): string {
  return `${asset.name}|${Math.round(asset.duration)}`;
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  return shared <= 0 ? 0 : shared / Math.min(a.end - a.start, b.end - b.start);
}

/** その候補に付けた評価（同じ録画で、半分以上重なるもの）。無ければ null。新しい評価を優先する。 */
export function ratingFor(ratings: Rating[], asset: string, range: { start: number; end: number }): Rating | null {
  let found: Rating | null = null;
  for (const r of ratings) {
    if (r.asset !== asset || overlapRatio(r, range) < 0.5) continue;
    if (!found || r.at > found.at) found = r;
  }
  return found;
}

/** 評価を足す。同じ候補への前の評価は置き換える。同じ評価をもう一度付けたら、取り消す。 */
export function rate(ratings: Rating[], rating: Rating): Rating[] {
  const previous = ratingFor(ratings, rating.asset, rating);
  const rest = ratings.filter((r) => !(r.asset === rating.asset && overlapRatio(r, rating) >= 0.5));
  if (previous && previous.good === rating.good) return rest;
  return [...rest, rating];
}

/**
 * 信号ごとの好み（0〜1。0.5 が「どちらでもない」）。
 * その信号が重なっていた候補のうち、良いと言われた割合。少ない評価で極端に振れないよう、1 件ずつ足して割る。
 */
export function signalPreference(ratings: Rating[]): Record<SignalKey, number> {
  const out: Record<SignalKey, number> = { loud: 0.5, voice: 0.5, words: 0.5, chat: 0.5 };
  for (const key of Object.keys(out) as SignalKey[]) {
    const with_ = ratings.filter((r) => r.signals.includes(key));
    const good = with_.filter((r) => r.good).length;
    out[key] = (good + 1) / (with_.length + 2);
  }
  return out;
}

export interface RatedCandidate extends Candidate {
  /** この候補に付けた評価。 */
  rated: 'good' | 'bad' | null;
}

/**
 * 評価を候補に当てる。
 * - 評価が溜まっていれば、好みの信号が重なった候補の点数を上げ、好みでない信号の候補を下げる
 * - 「違う」と言った候補は、後ろへ回す（消しはしない。見直せるように）
 */
export function applyRatings(candidates: Candidate[], ratings: Rating[], asset: string): RatedCandidate[] {
  const learn = ratings.length >= RATINGS_TO_LEARN;
  const pref = signalPreference(ratings);
  const rated = candidates.map((c): RatedCandidate => {
    const own = ratingFor(ratings, asset, c);
    const liking = c.signals.length > 0 ? c.signals.reduce((sum, key) => sum + pref[key], 0) / c.signals.length : 0.5;
    return { ...c, score: learn ? c.score * (0.5 + liking) : c.score, rated: own ? (own.good ? 'good' : 'bad') : null };
  });
  return rated.sort((a, b) => Number(a.rated === 'bad') - Number(b.rated === 'bad') || b.score - a.score);
}
