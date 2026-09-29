/**
 * 書き起こしを読み込んで、テロップのクリップに変える。
 *
 * 文字起こしそのものはこの道具の外（faster-whisper など）で作る前提。
 * ここがやるのは **時刻付きの文を受け取って、読める形に割って、並べる**ところまで。
 *
 * 受け取れる形は 3 つ:
 *   - SRT       … `1` / `00:00:01,000 --> 00:00:03,500` / 本文
 *   - WebVTT    … 先頭が `WEBVTT`。時刻の区切りが `.`
 *   - Whisper の JSON … `{ segments: [{ start, end, text, words?, speaker? }] }`
 *
 * 画面にも React にも依存していないので、ブラウザ抜きで確かめられる。
 */

import { wrapJapanese } from '../engine/linebreak';
import { textClip, uid } from './factory';
import { addTrack, placeClip, tracksOf } from './ops';
import type { Clip, Sequence, TextProps } from './types';

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
  /** 元の書き起こしに話者が入っていたときだけ。無ければ null。 */
  speaker: string | null;
  /** 単語ごとの時刻。長い行を割るときに使う。無ければ文字数で按分する。 */
  words?: TranscriptWord[];
}

/** `00:01:02,345` `00:01:02.345` `01:02.345` `62.5` を秒にする。読めなければ null。 */
export function parseTimecode(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (!text) return null;
  const parts = text.split(':');
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return null;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

/** 字幕ファイル（SRT / WebVTT）の 1 かたまりから、時刻と本文を取り出す。 */
function cueFromBlock(block: string): Cue | null {
  const lines = block.split('\n').map((l) => l.trimEnd());
  const arrow = lines.findIndex((l) => l.includes('-->'));
  if (arrow < 0) return null;

  // `00:00:01.000 --> 00:00:03.500 line:90%` のように、後ろに設定が付くことがある。
  const [left, right = ''] = lines[arrow].split('-->');
  const start = parseTimecode(left);
  const end = parseTimecode(right.trim().split(/\s+/)[0] ?? '');
  if (start === null || end === null) return null;

  const text = lines
    .slice(arrow + 1)
    .join('\n')
    // WebVTT は本文に <v 名前> や <00:00:01.000> が混ざることがある。
    .replace(/<[^>]*>/g, '')
    .trim();
  if (!text) return null;
  return { start, end: Math.max(end, start), text, speaker: null };
}

/** SRT / WebVTT を読む。 */
export function parseCueFile(source: string): Cue[] {
  const body = source
    .replace(/\r\n?/g, '\n')
    .replace(/^﻿/, '')
    // WEBVTT の見出しと、NOTE / STYLE / REGION のかたまりは本文ではない。
    .replace(/^WEBVTT[^\n]*\n/, '')
    .replace(/^(NOTE|STYLE|REGION)[\s\S]*?(\n\n|$)/gm, '');
  const cues: Cue[] = [];
  for (const block of body.split(/\n{2,}/)) {
    const cue = cueFromBlock(block);
    if (cue) cues.push(cue);
  }
  return cues;
}

/** 単語の並びを取り出す。whisper の実装ごとに鍵の名前が違う。 */
function wordsOf(raw: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words: TranscriptWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const text = typeof w.word === 'string' ? w.word : typeof w.text === 'string' ? w.text : null;
    if (text === null) continue;
    const start = Number(w.start);
    const end = Number(w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    words.push({ start, end: Math.max(end, start), text });
  }
  return words.length ? words : undefined;
}

/** Whisper の JSON を読む。`{segments:[...]}` でも、素の配列でも受ける。 */
export function parseWhisperJson(source: string): Cue[] {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).segments)
      ? ((data as Record<string, unknown>).segments as unknown[])
      : null;
  if (!list) return [];

  const cues: Cue[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const start = Number(s.start);
    const end = Number(s.end);
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    const speaker = typeof s.speaker === 'string' && s.speaker.trim() ? s.speaker.trim() : null;
    cues.push({ start, end: Math.max(end, start), text, speaker, words: wordsOf(s.words) });
  }
  return cues;
}

/** 中身を見て、SRT / VTT / JSON を選り分けて読む。 */
export function parseTranscript(source: string): Cue[] {
  const head = source.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    const cues = parseWhisperJson(source);
    if (cues.length) return cues;
  }
  return parseCueFile(source);
}

/** whisper が返す 1 かたまり。終わりの時刻は、最後の切れ端だと null になる。 */
export interface ResultChunk {
  timestamp: [number, number | null];
  text: string;
}

/** 終わりの時刻が無いものを、次の始まりか「+2 秒」で埋める。 */
function fillEnds(chunks: ResultChunk[]): { start: number; end: number; text: string }[] {
  return chunks.map((chunk, i) => {
    const start = chunk.timestamp[0];
    const next = chunks[i + 1]?.timestamp[0];
    const end = chunk.timestamp[1] ?? (next !== undefined ? next : start + 2);
    return { start, end: Math.max(end, start), text: chunk.text.trim() };
  });
}

