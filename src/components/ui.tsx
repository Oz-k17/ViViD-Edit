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
