/**
 * 一回で全部書き出す — 字幕あり・字幕なしの動画と、投稿に使う文（タイトル・タグ・字幕の全文）を、1 回の操作で作る。
 *
 * ここは計算だけ（どれを作るか・名前・投稿メモ）。書き出しそのものは engine/exporter.ts を順に呼ぶ。
 */

import { withoutCaptions } from './captions';
import { TITLE_PLACEHOLDER } from './checks';
import type { Clip, Sequence } from './types';

export type VariantKey = 'captions' | 'clean';

export interface ExportVariant {
  key: VariantKey;
  label: string;
  /** ファイル名に入れる印（英数字。ファイル名は英数字だけで作るので、日本語は使えない）。 */
  tag: string;
}

export const EXPORT_VARIANTS: ExportVariant[] = [
  { key: 'captions', label: '字幕あり', tag: 'sub' },
  { key: 'clean', label: '字幕なし', tag: 'nosub' },
];

/** その版で書き出すシーケンス。字幕なしは「種類＝字幕」のテロップだけを消す（見出しや飾りは残る）。 */
export function variantSequence(sequence: Sequence, key: VariantKey): Sequence {
  return key === 'clean' ? withoutCaptions(sequence) : sequence;
}

/**
 * タグの入力（空白・読点・カンマ区切り、# は有っても無くても）を、`#タグ` の列にする。
 * 同じものは 1 つにし、書いた順を保つ。
 */
export function normalizeTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,、，]+/)) {
    const word = raw.replace(/^[#＃]+/, '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${word}`);
  }
  return out;
}

function isText(clip: Clip): boolean {
  return clip.kind === 'text' && !!clip.text;
}

/** 見出し（種類＝飾りの文字のうち、いちばん早く出るもの）。仮の文言・空は見出しとみなさない。 */
export function titleOf(sequence: Sequence): string | null {
  const titles = sequence.clips
    .filter((c) => isText(c) && c.text!.role === 'design')
    .sort((a, b) => a.start - b.start)
    .map((c) => c.text!.content.replace(/\s*\n\s*/g, ' ').trim())
    .filter((t) => t && t !== TITLE_PLACEHOLDER);
  return titles[0] ?? null;
}

/** 字幕の全文（出る順）。説明欄に貼ったり、見直したりするため。 */
export function captionScript(sequence: Sequence): string {
  return sequence.clips
    .filter((c) => isText(c) && (c.text!.role ?? 'caption') === 'caption')
    .sort((a, b) => a.start - b.start)
    .map((c) => c.text!.content.replace(/\s*\n\s*/g, ''))
    .filter(Boolean)
    .join('\n');
}

function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 投稿メモ。そのまま投稿の画面に貼れるよう、「タイトル」「説明（タイトル＋タグ）」を先に置く。
 * タイトルが無ければ作品名を使う。
 */
export function postNote(options: { projectName: string; title: string | null; tags: string[]; script: string; duration: number }): string {
  const title = options.title ?? options.projectName;
  const tags = options.tags.join(' ');
  const lines = [
    `タイトル: ${title}`,
    '',
    '説明:',
    tags ? `${title}\n\n${tags}` : title,
    '',
    `タグ: ${tags || '（なし）'}`,
    `長さ: ${clock(options.duration)}`,
  ];
  if (options.script) lines.push('', '字幕（全文）:', options.script);
  return lines.join('\n') + '\n';
}
