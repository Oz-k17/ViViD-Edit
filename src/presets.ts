import { DEFAULT_FILTERS, type Filters, type TextStyle } from './types';

export interface LookPreset {
  key: string;
  label: string;
  filters: Filters;
}

/** ワンタップで雰囲気を変えるフィルタープリセット。 */
export const LOOKS: LookPreset[] = [
  { key: 'none', label: 'オリジナル', filters: { ...DEFAULT_FILTERS } },
  { key: 'vivid', label: 'ビビッド', filters: { ...DEFAULT_FILTERS, saturation: 1.45, contrast: 1.12, brightness: 1.04 } },
  { key: 'clean', label: 'クリア', filters: { ...DEFAULT_FILTERS, brightness: 1.12, contrast: 1.05, saturation: 1.1 } },
  { key: 'film', label: 'フィルム', filters: { ...DEFAULT_FILTERS, contrast: 1.18, saturation: 0.82, sepia: 0.18 } },
  { key: 'mono', label: 'モノクロ', filters: { ...DEFAULT_FILTERS, grayscale: 1, contrast: 1.15 } },
  { key: 'cool', label: 'クール', filters: { ...DEFAULT_FILTERS, hueRotate: -12, saturation: 1.15, brightness: 1.02 } },
  { key: 'warm', label: 'ウォーム', filters: { ...DEFAULT_FILTERS, hueRotate: 12, sepia: 0.12, saturation: 1.12 } },
  { key: 'dream', label: 'ドリーム', filters: { ...DEFAULT_FILTERS, blur: 1.6, brightness: 1.08, saturation: 1.2 } },
];

export const FONT_OPTIONS = [
  { value: '"Noto Sans JP", system-ui, sans-serif', label: 'Noto Sans JP（標準）' },
  { value: '"M PLUS Rounded 1c", system-ui, sans-serif', label: 'M PLUS Rounded（まる）' },
  { value: '"Kaisei Decol", serif', label: 'Kaisei Decol（明朝）' },
  { value: 'Impact, "Noto Sans JP", sans-serif', label: 'Impact（ミーム）' },
  { value: 'Georgia, serif', label: 'Georgia（英字セリフ）' },
  { value: 'ui-monospace, "SFMono-Regular", monospace', label: 'Monospace' },
];

export interface TextPreset {
  key: string;
  label: string;
  style: TextStyle;
  animation: 'none' | 'fade' | 'pop' | 'slideUp' | 'typewriter';
}

const baseStyle: TextStyle = {
  fontFamily: FONT_OPTIONS[0].value,
  fontSize: 72,
  weight: 900,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 6,
  bgColor: '#000000',
  bgOpacity: 0,
  shadow: 12,
  lineHeight: 1.25,
  letterSpacing: 0,
  align: 'center',
};

/** ショート動画で使い回しの効く文字スタイル。 */
export const TEXT_PRESETS: TextPreset[] = [
  { key: 'caption', label: '字幕', style: { ...baseStyle, fontSize: 58, strokeWidth: 7 }, animation: 'fade' },
  {
    key: 'headline',
    label: '見出し',
    style: { ...baseStyle, fontSize: 96, strokeWidth: 8, letterSpacing: -1 },
    animation: 'pop',
  },
  {
    key: 'box',
    label: '白ヌキ帯',
    style: {
      ...baseStyle,
      fontSize: 62,
      color: '#111111',
      strokeWidth: 0,
      bgColor: '#ffffff',
      bgOpacity: 0.95,
      shadow: 6,
      weight: 800,
    },
    animation: 'slideUp',
  },
  {
    key: 'neon',
    label: 'ネオン',
    style: {
      ...baseStyle,
      fontSize: 84,
      color: '#f0abfc',
      strokeColor: '#4c1d95',
      strokeWidth: 5,
      shadow: 28,
    },
    animation: 'pop',
  },
  {
    key: 'mono',
    label: 'タイプ',
    style: {
      ...baseStyle,
      fontFamily: FONT_OPTIONS[5].value,
      fontSize: 52,
      weight: 700,
      strokeWidth: 0,
      bgColor: '#000000',
      bgOpacity: 0.55,
      letterSpacing: 1,
    },
    animation: 'typewriter',
  },
];

export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 3];

export const ANIMATION_LABELS: Record<string, string> = {
  none: 'なし',
  fade: 'フェード',
  pop: 'ポップ',
  slideUp: 'スライド',
  typewriter: 'タイプライター',
};
