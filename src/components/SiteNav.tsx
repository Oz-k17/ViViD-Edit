import { NavLink } from 'react-router-dom';
import { t } from '../i18n';
import { useApp } from '../store/app';

const LINKS = [
  { to: '/', label: 'エディタ', short: 'エディタ', end: true },
  { to: '/media-library', label: '素材管理', short: '素材', end: false },
  { to: '/templates', label: 'テンプレート集', short: 'テンプレ', end: false },
  { to: '/settings', label: '設定', short: '設定', end: false },
];

export function SiteNav() {
  // スマホ幅では書き出しボタンまで入りきらないので、見出しを短くする
  const { settings } = useApp();
  const short = settings.layout === 'mobile';
  return (
    <nav className="site-nav">
      {LINKS.map((link) => (
        <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          {t(short ? link.short : link.label)}
        </NavLink>
      ))}
    </nav>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">▮</span>
      <div>
        <strong>タテヨコ Studio</strong>
        <small>ショート動画エディタ</small>
      </div>
    </div>
  );
}
