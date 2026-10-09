import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { mediaRegistry } from './engine/media';
import { player } from './engine/player';
import * as thumbstrip from './engine/thumbstrip';

// 開発サーバーのときだけ、動作テストからアプリと同じ実体を見られるようにする（配布物には入らない）。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vivid = { player, mediaRegistry, thumbstrip };
}

/**
 * iPad アプリ版（WKWebView）は、メモリが足りなくなると OS に表示プロセスを終了させられ、
 * Swift 側が画面を読み込み直す（EditorWebView.swift）。そのことを使う人に知らせる。
 * 編集内容は自動保存から復元される（直前の数秒ぶんは失われることがある）。
 */
function showRecoveredNotice() {
  try {
    const key = 'vivid-edit.recoveries';
    const count = Number(localStorage.getItem(key) ?? '0') + 1;
    localStorage.setItem(key, String(count));
    localStorage.setItem(key + '.at', new Date().toISOString());
  } catch {
    /* 数えられなくても知らせは出す */
  }
  const box = document.createElement('div');
  box.textContent =
    '端末のメモリが足りなくなり、画面を読み込み直しました。編集内容は自動保存から戻しています（直前の数秒ぶんは失われることがあります）。' +
    '重い動画を使っているなら、プレビュー画質を下げるか、使っていない素材を消すと起きにくくなります。（タップで閉じる）';
  Object.assign(box.style, {
    position: 'fixed',
    left: '12px',
    right: '12px',
    bottom: '12px',
    zIndex: '99999',
    padding: '12px 14px',
    borderRadius: '12px',
    background: '#3a2a12',
    color: '#ffd7a0',
    font: '13px/1.5 -apple-system, system-ui, sans-serif',
    boxShadow: '0 4px 18px rgba(0,0,0,.5)',
  } as Partial<CSSStyleDeclaration>);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 20_000);
}
if ((window as unknown as { __vividRecovered?: boolean }).__vividRecovered) showRecoveredNotice();
window.addEventListener('vivid-recovered', showRecoveredNotice);

const container = document.getElementById('root');
if (!container) throw new Error('#root が見つかりません');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
