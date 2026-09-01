import { DEFAULT_TEXT } from './model/factory';
import type { TextProps } from './model/types';

export const FONT_OPTIONS = [
  { value: '"Noto Sans JP", system-ui, sans-serif', label: 'Noto Sans JP（標準）' },
  { value: '"M PLUS Rounded 1c", system-ui, sans-serif', label: 'M PLUS Rounded（まる）' },
  { value: '"Kaisei Decol", serif', label: 'Kaisei Decol（明朝）' },
  { value: '"RocknRoll One", system-ui, sans-serif', label: 'RocknRoll One（太丸）' },
  { value: 'Impact, "Noto Sans JP", sans-serif', label: 'Impact（ミーム）' },
  { value: 'Georgia, serif', label: 'Georgia（英字セリフ）' },
  { value: 'ui-monospace, "SFMono-Regular", monospace', label: 'Monospace' },
];

export interface TextPreset {
  key: string;
  label: string;
  text: TextProps;
}

/** ショート動画で使い回しの効くテロップスタイル。 */
export const TEXT_PRESETS: TextPreset[] = [
  { key: 'caption', label: '字幕', text: { ...DEFAULT_TEXT, fontSize: 56, strokeWidth: 7, animation: 'fade' } },
  {
    key: 'headline',
    label: '見出し',
    text: { ...DEFAULT_TEXT, fontSize: 96, strokeWidth: 8, letterSpacing: -1, animation: 'pop' },
  },
  {
    key: 'box',
    label: '白ヌキ帯',
    text: {
      ...DEFAULT_TEXT,
      fontSize: 62,
      weight: 800,
      color: '#111111',
      strokeWidth: 0,
      bgColor: '#ffffff',
      bgOpacity: 0.95,
      shadow: 6,
      animation: 'slideUp',
    },
  },
  {
    key: 'neon',
    label: 'ネオン',
    text: {
      ...DEFAULT_TEXT,
      fontSize: 84,
      color: '#f0abfc',
      strokeColor: '#4c1d95',
      strokeWidth: 5,
      shadow: 28,
      animation: 'zoom',
    },
  },
  {
    key: 'mono',
    label: 'タイプ',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: FONT_OPTIONS[6].value,
      fontSize: 52,
      weight: 700,
      strokeWidth: 0,
      bgColor: '#000000',
      bgOpacity: 0.55,
      letterSpacing: 1,
      animation: 'typewriter',
    },
  },
  {
    key: 'pop',
    label: 'ポップ',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: FONT_OPTIONS[1].value,
      fontSize: 88,
      color: '#fde047',
      strokeColor: '#7c2d12',
      strokeWidth: 8,
      animation: 'bounce',
    },
  },
];

export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 3];

export const LOOK_PRESETS: { key: string; label: string; effects: { type: string; intensity: number }[] }[] = [
  { key: 'none', label: 'オリジナル', effects: [] },
  { key: 'vivid', label: 'ビビッド', effects: [{ type: 'saturate', intensity: 0.72 }, { type: 'contrast', intensity: 0.6 }] },
  { key: 'clean', label: 'クリア', effects: [{ type: 'brightness', intensity: 0.6 }, { type: 'saturate', intensity: 0.56 }] },
  { key: 'film', label: 'フィルム', effects: [{ type: 'sepia', intensity: 0.2 }, { type: 'contrast', intensity: 0.62 }] },
  { key: 'mono', label: 'モノクロ', effects: [{ type: 'grayscale', intensity: 1 }, { type: 'contrast', intensity: 0.6 }] },
  { key: 'dream', label: 'ドリーム', effects: [{ type: 'blur', intensity: 0.06 }, { type: 'brightness', intensity: 0.56 }] },
];
