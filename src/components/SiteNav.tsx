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
      {/* 縦型（9:16）の画面に再生マーク。このアプリが何を作る道具かを一目で示す。 */}
      <svg className="brand-mark" width="18" height="18" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
        <rect x="7" y="2.5" width="12" height="21" rx="3.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M11.2 9.4v7.2l5.6-3.6-5.6-3.6Z" fill="currentColor" />
      </svg>
      <div>
        <strong>ViViD Edit</strong>
        <small>ショート動画エディタ</small>
      </div>
    </div>
  );
}
