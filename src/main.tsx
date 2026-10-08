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

const container = document.getElementById('root');
if (!container) throw new Error('#root が見つかりません');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
