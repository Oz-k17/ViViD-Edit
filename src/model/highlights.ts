/**
 * おまかせ下書き — 長い録画から見どころの候補を出し、選んだものを下書き（切り出し → 間を詰める → 3 分割）にする。
 *
 * 見どころは、音だけで探す（文字起こしは NAS の Docker でしか使えないので、それに頼らない）。
 * 配信の見どころは、だいたい「ふだんより声や音が大きくなる所」（笑い・叫び・驚き）で、
 * そこに至るまでのやりとりも込みで見せたい。だから:
 *
 * 1. 1 秒ごとの音の大きさ（dB）を、その前後 5 分の「ふだんの大きさ」と前後 20 秒の「近くの大きさ」（どちらも中央値）の
 *    大きいほうと比べ、上回った分を盛り上がりとする。ゲームの音量や声の張りは配信の中で変わるので、全体の平均とは比べない。
 *    近くとも比べるのは、数分続く変化（ゲームの音が大きい場面）の境目を、盛り上がりと取り違えないため
 * 2. 盛り上がりの大きい所から順に、その瞬間が候補の 6〜7 割の所に来るよう切り出す（前振り → 山 → 余韻）
 * 3. 候補の頭と終わりは、前後 3 秒でいちばん静かな秒へずらす（言葉の途中から始まらないように）
 * 4. 重なる候補は取らない。点数は「盛り上がりの大きさ × しゃべっている割合」
 *
 * ここは計算だけ。音の大きさの列は engine/highlightScan.ts が作る。
 */

import { buildThreeBand } from './threeBand';
import { clipFromAsset, textClip } from './factory';
import { goldenBands } from './layout';
import { placeWithSound, reconcileLinks } from './links';
import { nestClips } from './nest';
import { tracksOf } from './ops';
import { cutRanges, removeRanges, type TimeRange } from './tempo';
import type { Kit } from './kit';
import type { Sequence, TextProps } from './types';

export interface Highlight {
  /** 素材の秒。 */
  start: number;
  end: number;
  /** いちばん盛り上がった秒。 */
  peak: number;
  /** ふだんより何 dB 大きかったか（山のあたりの平均）。 */
  lift: number;
  /** 音が鳴っていた割合（0〜1）。しゃべりの多さの目安。 */
  talk: number;
  /** 並べる順の点数（大きいほど上）。 */
  score: number;
}

export interface HighlightOptions {
  /** 候補の長さ（秒）。 */
  length?: number;
  /** 候補の数。 */
  count?: number;
  /** 盛り上がりがこれ（dB）より小さい所は、候補にしない。 */
  minLift?: number;
}

/** ふだんの大きさを測る幅（秒・片側）。 */
const BASELINE_HALF = 150;
/** ふだんの大きさを測り直す間隔（秒）。間は直線でつなぐ。 */
const BASELINE_STEP = 10;
/** 山が候補のどこに来るか（頭からの割合）。 */
const PEAK_AT = 0.65;
/** 頭と終わりを静かな所へずらす幅（秒）。 */
const SNAP = 3;

function percentile(values: ArrayLike<number>, ratio: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * (sorted.length - 1))))];
}

/** 続いた変化（ゲームの音が数分大きくなる等）と見分けるための、近くの大きさを測る幅（秒・片側）。 */
const NEAR_HALF = 20;

/** その前後 `half` 秒の中央値（ふだんの大きさ）。`step` 秒ごとに測り、間は直線でつなぐ。 */
export function baselineLevels(levels: Float32Array, half = BASELINE_HALF, step = BASELINE_STEP): Float32Array {
  const n = levels.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const anchors: { at: number; value: number }[] = [];
  for (let at = 0; at < n; at += step) {
    const from = Math.max(0, at - half);
    const to = Math.min(n, at + half + 1);
    anchors.push({ at, value: percentile(levels.subarray(from, to), 0.5) });
  }
  if (anchors[anchors.length - 1].at !== n - 1) {
    const at = n - 1;
    anchors.push({ at, value: percentile(levels.subarray(Math.max(0, at - half), n), 0.5) });
  }
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < anchors.length - 2 && anchors[k + 1].at <= i) k++;
    const a = anchors[k];
    const b = anchors[Math.min(k + 1, anchors.length - 1)];
    const t = b.at === a.at ? 0 : (i - a.at) / (b.at - a.at);
    out[i] = a.value + (b.value - a.value) * Math.min(1, Math.max(0, t));
  }
  return out;
}

/**
 * 見どころの候補。`levels` は 1 秒ごとの音の大きさ（dBFS）。点数の高い順。
 * 盛り上がる所が無い（ずっと同じ調子の）録画では、空になる。
 */
