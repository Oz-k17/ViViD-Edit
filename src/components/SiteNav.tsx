import { NavLink } from 'react-router-dom';
import { t } from '../i18n';

const LINKS = [
  { to: '/', label: 'エディタ', end: true },
  { to: '/media-library', label: '素材管理', end: false },
  { to: '/templates', label: 'テンプレート集', end: false },
  { to: '/settings', label: '設定', end: false },
];

export function SiteNav() {
  return (
    <nav className="site-nav">
      {LINKS.map((link) => (
        <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          {t(link.label)}
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
