import { useState } from 'react';
import { t } from '../../i18n';
import { useApp, useShortcutHint } from '../../store/app';
import { useEditor } from '../../store/editor';
import { LayoutToggle } from '../LayoutToggle';
import { UiModeToggle } from '../UiModeToggle';
import { Brand, SiteNav } from '../SiteNav';
import { PanelChecks } from './PanelDock';
import { Icon } from '../Icon';

/**
 * 上のバー。
 *
 * 決まりは「ひとつのボタンに、アイコンと文字を両方書かない」。両方を並べるとバーが
 * 詰まって見えるので、よく使う操作（戻す・進む・使い方）はアイコンだけ、ページ移動と
 * 「書き出し」は文字だけにしている。アイコンだけのボタンには title と読み上げ名を付ける。
 * 使う頻度の低いもの（パネル・レイアウトの保存・スマホ表示）は「その他」にまとめる。
 */
export function TopBar({ onExport, onHelp }: { onExport: () => void; onHelp: () => void }) {
  const { project, sequence, dispatch, canUndo, canRedo } = useEditor();
  const { addTemplate, settings, updateSettings } = useApp();
  const [saved, setSaved] = useState(false);
  const [menu, setMenu] = useState(false);
  const hint = useShortcutHint();
  // スマホ表示にはパネルの置き場そのものが無いので出さない。
  const mobile = settings.layout === 'mobile';
  const easy = settings.uiMode === 'easy';
  const hiddenPanels = settings.panels.hidden.length;

  const saveLayout = () => {
    const name = window.prompt('テンプレート名', project.name);
    if (!name) return;
    addTemplate({ kind: 'layout', name, sequence });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const undoLabel = `元に戻す${hint('undo')}`;
  const redoLabel = `やり直す${hint('redo')}`;
  const helpLabel = easy ? '使い方' : t('ショートカット');

  return (
    <header className="topbar">
      <Brand />
      <SiteNav />
      <div className="topbar-actions">
        <UiModeToggle />
        <button type="button" className="icon-btn" disabled={!canUndo} onClick={() => dispatch({ type: 'undo' })} title={undoLabel} aria-label={undoLabel}>
          <Icon name="undo" />
        </button>
        <button type="button" className="icon-btn" disabled={!canRedo} onClick={() => dispatch({ type: 'redo' })} title={redoLabel} aria-label={redoLabel}>
          <Icon name="redo" />
        </button>
        <span className="topbar-sep desktop-only" aria-hidden="true" />
        <button type="button" className="icon-btn desktop-only" onClick={onHelp} title={helpLabel} aria-label={helpLabel}>
          <Icon name="question" />
        </button>
        {/* スマホ表示では、入れるものが表示の切り替えだけになるので、そのまま置く。 */}
        {mobile ? (
          <LayoutToggle />
        ) : (
          <div className="panel-menu">
            <button
              type="button"
              className={`icon-btn${hiddenPanels > 0 ? ' has-hidden' : ''}`}
              aria-expanded={menu}
              aria-haspopup="true"
              onClick={() => setMenu((v) => !v)}
              title="その他（パネル・レイアウトの保存・スマホ表示）"
              aria-label="その他（パネル・レイアウトの保存・スマホ表示）"
            >
              <Icon name="more" />
            </button>
            {menu && (
              <>
                {/* 外側を押したら閉じる。メニューの外に置いたクリック受け。 */}
                <div className="panel-menu-scrim" onClick={() => setMenu(false)} />
                <div className="panel-menu-list">
                  {!easy && (
                    <>
                      <span className="menu-heading">出すパネル</span>
                      <PanelChecks />
                      <hr />
                      <button type="button" className="menu-item" onClick={saveLayout}>
                        {saved ? '保存しました' : 'レイアウトを保存'}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenu(false);
                      updateSettings({ layout: 'mobile' });
                    }}
                  >
                    スマホ表示に切り替える
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <button type="button" className="primary" onClick={onExport}>
          {t('書き出し')}
        </button>
      </div>
    </header>
  );
}
