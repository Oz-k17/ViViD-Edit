import { useEffect, useSyncExternalStore } from 'react';
import { fontCss, fontRegistry } from '../engine/fonts';
import { FONT_OPTIONS } from '../presets';

/**
 * フォントの選び先（最初から入っているもの＋自分で足したもの）。
 * いまの値が一覧に無い（足したフォントを消した・別の端末で作った）ときも、選び先に残して黙って変わらないようにする。
 */
export function useFontOptions(current?: string): { value: string; label: string }[] {
  const fonts = useSyncExternalStore(fontRegistry.subscribe, () => fontRegistry.list());
  useEffect(() => {
    void fontRegistry.restore();
  }, []);
  const options = [
    ...FONT_OPTIONS,
    ...fonts.map((f) => ({ value: fontCss(f), label: `${f.label}（${f.source === 'file' ? '追加' : 'Google Fonts'}）` })),
  ];
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: `${current.split(',')[0].replace(/"/g, '')}（この端末に無いフォント）` });
  }
  return options;
}
