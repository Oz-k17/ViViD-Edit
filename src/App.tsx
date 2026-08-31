import { useEffect, useState } from 'react';
import { ExportPanel } from './components/ExportPanel';
import { Inspector } from './components/Inspector';
import { MediaLibrary, importFiles } from './components/MediaLibrary';
import { Preview } from './components/Preview';
import { ProjectSettings } from './components/ProjectSettings';
import { Timeline } from './components/Timeline';
import { player } from './engine/player';
import { makeTextOverlay, useEditor } from './store/editor';

const SHORTCUTS: [string, string][] = [
  ['Space', '再生 / 一時停止'],
  ['← →', '1 フレーム移動（Shift で 1 秒）'],
  ['S', '再生位置で分割'],
  ['T', 'テキストを追加'],
  ['M', '選択クリップのミュート切替'],
  ['Delete', '選択中のクリップ / テキストを削除'],
  ['Ctrl / ⌘ + Z', '元に戻す（Shift 併用でやり直す）'],
  ['Ctrl / ⌘ + D', 'クリップを複製'],
  ['Home / End', '先頭 / 末尾へ'],
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export default function App() {
  const { project, dispatch, selection, select, canUndo, canRedo } = useEditor();
  const [dropping, setDropping] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'history/redo' : 'history/undo' });
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'history/redo' });
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        if (selection.type === 'clip') {
          event.preventDefault();
          dispatch({ type: 'clip/duplicate', id: selection.id });
        }
        return;
      }
      if (mod) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          player.toggle();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          player.nudge(event.shiftKey ? -1 : -1 / (project.fps || 30));
          break;
        case 'ArrowRight':
          event.preventDefault();
          player.nudge(event.shiftKey ? 1 : 1 / (project.fps || 30));
          break;
        case 'Home':
          player.seek(0);
          break;
        case 'End':
          player.seek(player.duration);
          break;
        case 'Delete':
        case 'Backspace':
          if (selection.type === 'clip') dispatch({ type: 'clip/remove', id: selection.id });
          else if (selection.type === 'text') dispatch({ type: 'text/remove', id: selection.id });
          else if (selection.type === 'music') dispatch({ type: 'music/set', music: null });
          else return;
          select({ type: 'none' });
          break;
        case 's':
        case 'S':
          dispatch({ type: 'clip/split', time: player.time });
          break;
        case 't':
        case 'T': {
          const overlay = makeTextOverlay('caption', player.time, 3);
          dispatch({ type: 'text/add', overlay });
          select({ type: 'text', id: overlay.id });
          break;
        }
        case 'm':
        case 'M':
          if (selection.type === 'clip') {
            const clip = project.clips.find((c) => c.id === selection.id);
            if (clip) dispatch({ type: 'clip/patch', id: clip.id, patch: { muted: !clip.muted } });
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch, project, selection, select]);

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDropping(false);
    if (!event.dataTransfer.files.length) return;
    const errors = await importFiles(event.dataTransfer.files);
    setImportError(errors.length ? errors.join(' / ') : null);
  };

  return (
    <div
      className={`app${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▮</span>
          <div>
            <strong>タテヨコ Studio</strong>
            <small>ショート動画エディタ</small>
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" disabled={!canUndo} onClick={() => dispatch({ type: 'history/undo' })} title="元に戻す">
            ↺ 戻す
          </button>
          <button type="button" disabled={!canRedo} onClick={() => dispatch({ type: 'history/redo' })} title="やり直す">
            ↻ 進む
          </button>
          <button type="button" className={showHelp ? 'active' : ''} onClick={() => setShowHelp((v) => !v)}>
            ? ショートカット
          </button>
        </div>
      </header>

      {importError && <div className="banner error">{importError}</div>}

      <main className="workspace">
        <aside className="rail left">
          <MediaLibrary />
          <ProjectSettings />
        </aside>

        <section className="stage">
          <Preview />
        </section>

        <aside className="rail right">
          <Inspector />
          <ExportPanel />
        </aside>
      </main>

      <footer className="dock">
        <Timeline />
      </footer>

      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>キーボードショートカット</h2>
            <dl className="shortcuts">
              {SHORTCUTS.map(([keys, description]) => (
                <div key={keys}>
                  <dt>{keys}</dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
            <button type="button" className="wide" onClick={() => setShowHelp(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {dropping && <div className="drop-overlay">ここにドロップして読み込み</div>}
    </div>
  );
}
