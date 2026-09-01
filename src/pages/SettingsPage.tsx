import { useState } from 'react';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { Field, Panel, Segmented, Toggle } from '../components/ui';
import { ASPECT_PRESETS } from '../model/types';
import {
  SHORTCUT_LABELS,
  shortcutFromEvent,
  shortcutLabel,
  useApp,
  type ShortcutAction,
} from '../store/app';
import type { Lang } from '../i18n';

export default function SettingsPage() {
  const { settings, updateSettings, resetShortcuts } = useApp();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  /** キーを 1 つ押して割り当てを覚える。 */
  const record = (action: ShortcutAction) => {
    setRecording(action);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setRecording(null);
        window.removeEventListener('keydown', onKey, true);
        return;
      }
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight'].includes(event.code)) {
        return;
      }
      updateSettings({ shortcuts: { ...settings.shortcuts, [action]: shortcutFromEvent(event) } });
      setRecording(null);
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <SiteNav />
        <div className="topbar-actions">
          <LayoutToggle />
        </div>
      </header>

      <main className="page-body">
        <Panel title="表示">
          <Field label="インターフェースの言語">
            <Segmented<Lang>
              value={settings.lang}
              options={[
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' },
              ]}
              onChange={(lang) => updateSettings({ lang })}
            />
          </Field>
          <Toggle label="タイムラインでクリップの端に吸着する" checked={settings.snap} onChange={(snap) => updateSettings({ snap })} />
        </Panel>

        <Panel title="書き出しの既定値">
          <Field label="アスペクト比">
            <div className="chip-row wrap">
              {ASPECT_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={settings.exportAspect === preset.key ? 'chip active' : 'chip'}
                  onClick={() => updateSettings({ exportAspect: preset.key })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="画質">
            <Segmented
              value={String(settings.exportQuality)}
              options={[
                { value: '1080', label: '1080p' },
                { value: '720', label: '720p' },
                { value: '480', label: '480p' },
              ]}
              onChange={(value) => updateSettings({ exportQuality: Number(value) })}
            />
          </Field>
          <Field label="形式">
            <Segmented
              value={settings.exportFormat}
              options={[
                { value: 'auto', label: 'おまかせ' },
                { value: 'mp4', label: 'MP4' },
                { value: 'webm', label: 'WebM' },
              ]}
              onChange={(value) => updateSettings({ exportFormat: value as typeof settings.exportFormat })}
            />
          </Field>
        </Panel>

        <Panel
          title="ショートカットキー"
          action={
            <button type="button" onClick={resetShortcuts}>
              既定に戻す
            </button>
          }
        >
          <ul className="shortcut-list">
            {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
              <li key={action}>
                <span>{SHORTCUT_LABELS[action]}</span>
                <button
                  type="button"
                  className={recording === action ? 'active' : ''}
                  onClick={() => record(action)}
                  title="クリックしてから新しいキーを押してください（Esc で中止）"
                >
                  {recording === action ? 'キーを押す…' : shortcutLabel(settings.shortcuts[action])}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </main>
    </div>
  );
}