/** 文ごとの結果を、そのまま行にする。 */
export function cuesFromSegments(chunks: ResultChunk[]): Cue[] {
  return fillEnds(chunks)
    .filter((c) => c.text.length > 0)
    .map((c) => ({ ...c, speaker: null }));
}

export interface GroupOptions {
  /** 1 行の文字数の上限。超えたらそこで切る。 */
  maxChars?: number;
  /** これ以上あいたら、間があいたとみなして切る（秒）。 */
  gap?: number;
}

/**
 * 単語ごとの結果を、行にまとめる。
 *
 * 切るのは「文の終わりまで来た」「間があいた」「長くなりすぎた」の 3 つ。
 * 単語の時刻はそのまま持たせておく。あとで行を割るときに、
 * 言った所でちょうど切り替えられる。
 */
export function cuesFromWords(chunks: ResultChunk[], options: GroupOptions = {}): Cue[] {
  const maxChars = options.maxChars ?? 24;
  const gap = options.gap ?? 0.6;
  const words = fillEnds(chunks).filter((w) => w.text.length > 0);

  const cues: Cue[] = [];
  let buffer: TranscriptWord[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    cues.push({
      start: buffer[0].start,
      end: buffer[buffer.length - 1].end,
      text: buffer.map((w) => w.text).join('').trim(),
      speaker: null,
      words: buffer,
    });
    buffer = [];
  };

  for (let i = 0; i < words.length; i += 1) {
    buffer.push(words[i]);
    const length = [...buffer.map((w) => w.text).join('').replace(/\s/g, '')].length;
    const ended = /[。．！？!?…]$/.test(words[i].text.trim());
    const next = words[i + 1];
    const spaced = next !== undefined && next.start - words[i].end >= gap;
    if (ended || spaced || length >= maxChars) flush();
  }
  flush();
  return cues;
}

/**
 * 読むのにかかる長さの下限（秒）。
 *
 * 調べた目安は「1 文字あたり 0.1〜0.15 秒」で、15 文字なら 1.5〜2.25 秒が下限。
 * ここは厳しい側（0.15）を採り、目を移す時間として 0.3 秒足す。
 * 「1 秒に 4 文字」は**楽に読める速さ**のほうなので、伸ばす基準には使わない
 *（それで伸ばすと、短い相槌まで間延びする）。
 */
export function readableDuration(text: string): number {
  return [...text.replace(/\s/g, '')].length * 0.15 + 0.3;
}

/** 文字数（空白は数えない）。 */
const charCount = (text: string) => [...text.replace(/\s/g, '')].length;

/**
 * 長い行を、読める長さへ割る。
 *
 * 単語の時刻があるときはそれで割る（言った所でちょうど切り替わる）。
 * 無いときは文字数で按分する。割る位置は折り返しと同じ規則（禁則・助詞・字種の変わり目）。
 */
export function splitCue(cue: Cue, maxChars: number, linesPerCue = 2): Cue[] {
  if (charCount(cue.text) <= maxChars) return [cue];

  // 1 行に入る文字数で折り、それを linesPerCue 行ずつ束ねる。
  const perLine = Math.max(1, Math.ceil(maxChars / linesPerCue));
  const lines = wrapJapanese(cue.text, { measure: charCount, maxWidth: perLine });
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += linesPerCue) {
    chunks.push(lines.slice(i, i + linesPerCue).join('\n'));
  }
  if (chunks.length <= 1) return [cue];

  if (cue.words && cue.words.length) return splitByWords(cue, chunks);

  // 文字数で按分する。長い行ほど長く出す。
  const total = chunks.reduce((sum, c) => sum + charCount(c), 0) || 1;
  const span = cue.end - cue.start;
  let at = cue.start;
  return chunks.map((text, i) => {
    const share = (charCount(text) / total) * span;
    const start = at;
    at = i === chunks.length - 1 ? cue.end : at + share;
    return { start, end: at, text, speaker: cue.speaker };
  });
}

/**
 * 単語の時刻で割る。
 * 単語の綴りと本文の綴りは必ずしも一致しない（空白の入り方が違う）ので、
 * **文字を順に消し込んで**、どの単語まで使ったかで境目を決める。
 */
function splitByWords(cue: Cue, chunks: string[]): Cue[] {
  const words = cue.words ?? [];
  let index = 0;
  let consumed = 0; // いま見ている単語のうち、使い終えた文字数
  let at = cue.start;

  return chunks.map((text, i) => {
    const start = i === 0 ? cue.start : at;
    let need = charCount(text);
    while (need > 0 && index < words.length) {
      const length = charCount(words[index].text);
      const left = length - consumed;
      if (left > need) {
        consumed += need;
        need = 0;
        // 単語の途中で切れたので、その単語の終わりまでを区切りとする。
        at = words[index].end;
      } else {
        need -= left;
        consumed = 0;
        at = words[index].end;
        index += 1;
      }
    }
    const end = i === chunks.length - 1 ? cue.end : Math.min(Math.max(at, start), cue.end);
    return { start, end, text, speaker: cue.speaker };
  });
}

