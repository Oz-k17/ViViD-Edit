import type { ReactNode } from 'react';

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
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {action}
      </header>
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
   トラックの表示 / ミュート切り替えなど、狭い場所に置くボタン用。
   絵文字はフォント任せで大きさも字面もばらつくので、線画の SVG で揃える。
   色は currentColor に任せ、状態（off クラス）は呼び出し側の CSS で付ける。 */

function Icon({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
    >
      {children}
    </svg>
  );
}

/** 表示中。 */
export function EyeIcon() {
  return (
    <Icon label="表示中">
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </Icon>
  );
}

/** 非表示。 */
export function EyeOffIcon() {
  return (
    <Icon label="非表示">
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.8" />
      <path d="M6.5 7.8A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.9 9.9 0 0 0 4-.8" />
      <path d="M9.9 9.9a2.6 2.6 0 0 0 3.6 3.7" />
    </Icon>
  );
}

/** 音あり。 */
export function SoundIcon() {
  return (
    <Icon label="音あり">
      <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4Z" />
      <path d="M15.6 9.4a3.6 3.6 0 0 1 0 5.2" />
      <path d="M18 7a7 7 0 0 1 0 10" />
    </Icon>
  );
}

/** ミュート。 */
export function MuteIcon() {
  return (
    <Icon label="ミュート">
      <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4Z" />
      <path d="M16.5 10l4 4" />
      <path d="M20.5 10l-4 4" />
    </Icon>
  );
}
