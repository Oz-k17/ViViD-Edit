import { useApp } from '../store/app';

/**
 * PC 表示とスマホ表示の切り替え。
 * 端末判定で勝手に変えると外れたときに直せないので、明示的なボタンにしてある。
 */
export function LayoutToggle() {
  const { settings, updateSettings } = useApp();
  const mobile = settings.layout === 'mobile';
  return (
    <button
      type="button"
      className={`layout-toggle${mobile ? ' active' : ''}`}
      aria-pressed={mobile}
      title={mobile ? 'PC 表示に切り替える' : 'スマホ表示に切り替える'}
      onClick={() => updateSettings({ layout: mobile ? 'desktop' : 'mobile' })}
    >
      {mobile ? '📱' : '🖥'}
    </button>
  );
}
