import { useState } from 'react';
import { t } from '../../i18n';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { Brand, SiteNav } from '../SiteNav';

export function TopBar({ onExport, onHelp }: { onExport: () => void; onHelp: () => void }) {
  const { project, sequence, dispatch, canUndo, canRedo } = useEditor();
  const { addTemplate } = useApp();
  const [saved, setSaved] = useState(false);

  const saveLayout = () => {
    const name = window.prompt('テンプレート名', project.name);
    if (!name) return;
    addTemplate({ kind: 'layout', name, sequence });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <header className="topbar">
      <Brand />
      <SiteNav />
      <div className="topbar-actions">
        <button type="button" disabled={!canUndo} onClick={() => dispatch({ type: 'undo' })} title="元に戻す">
          ↺ {t('戻す')}
        </button>
        <button type="button" disabled={!canRedo} onClick={() => dispatch({ type: 'redo' })} title="やり直す">
          ↻ {t('進む')}
        </button>
        <button type="button" onClick={saveLayout}>
          {saved ? '保存しました' : '⌂ レイアウトを保存'}
        </button>
        <button type="button" onClick={onHelp}>
          ? {t('ショートカット')}
        </button>
        <button type="button" className="primary" onClick={onExport}>
          ⬇ {t('書き出し')}
        </button>
      </div>
    </header>
  );
}
