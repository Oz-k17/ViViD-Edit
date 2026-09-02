/**
 * Project > Sequence > Track > Clip のデータモデル。
 * ここにあるものは全て JSON 化できる（履歴・テンプレート・保存に載せられる）。
 * 素材ファイルの実体は mediaRegistry 側が持ち、Clip は mediaId で参照するだけ。
 */

export type AspectKey = '9:16' | '1:1' | '4:5' | '16:9';

export interface AspectPreset {
  key: AspectKey;
  label: string;
  hint: string;
  width: number;
  height: number;
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { key: '9:16', label: '9:16', hint: 'TikTok / Reels / Shorts', width: 1080, height: 1920 },
  { key: '1:1', label: '1:1', hint: 'フィード投稿', width: 1080, height: 1080 },
  { key: '4:5', label: '4:5', hint: 'Instagram 縦フィード', width: 1080, height: 1350 },
  { key: '16:9', label: '16:9', hint: '横型 / YouTube', width: 1920, height: 1080 },
];

export type TrackKind = 'video' | 'audio' | 'text';

export interface Track {
  id: string;
  kind: TrackKind;
  /** V1 / A1 / T1 のような表示名。 */
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}

export type EffectType =
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'grayscale'
  | 'sepia'
  | 'hueRotate'
  | 'blur'
  | 'invert';

export interface Effect {
  id: string;
  type: EffectType;
  /** 0〜1 の強さ。意味はエフェクトごとに解釈する。 */
  intensity: number;
}

export interface Crop {
  enabled: boolean;
  /** 元映像の切り抜き範囲（0〜1）。 */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** 出力画面上の配置（0〜1）。 */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface BgBlur {
  enabled: boolean;
  /** 画面幅に対するぼかし半径の比（0.01 = 1%）。 */
  strength: number;
  /** 背面を少し寄せて端の欠けを防ぐ。 */
  zoom: number;
}

export type TransitionType = 'none' | 'dissolve' | 'fade' | 'slide' | 'wipe' | 'flash';

export interface Transition {
  type: TransitionType;
  duration: number;
}

export type TextAlign = 'left' | 'center' | 'right';
export type TextAnimation =
  | 'none'
  | 'fade'
  | 'pop'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'zoom'
  | 'bounce'
  | 'typewriter';

export interface TextProps {
  content: string;
  fontFamily: string;
  /** プロジェクト幅 1080 を基準にした px。 */
  fontSize: number;
  weight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  bgColor: string;
  bgOpacity: number;
  shadow: number;
  align: TextAlign;
  lineHeight: number;
  letterSpacing: number;
  /** 0〜1。折り返し幅の画面比。 */
  maxWidth: number;
  animation: TextAnimation;
  animationDuration: number;
}

export type ClipKind = 'video' | 'image' | 'audio' | 'text';

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  mediaId: string | null;
  /** タイムライン上の開始位置と尺（秒）。 */
  start: number;
  duration: number;
  /** 素材内のイン点（秒）。素材のアウト点は sourceIn + duration * speed。 */
  sourceIn: number;
  speed: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  opacity: number;
  scale: number;
  x: number;
  y: number;
  rotate: number;
  fit: 'cover' | 'contain';
  bgBlur: BgBlur;
  crop: Crop;
  effects: Effect[];
  fadeIn: number;
  fadeOut: number;
  /** 直前のクリップとの継ぎ目に置く切り替え効果。 */
  transitionIn: Transition;
  text: TextProps | null;
}

export interface Sequence {
  fps: number;
  aspect: AspectKey;
  width: number;
  height: number;
  background: string;
  tracks: Track[];
  clips: Clip[];
}

export interface Project {
  name: string;
  sequence: Sequence;
}

export const DEFAULT_CROP: Crop = {
  enabled: false,
  sx: 0.25,
  sy: 0.25,
  sw: 0.5,
  sh: 0.5,
  dx: 0.05,
  dy: 0.6,
  dw: 0.4,
  dh: 0.3,
};