export interface ClipWindow {
  /** タイムライン上の開始位置。 */
  start: number;
  /** 素材内のイン点。 */
  sourceIn: number;
  /** タイムライン上の尺。 */
  duration: number;
  speed: number;
}

/**
 * 素材の中の時刻を、タイムライン上の時刻へ移す。
 *
 * 文字起こしは素材まるごとに掛けるので、出てくる時刻は**素材の頭から**のもの。
 * クリップが素材の途中を使っていたり、速さを変えていたりすると、そのままでは合わない。
 * クリップが使っていない範囲の行は落とす。
 */
export function clipTimeline(cues: Cue[], window: ClipWindow): Cue[] {
  const speed = window.speed || 1;
  const from = window.sourceIn;
  const to = window.sourceIn + window.duration * speed;
  const at = (t: number) => window.start + (t - from) / speed;

  const out: Cue[] = [];
  for (const cue of cues) {
    // 端が掛かっているものは、掛かっている所だけ残す。
    const start = Math.max(cue.start, from);
    const end = Math.min(cue.end, to);
    if (end <= start) continue;
    out.push({
      ...cue,
      start: at(start),
      end: at(end),
      words: cue.words?.map((w) => ({ ...w, start: at(w.start), end: at(w.end) })),
    });
  }
  return out;
}

export interface TidyOptions {
  /** 1 つのテロップに入れる文字数の上限。 */
  maxChars?: number;
  /** 短すぎる行を、次の行にぶつからない範囲で伸ばすか。 */
  extendShort?: boolean;
  /** 先頭のずれ（秒）。素材の途中から書き起こした場合に使う。 */
  offset?: number;
}

export interface TidyResult {
  cues: Cue[];
  /** 割った結果、増えた行の数。 */
  split: number;
  /** 伸ばした行の数。 */
  extended: number;
  /** 伸ばしても読める長さに届かなかった行の数。 */
  stillShort: number;
}

/** 読み込んだ行を、置ける形へ整える。 */
export function tidyCues(input: Cue[], options: TidyOptions = {}): TidyResult {
  const maxChars = options.maxChars ?? 24;
  const offset = options.offset ?? 0;

  const sorted = [...input].sort((a, b) => a.start - b.start);
  const cues: Cue[] = [];
  for (const cue of sorted) {
    for (const part of splitCue(cue, maxChars)) {
      cues.push({ ...part, start: part.start + offset, end: part.end + offset });
    }
  }
  const split = cues.length - sorted.length;

  let extended = 0;
  let stillShort = 0;
  for (let i = 0; i < cues.length; i += 1) {
    const need = readableDuration(cues[i].text);
    if (cues[i].end - cues[i].start >= need) continue;
    if (options.extendShort !== false) {
      // 次の行の頭までなら伸ばしてよい。重ねると 2 行が同時に出てしまう。
      const limit = i + 1 < cues.length ? cues[i + 1].start : Infinity;
      const want = Math.min(cues[i].start + need, limit);
      if (want > cues[i].end) {
        cues[i] = { ...cues[i], end: want };
        extended += 1;
      }
    }
    if (cues[i].end - cues[i].start < need) stillShort += 1;
  }

  return { cues, split, extended, stillShort };
}

export interface BuildOptions {
  /** テロップの体裁。渡さなければ既定のまま。 */
  style?: Partial<TextProps>;
  /** 話者ごとの文字色。書き起こしに話者が入っているときだけ効く。 */
  speakerColors?: Record<string, string>;
  /** 置き場所のトラック名。 */
  trackName?: string;
}

/** 読み込んだ話者名を、この道具の話者（'1' '2'）へ割り当てる。出てきた順。 */
export function mapSpeakers(cues: Cue[], slots: readonly string[]): Map<string, string> {
  const order: string[] = [];
  for (const cue of cues) {
    if (cue.speaker && !order.includes(cue.speaker)) order.push(cue.speaker);
  }
  const map = new Map<string, string>();
  order.forEach((name, i) => {
    if (i < slots.length) map.set(name, slots[i]);
  });
  return map;
}

/** 整えた行を、新しいテロップのトラックに並べる。 */
export function buildCaptionClips(
  sequence: Sequence,
  cues: Cue[],
  slots: readonly string[],
  options: BuildOptions = {},
): Sequence {
  if (cues.length === 0) return sequence;

  const name = options.trackName ?? `字幕 ${tracksOf(sequence, 'text').length + 1}`;
  let next = addTrack(sequence, 'text', name);
  const track = tracksOf(next, 'text').find((t) => t.name === name);
  if (!track) return sequence;

  const speakers = mapSpeakers(cues, slots);
  for (const cue of cues) {
    const speaker = cue.speaker ? (speakers.get(cue.speaker) ?? null) : null;
    const color = speaker && options.speakerColors ? options.speakerColors[speaker] : undefined;
    const clip: Clip = {
      ...textClip(track.id, cue.start, Math.max(0.1, cue.end - cue.start), {
        ...options.style,
        ...(color ? { color } : {}),
        content: cue.text,
        role: 'caption',
        speaker,
      }),
      id: uid('clip'),
    };
    next = placeClip(next, clip);
  }
  return next;
}
