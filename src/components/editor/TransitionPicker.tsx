import { TRANSITION_META, type TransitionType } from '../../model/types';
import { useEditor } from '../../store/editor';
import { Field, Slider } from '../ui';
import { Icon } from '../Icon';
import { TRANSITION_ICON } from './transitionIcon';
import { Dual, Hint } from '../Hint';
import { TransitionDemo } from '../demos';

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
            <TransitionHint key={type} type={type}>
              <button
                type="button"
                className={clip.transitionIn.type === type ? 'transition-card active' : 'transition-card'}
                onClick={() => patch({ type })}
              >
                <span className="transition-icon"><Icon name={TRANSITION_ICON[type]} size={20} /></span>
                <TransitionName type={type} />
              </button>
            </TransitionHint>
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

/** 切り替えの名前（見たままの名前に、元の呼び名を添える）。 */
export function TransitionName({ type }: { type: TransitionType }) {
  const meta = TRANSITION_META[type];
  return <Dual plain={meta.plain} alias={meta.plain === meta.label ? undefined : meta.label} />;
}

/** カーソルを合わせると、切り替わり方が動いて見える。 */
export function TransitionHint({ type, children }: { type: TransitionType; children: React.ReactNode }) {
  const meta = TRANSITION_META[type];
  return (
    <Hint
      title={meta.plain}
      alias={meta.plain === meta.label ? undefined : meta.label}
      desc={meta.hint}
      demo={() => <TransitionDemo type={type} />}
    >
      {children}
    </Hint>
  );
}
