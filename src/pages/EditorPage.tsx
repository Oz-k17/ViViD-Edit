import { useEffect, useState } from 'react';
import { Inspector } from '../components/editor/Inspector';
import { ExportDialog } from '../components/editor/ExportDialog';
import { MediaPanel, importFiles, seedSoundEffects } from '../components/editor/MediaPanel';
import { MobileEditor } from '../components/editor/MobileEditor';
import { MultiTimeline } from '../components/editor/MultiTimeline';
import { PreviewStage } from '../components/editor/PreviewStage';
import { TopBar } from '../components/editor/TopBar';
import { TransitionPicker } from '../components/editor/TransitionPicker';
import { DockProvider, DockSlot, DockSplitter, useDockGrip } from '../components/editor/PanelDock';
import { player } from '../engine/player';
import { textClip } from '../model/factory';
import { placeClip, removeClips, splitAt, tracksOf } from '../model/ops';
import {
  SHORTCUT_LABELS,
  shortcutFromEvent,
  shortcutLabel,
  useApp,
  type PanelId,
  type ShortcutAction,
} from '../store/app';
import { useEditor } from '../store/editor';
import { Icon } from '../components/Icon';

/**
 * 編集画面の本体。パネルは置き場（左 / 右 / 下）の中身として描き、
 * どこに何があるかは設定側が持っている。
 */
function Workspace({
  pps,
  setPps,
  onPickTransition,
  onAddText,
}: {
  pps: number;
  setPps: (value: number | ((prev: number) => number)) => void;
  onPickTransition: (clipId: string) => void;
  onAddText: () => void;
}) {
  const { apply, selection } = useEditor();
  const { settings, updatePanels } = useApp();
  const { panels } = settings;

  const renderPanel = (id: PanelId) => {
    if (id === 'media') return <MediaPanel />;
    if (id === 'inspector') return <Inspector />;
    return (
      <TimelinePanel
        pps={pps}
        setPps={setPps}
        onPickTransition={onPickTransition}
        onAddText={onAddText}
        onSplit={() => apply((seq) => splitAt(seq, player.time, selection))}
      />
    );
  };

  const hasLeft = panels.slots.left.length > 0;
  const hasRight = panels.slots.right.length > 0;
  const hasBottom = panels.slots.bottom.length > 0;

  return (
    <>
      <main className="workspace">
        <DockSlot slot="left" render={renderPanel} style={{ width: panels.leftWidth }} />
        {hasLeft && (
          <DockSplitter
            axis="x"
            value={panels.leftWidth}
            onChange={(leftWidth) => updatePanels({ leftWidth })}
            label="左パネルの幅"
          />
        )}
        <section className="stage">
          <PreviewStage />
        </section>
        {hasRight && (
          <DockSplitter
            axis="x"
            value={panels.rightWidth}
            sign={-1}
            onChange={(rightWidth) => updatePanels({ rightWidth })}
            label="右パネルの幅"
          />
        )}
        <DockSlot slot="right" render={renderPanel} style={{ width: panels.rightWidth }} />
      </main>

      {hasBottom && (
        <DockSplitter
          axis="y"
          value={panels.dockHeight}
          sign={-1}
          onChange={(dockHeight) => updatePanels({ dockHeight })}
          label="下段の高さ"
        />
      )}
      <DockSlot slot="bottom" render={renderPanel} style={{ height: panels.dockHeight }} />
    </>
  );
}