export const DEFAULT_BG_BLUR: BgBlur = { enabled: false, strength: 0.05, zoom: 1.15 };

export const EFFECT_META: Record<EffectType, { label: string; unit: string; def: number }> = {
  brightness: { label: '明るさ', unit: '', def: 0.6 },
  contrast: { label: 'コントラスト', unit: '', def: 0.6 },
  saturate: { label: '彩度', unit: '', def: 0.7 },
  grayscale: { label: 'モノクロ', unit: '', def: 1 },
  sepia: { label: 'セピア', unit: '', def: 0.6 },
  hueRotate: { label: '色相', unit: '°', def: 0.3 },
  blur: { label: 'ぼかし', unit: '', def: 0.2 },
  invert: { label: '反転', unit: '', def: 1 },
};

export const TRANSITION_META: Record<TransitionType, { label: string; icon: string }> = {
  none: { label: 'なし', icon: '—' },
  dissolve: { label: 'ディゾルブ', icon: '◐' },
  fade: { label: 'フェード', icon: '▰' },
  slide: { label: 'スライド', icon: '→' },
  wipe: { label: 'ワイプ', icon: '៖' },
  flash: { label: 'フラッシュ', icon: '✦' },
};

export const TEXT_ANIMATION_LABELS: Record<TextAnimation, string> = {
  none: 'なし',
  fade: 'フェード',
  pop: 'ポップ',
  slideUp: '下から',
  slideDown: '上から',
  slideLeft: '右から',
  slideRight: '左から',
  zoom: 'ズーム',
  bounce: 'バウンス',
  typewriter: 'タイプライター',
};

/**
 * テロップ本文の中で、アップロードした画像を「絵文字」として参照するときの書式。
 * 通常の文字と地続きの1つの文字列として扱えるよう、content の中に埋め込む
 * トークンとして表現する（挿入・削除は普通の文字入力と同じくテキストエリアで完結する）。
 */
const EMOJI_TOKEN_RE = /\{\{emoji:([A-Za-z0-9_-]+)\}\}/g;

export function emojiToken(mediaId: string): string {
  return `{{emoji:${mediaId}}}`;
}

export type ContentSegment = { text: string } | { emoji: string };

/** content を「テキストの断片」と「絵文字参照」が交互に並ぶ列に分解する。 */
export function splitTextContent(content: string): ContentSegment[] {
  const out: ContentSegment[] = [];
  let last = 0;
  for (const m of content.matchAll(EMOJI_TOKEN_RE)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ text: content.slice(last, index) });
    out.push({ emoji: m[1] });
    last = index + m[0].length;
  }
  if (last < content.length) out.push({ text: content.slice(last) });
  return out;
}

/** タイプライター演出用。絵文字は1文字ぶんとして数える。 */
export function contentAtomCount(segments: ContentSegment[]): number {
  return segments.reduce((n, s) => n + ('emoji' in s ? 1 : s.text.length), 0);
}

/** タイプライター演出用。絵文字が欠けて見えないよう、絵文字単位でしか切らない。 */
export function truncateAtoms(segments: ContentSegment[], count: number): ContentSegment[] {
  let remaining = Math.max(0, count);
  const out: ContentSegment[] = [];
  for (const seg of segments) {
    if (remaining <= 0) break;
    if ('emoji' in seg) {
      out.push(seg);
      remaining -= 1;
    } else if (seg.text.length <= remaining) {
      out.push(seg);
      remaining -= seg.text.length;
    } else {
      out.push({ text: seg.text.slice(0, remaining) });
      remaining = 0;
    }
  }
  return out;
}

/** 一覧のラベルなど、絵文字トークンをそのまま出したくない場所での短い表示用。 */
export function previewText(content: string): string {
  return content.replace(EMOJI_TOKEN_RE, '🖼');
}

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

/** 素材内の再生位置。 */
export function sourceTimeAt(clip: Clip, time: number): number {
  return clip.sourceIn + Math.max(0, time - clip.start) * (clip.speed || 1);
}
