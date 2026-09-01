import { TRANSITION_META, type TransitionType } from '../../model/types';
import { useEditor } from '../../store/editor';
import { Field, Slider } from '../ui';

/** タイムラインの継ぎ目アイコンから開く、切り替え効果の選択ダイアログ。 */
export function TransitionPicker({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const { sequence, apply } = useEditor();
  const clip = sequence.clips.find((c) => c.id === clipId);
  if (!clip) return null;

  const patch = (changes: Partial<typeof clip.transitionIn>, key?: string) =>
    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => (c.id === clipId ? { ...c, transitionIn: { ...c.transitionIn, ...changes } } : c)),
      }),
      key,
    );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>カットの切り替え</h2>
        <div className="transition-grid">
          {(Object.keys(TRANSITION_META) as TransitionType[]).map((type) => (
            <button
              key={type}
              type="button"
              className={clip.transitionIn.type === type ? 'transition-card active' : 'transition-card'}
              onClick={() => patch({ type })}
            >
              <span className="transition-icon">{TRANSITION_META[type].icon}</span>
              {TRANSITION_META[type].label}
            </button>
          ))}
        </div>
        {clip.transitionIn.type !== 'none' && (
          <Field label="長さ" hint="秒">
            <Slider
              value={clip.transitionIn.duration}
              min={0.1}
              max={2}
              step={0.05}
              onChange={(duration) => patch({ duration }, `trDur:${clipId}`)}
              format={(v) => `${v.toFixed(2)}s`}
            />
          </Field>
        )}
        <button type="button" className="wide" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