/** タイムラインだけはパネルの体裁を持っていないので、ここで見出しを付ける。 */
function TimelinePanel({
  pps,
  setPps,
  onPickTransition,
  onAddText,
  onSplit,
}: {
  pps: number;
  setPps: (value: number | ((prev: number) => number)) => void;
  onPickTransition: (clipId: string) => void;
  onAddText: () => void;
  onSplit: () => void;
}) {
  const grip = useDockGrip();
  return (
    <section className={`panel timeline-panel${grip?.dragging ? ' dragging' : ''}`}>
      <header
        className={`panel-head${grip ? ' grabbable' : ''}${grip?.grouped ? ' in-group' : ''}`}
        onPointerDown={grip?.onPointerDown}
        title={grip ? 'ドラッグで移動（他のパネルの見出しへ重ねるとタブになります）' : undefined}
      >
        {/* 重ねてタブになっているときは、名前はタブ側に出ている。 */}
        {!grip?.grouped && <h2>タイムライン</h2>}
        {/* ボタンは右端にまとめる。見出しとの間の余白が、掴むための場所になる。 */}
        <div className="panel-head-tail">
          <div className="panel-actions">
            <button type="button" onClick={onAddText}>
              <Icon name="plus" />テロップ
            </button>
            <button type="button" onClick={onSplit}>
              <Icon name="scissors" />分割
            </button>
          </div>
          {grip && !grip.grouped && (
            <button type="button" className="panel-close" aria-label="タイムラインを仕舞う" onClick={grip.hide}>
              <Icon name="xmark" size={15} />
            </button>
          )}
        </div>
      </header>
      <MultiTimeline pps={pps} setPps={setPps} onPickTransition={onPickTransition} />
    </section>
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export default function EditorPage() {
  const { sequence, apply, dispatch, selection, setSelection } = useEditor();
  const { settings } = useApp();
  const mobile = settings.layout === 'mobile';
  const [pps, setPps] = useState(60);
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [transitionFor, setTransitionFor] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    void seedSoundEffects();
  }, []);

  const addText = () => {
    const track = tracksOf(sequence, 'text')[0];
    if (!track) return;
    const clip = textClip(track.id, player.time, 3);
    apply((seq) => placeClip(seq, clip));
    setSelection([clip.id]);
  };

  useEffect(() => {
    const actions: Record<ShortcutAction, (event: KeyboardEvent) => void> = {
      playPause: () => player.toggle(),
      split: () => apply((seq) => splitAt(seq, player.time, selection)),
      addText,
      delete: () => apply((seq) => removeClips(seq, selection, false)),
      rippleDelete: () => apply((seq) => removeClips(seq, selection, true)),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      stepBack: (event) => player.nudge(event.shiftKey ? -1 : -1 / (sequence.fps || 30)),
      stepForward: (event) => player.nudge(event.shiftKey ? 1 : 1 / (sequence.fps || 30)),
      zoomIn: () => setPps((p) => Math.min(400, p * 1.4)),
      zoomOut: () => setPps((p) => Math.max(6, p / 1.4)),
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const combo = shortcutFromEvent(event);
      const entries = Object.entries(settings.shortcuts) as [ShortcutAction, string][];

      let action = entries.find(([, value]) => value === combo)?.[0];
      // Shift は「1 秒送り」の修飾としても使うので、見つからなければ外して探し直す
      if (!action && combo.startsWith('shift+')) {
        const stripped = combo.slice('shift+'.length);
        const found = entries.find(([, value]) => value === stripped)?.[0];
        if (found === 'stepBack' || found === 'stepForward') action = found;
      }
      if (!action && event.code === 'Backspace') {
        action = entries.find(([, value]) => value === (event.shiftKey ? 'shift+Delete' : 'Delete'))?.[0];
      }
      if (!action) {
        if (event.code === 'Home') player.seek(0);
        else if (event.code === 'End') player.seek(player.duration);
        else return;
        event.preventDefault();
        return;
      }
      event.preventDefault();
      actions[action](event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settings.shortcuts, selection, sequence, apply, dispatch]);

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDropping(false);
    if (event.dataTransfer.files.length) await importFiles(event.dataTransfer.files);
  };

  return (
    <div
      className={`app${dropping ? ' dropping' : ''}${mobile ? ' mobile-layout' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <TopBar onExport={() => setShowExport(true)} onHelp={() => setShowHelp(true)} />

      {mobile ? (
        <MobileEditor pps={pps} setPps={setPps} onPickTransition={setTransitionFor} onAddText={addText} />
      ) : (
        <DockProvider>
          <Workspace pps={pps} setPps={setPps} onPickTransition={setTransitionFor} onAddText={addText} />
        </DockProvider>
      )}

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {transitionFor && <TransitionPicker clipId={transitionFor} onClose={() => setTransitionFor(null)} />}
      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>キーボードショートカット</h2>
            <dl className="shortcuts">
              {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
                <div key={action}>
                  <dt>{shortcutLabel(settings.shortcuts[action])}</dt>
                  <dd>{SHORTCUT_LABELS[action]}</dd>
                </div>
              ))}
              <div>
                <dt>Home / End</dt>
                <dd>先頭 / 末尾へ</dd>
              </div>
            </dl>
            <p className="muted small">割り当ては「設定」ページで変更できます。</p>
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
