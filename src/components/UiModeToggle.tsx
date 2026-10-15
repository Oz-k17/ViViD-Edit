import type { ReactNode } from 'react';
import { useApp, type UiMode } from '../store/app';

const OPTIONS: { value: UiMode; label: string; hint: string }[] = [
  { value: 'easy', label: 'かんたん', hint: 'よく使う操作だけを表示します' },
  { value: 'full', label: 'くわしく', hint: 'すべての機能を表示します' },
];

/** 画面の複雑さの切り替え。どちらにしても、機能が消えるわけではない（くわしくへ戻せば全部出る）。 */
export function UiModeToggle() {
  const { settings, updateSettings } = useApp();
  return (
    <div className="ui-mode" role="radiogroup" aria-label="表示の詳しさ">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={settings.uiMode === o.value}
          className={settings.uiMode === o.value ? 'active' : ''}
          title={o.hint}
          onClick={() => updateSettings({ uiMode: o.value })}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** いま「かんたん」表示か。 */
export function useEasy(): boolean {
  return useApp().settings.uiMode === 'easy';
}

/**
 * 「かんたん」では畳み、「くわしく」ではそのまま出す。
 * 機能を消すのではなく、押せば開く。初めての人の目に入る量を減らすための入れ物。
 */
export function MoreSettings({ summary, children }: { summary: string; children: ReactNode }) {
  const easy = useEasy();
  if (!easy) return <>{children}</>;
  return (
    <details className="more-settings">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