export function findHighlights(levels: Float32Array, options: HighlightOptions = {}): Highlight[] {
  const n = levels.length;
  const length = Math.max(5, Math.round(options.length ?? 45));
  const count = Math.max(1, options.count ?? 5);
  const minLift = options.minLift ?? 3;
  if (n < length) return [];

  const L = Float32Array.from(levels, (v) => (Number.isFinite(v) ? Math.max(-100, v) : -100));
  // ふだん（前後 5 分）と、近く（前後 20 秒）の両方より大きい所だけを盛り上がりとする。
  // 前後 5 分だけだと、ゲームの音が数分大きくなった境目（中央値が追いつかない所）まで盛り上がりに見える。
  const far = baselineLevels(L);
  const near = baselineLevels(L, NEAR_HALF, 2);
  const base = Float32Array.from(far, (v, i) => Math.max(v, near[i]));
  // 1 秒だけの物音より、続いた盛り上がりを拾うため、3 秒でならす。
  const lift = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
      sum += Math.max(0, L[j] - base[j]);
      cnt++;
    }
    lift[i] = sum / cnt;
  }
  const floor = percentile(L, 0.1);
  const loud = percentile(L, 0.9);
  const soundingLine = floor + 0.35 * (loud - floor);

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lift[b] - lift[a]);
  const chosen: Highlight[] = [];

  /** [from, to) でいちばん静かな秒。 */
  const quietest = (from: number, to: number) => {
    let best = Math.max(0, Math.min(n - 1, from));
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) if (L[i] < L[best]) best = i;
    return best;
  };

  for (const p of order) {
    if (chosen.length >= count) break;
    if (lift[p] < minLift) break;
    if (chosen.some((h) => p >= h.start - 2 && p < h.end + 2)) continue;

    let start = Math.round(p - PEAK_AT * length);
    start = Math.min(Math.max(0, start), n - length);
    start = quietest(start - SNAP, start + SNAP + 1);
    let end = Math.min(n, start + length);
    end = Math.min(n, quietest(end - SNAP, end + SNAP + 1) + 1);
    if (end - start < length * 0.6 || p < start || p >= end) continue;
    if (chosen.some((h) => start < h.end && h.start < end)) continue;

    const window = Array.from(lift.subarray(start, end)).sort((a, b) => b - a);
    const top = window.slice(0, Math.max(1, Math.round(window.length * 0.25)));
    const meanLift = top.reduce((a, b) => a + b, 0) / top.length;
    let sounding = 0;
    for (let i = start; i < end; i++) if (L[i] > soundingLine) sounding++;
    const talk = sounding / (end - start);
    chosen.push({ start, end, peak: p, lift: meanLift, talk, score: meanLift * (0.5 + 0.5 * talk) });
  }
  return chosen.sort((a, b) => b.score - a.score);
}

export interface DraftOptions {
  /** 間を詰めるときの、残す範囲（素材の秒）。無ければ詰めない。 */
  keep?: TimeRange[] | null;
  /** 3 分割に組むか。 */
  threeBand: boolean;
  /** 自分の型（3 分割の切り抜き位置と見出しの体裁）。無ければ中心から切り抜く。 */
  kit?: Kit | null;
  /** 見出しの体裁（型に見出しが無いときに使う）。null なら見出しを置かない。 */
  titleStyle?: Partial<TextProps> | null;
  /** 1 本にまとめるときの id（呼ぶ側で先に決める）。null ならまとめない。 */
  nestId?: string | null;
}

/** 見出しの仮の文言（確かめリストが「書き換えて」と知らせる）。 */
const TITLE_TEXT = '見出しを入れる';

/**
 * 下書きを組む。いまのタイムライン（トラックの並び）を使い、中身は空にしてから:
 * 候補の範囲を置く（映像と音）→ 間を詰める → 3 分割（自分の型）→ 見出し → 1 本にまとめる。
 */
export function buildDraft(
  base: Sequence,
  asset: { id: string; kind: 'video' | 'audio'; duration: number; width: number; height: number; hasAudio?: boolean },
  range: { start: number; end: number },
  options: DraftOptions,
): Sequence {
  const empty: Sequence = { ...base, clips: [] };
  const lane = tracksOf(empty, asset.kind === 'audio' ? 'audio' : 'video')[0];
  if (!lane) return base;
  const clip = { ...clipFromAsset(asset, lane.id, 0), sourceIn: range.start, duration: range.end - range.start };
  let seq = placeWithSound(empty, [clip], false, () => asset.hasAudio !== false);

  if (options.keep) seq = removeRanges(seq, clip.id, cutRanges(clip, options.keep)).sequence;

  if (options.threeBand && asset.kind === 'video') {
    const media = { width: asset.width || seq.width, height: asset.height || seq.height };
    const pieces = seq.clips.filter((c) => c.trackId === lane.id && c.kind === 'video').sort((a, b) => a.start - b.start);
    for (const piece of pieces) {
      const prev = seq;
      seq = reconcileLinks(prev, buildThreeBand(prev, piece, media, { sources: options.kit?.bands }));
    }
    const titleStyle = options.kit ? options.kit.title : options.titleStyle;
    const textTrack = tracksOf(seq, 'text')[0];
    const total = seq.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    if (titleStyle && textTrack && total > 0) {
      const bands = goldenBands(seq.height);
      const title = textClip(textTrack.id, 0, total, { ...titleStyle, content: TITLE_TEXT });
      seq = { ...seq, clips: [...seq.clips, { ...title, y: (bands.top.y + bands.top.h / 2) / seq.height - 0.5 }] };
    }
  }

  if (options.nestId) {
    seq = nestClips(seq, seq.clips.map((c) => c.id), '下書き', options.nestId).sequence;
  }
  return seq;
}
