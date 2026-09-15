import type { ReactNode } from 'react';
import { useDockGrip } from './editor/PanelDock';
import { Icon } from './Icon';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  onReset?: () => void;
}

export function Slider({ value, min, max, step = 0.01, onChange, format, onReset }: SliderProps) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <button
        type="button"
        className="slider-value"
        title="ダブルクリックでリセット"
        onDoubleClick={() => onReset?.()}
      >
        {format ? format(value) : value.toFixed(2)}
      </button>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="color-input">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span>{value.toUpperCase()}</span>
    </div>
  );
}

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  // 編集画面に置かれているときだけ、見出しを掴んでパネルごと動かせる。
  const grip = useDockGrip();
  // 重ねてタブになっているときは、名前はタブ側に出ている。
  // ここでもう一度出すと同じ文字が 2 行並ぶので、操作ボタンだけを残す。
  const showHead = !grip?.grouped || !!action;

  return (
    <section className={`panel${grip?.dragging ? ' dragging' : ''}`}>
      {showHead && (
        <header
          className={`panel-head${grip ? ' grabbable' : ''}${grip?.grouped ? ' in-group' : ''}`}
          onPointerDown={grip?.onPointerDown}
          title={grip ? 'ドラッグで移動（他のパネルの見出しへ重ねるとタブになります）' : undefined}
        >
          {!grip?.grouped && <h2>{title}</h2>}
          {/* 操作ボタンは右端にまとめる。見出しとの間の余白が、掴むための場所になる。 */}
          <div className="panel-head-tail">
            {action}
            {grip && !grip.grouped && (
              <button type="button" className="panel-close" aria-label={`${title} を仕舞う`} onClick={grip.hide}>
                <Icon name="xmark" size={15} />
              </button>
            )}
          </div>
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="empty-hint">{children}</p>;
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ---------- アイコン ----------
   狭い場所に置くボタン用の呼び名。実体は components/Icon.tsx に一本化してある。
   仕組みが 2 つあると線幅や端の丸みが揃わないため。
   ここに残しているのは、呼び出し側の書き味を変えないため。 */

/** 表示中。 */
export function EyeIcon() {
  return <Icon name="eye" size={15} label="表示中" />;
}

/** 非表示。 */
export function EyeOffIcon() {
  return <Icon name="eye-off" size={15} label="非表示" />;
}

/** 音あり。 */
export function SoundIcon() {
  return <Icon name="sound" size={15} label="音あり" />;
}

/** ミュート。 */
export function MuteIcon() {
  return <Icon name="mute" size={15} label="ミュート" />;
}
