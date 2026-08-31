import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { EditorProvider } from './store/editor';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root が見つかりません');

createRoot(container).render(
  <StrictMode>
    <EditorProvider>
      <App />
    </EditorProvider>
  </StrictMode>,
);
