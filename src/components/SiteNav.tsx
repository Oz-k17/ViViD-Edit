import { NavLink } from '../router';
import { t } from '../i18n';
import { useApp } from '../store/app';
import { useOutputs } from '../store/outputs';

const LINKS = [
  { to: '/', label: 'エディタ', short: 'エディタ', end: true },
  { to: '/media-library', label: '素材管理', short: '素材', end: false },
  { to: '/templates', label: 'テンプレート集', short: 'テンプレ', end: false },
  { to: '/text-styles', label: 'テキストスタイル', short: '文字', end: false },
  { to: '/outputs', label: '完成品', short: '完成品', end: false },
  { to: '/settings', label: '設定', short: '設定', end: false },
];

export function SiteNav() {
  // スマホ幅では書き出しボタンまで入りきらないので、見出しを短くする
  const { settings } = useApp();
  const short = settings.layout === 'mobile';
  const waiting = useOutputs().filter((item) => item.status === 'check').length;
  return (
    <nav className="site-nav">
      {LINKS.map((link) => (
        <NavLink key={link.to} to={link.to} end={link.end}>
          {t(short ? link.short : link.label)}
          {/* 確認待ちが残っていることを、数で知らせる。 */}
          {link.to === '/outputs' && waiting > 0 && <span className="nav-badge">{waiting}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

export function Brand() {
  return (
    <div className="brand">
      {/* 縦型（9:16）の画面を、斜めに 1 本カットした形。「縦型動画を切って編集する道具」を表す。
          カットの線は上のバーの地の色で抜く。 */}
      <svg className="brand-mark" width="24" height="24" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
        <rect x="6" y="1.5" width="14" height="23" rx="4.5" fill="currentColor" />
        <path d="M2 17.5 24 9.5" stroke="var(--bg-raised)" strokeWidth="3" />
      </svg>
      <div>
        <strong>ViViD Edit</strong>
      </div>
    </div>
  );
}
