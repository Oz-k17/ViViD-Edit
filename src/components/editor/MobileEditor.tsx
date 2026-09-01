import { useEffect, useRef, useState } from 'react';
import { player } from '../../engine/player';
import { removeClips, splitAt } from '../../model/ops';
import { useEditor } from '../../store/editor';
import { Inspector } from './Inspector';
import { MediaPanel } from './MediaPanel';
import { MultiTimeline } from './MultiTimeline';
import { PreviewStage } from './PreviewStage';

type Sheet = 'media' | 'edit' | 'timeline';

const SHEETS: { value: Sheet; label: string }[] = [
  { value: 'media', label: '素材' },
  { value: 'edit', label: '編集' },
  { value: 'timeline', label: 'タイムライン' },
];

/**
 * スマホ向けの 1 カラムレイアウト。
 * 画面が狭いので、プレビューを常に上に置き、素材 / 編集 / タイムラインは下のシートで切り替える。
 * キーボードが使えない前提なので、分割・削除・テロップ追加はボタンで常に出しておく。
 */
export function MobileEditor({
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
  const [sheet, setSheet] = useState<Sheet>('timeline');
  const [height, setHeight] = useState(() => Math.round(window.innerHeight * 0.36));
  const collapsedHeight = 42;
  const collapsed = height <= collapsedHeight + 2;

  const clamp = (value: number) =>
    Math.max(collapsedHeight, Math.min(Math.round(window.innerHeight * 0.72), value));

  // 画面を回したときに、はみ出したままにならないようにする
  useEffect(() => {
    const onResize = () => setHeight((h) => clamp(h));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** つまみを上下にドラッグしてシートの高さを変える。動かさずに離したら開閉。 */
  const grip = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);
  const onGripDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    grip.current = { startY: event.clientY, startH: height, moved: false };
  };
  const onGripMove = (event: React.PointerEvent) => {
    const state = grip.current;
    if (!state) return;
    const delta = state.startY - event.clientY;
    if (Math.abs(delta) > 4) state.moved = true;
    setHeight(clamp(state.startH + delta));
  };
  const onGripUp = () => {
    const state = grip.current;
    grip.current = null;
    if (state && !state.moved) {
      setHeight(collapsed ? Math.round(window.innerHeight * 0.36) : collapsedHeight);
    }
  };

  return (
    <div className="mobile">
      <div className="mobile-stage">
        <PreviewStage />
      </div>

      <div className="mobile-actions">
        <button type="button" onClick={onAddText}>
          ＋ テロップ
        </button>
        <button type="button" onClick={() => apply((seq) => splitAt(seq, player.time, selection))}>
          ✂ 分割
        </button>
        <button
          type="button"
          className="danger"
          disabled={selection.length === 0}
          onClick={() => apply((seq) => removeClips(seq, selection, false))}
        >
          🗑 削除
        </button>
        <button
          type="button"
          disabled={selection.length === 0}
          onClick={() => apply((seq) => removeClips(seq, selection, true))}
        >
          ⇤ 詰めて削除
        </button>
      </div>

      <div className="mobile-sheet" style={{ height }}>
        <div
          className="mobile-grip"
          role="separator"
          aria-label="シートの高さを変える"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          <span />
        </div>
        <div className="mobile-tabs" role="tablist">
          {SHEETS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={sheet === option.value}
              className={sheet === option.value ? 'active' : ''}
              onClick={() => setSheet(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="mobile-sheet-body" hidden={collapsed}>
          {sheet === 'media' && <MediaPanel />}
          {sheet === 'edit' && <Inspector />}
          {sheet === 'timeline' && (
            <MultiTimeline pps={pps} setPps={setPps} onPickTransition={onPickTransition} compact />
          )}
        </div>
      </div>
    </div>
  );
}
