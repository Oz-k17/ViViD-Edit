import { useRef, useState } from 'react';
import { colorGradingSupported } from '../../engine/colorPass';
import { COLOR_PRESETS, isNeutralGrade, makeCurve, parseCube, shrinkCube, type ColorGrade, type ColorWheel } from '../../model/color';
import type { Clip } from '../../model/types';
import { useEditor } from '../../store/editor';
import { useEasy } from '../UiModeToggle';
import { ButtonField, Field, Slider } from '../ui';

/**
 * 色調整（カラーグレーディング）。ワンタッチのプリセット → 基本（露出・コントラスト・彩度・色温度・色かぶり）
 * → 3 つのホイール（暗部・中間・明部）→ トーンカーブ → LUT の読み込み、の順に並べる。
 * かんたん表示ではプリセットと基本だけを出し、ほかは「くわしい設定」の中に置く。
 */
export function ColorSection({ clip }: { clip: Clip }) {
  const { apply } = useEditor();
  const easy = useEasy();
  const grade: ColorGrade = clip.color ?? {};
  const patch = (next: ColorGrade | undefined, key?: string) =>
    apply(
      (seq) => ({ ...seq, clips: seq.clips.map((c) => (c.id === clip.id ? { ...c, color: next } : c)) }),
      key ? `color:${key}:${clip.id}` : undefined,
    );
  const set = (changes: Partial<ColorGrade>, key?: string) => patch({ ...grade, ...changes, preset: null }, key);
  const supported = colorGradingSupported();

  const basics: { key: keyof ColorGrade; label: string; left: string; right: string }[] = [
    { key: 'exposure', label: '明るさ（露出）', left: '暗く', right: '明るく' },
    { key: 'contrast', label: 'コントラスト', left: '眠く', right: 'くっきり' },
    { key: 'saturation', label: '彩度', left: '淡く', right: '鮮やかに' },
    { key: 'temperature', label: '色温度', left: '青', right: '黄' },
    { key: 'tint', label: '色かぶり', left: '緑', right: 'マゼンタ' },
  ];

  const advanced = (
    <>
      <ButtonField label="ホイール" hint="暗い所・中間・明るい所に、それぞれ色を足します（中心から離すほど強く）">
        <div className="wheel-row">
          {(['lift', 'gamma', 'gain'] as const).map((part) => (
            <WheelControl
              key={part}
              label={part === 'lift' ? '暗部' : part === 'gamma' ? '中間' : '明部'}
              value={grade[part]}
              onChange={(wheel) => set({ [part]: wheel }, part)}
            />
          ))}
        </div>
      </ButtonField>
      <ButtonField label="トーンカーブ" hint="点をつまんで上下させます。上げると明るく、下げると暗く">
        <ToneCurve points={grade.curve ?? [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]]} onChange={(curve) => set({ curve }, 'curve')} />
      </ButtonField>
      <LutField grade={grade} set={set} />
    </>
  );

  return (
    <div className="color-section">
      {!supported && (
        <p className="warn small" role="note">
          この端末では色調整が映りません（WebGL が使えないため）。書き出しにも入りません。
        </p>
      )}
      <ButtonField label="色調整のプリセット">
        <div className="chip-row wrap">
          {COLOR_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={grade.preset === preset.key ? 'chip active' : 'chip'}
              onClick={() => patch({ ...preset.grade, lut: grade.lut, lutMix: grade.lutMix, preset: preset.key })}
            >
              {preset.label}
            </button>
          ))}
          {!isNeutralGrade(grade) && (
            <button type="button" className="chip ghost" onClick={() => patch(undefined)}>
              元の色に戻す
            </button>
          )}
        </div>
      </ButtonField>
      {basics.map(({ key, label, left, right }) => (
        <Field key={key} label={label}>
          <Slider
            value={(grade[key] as number | undefined) ?? 0}
            min={-1}
            max={1}
            step={0.01}
            onChange={(v) => set({ [key]: v }, key)}
            format={(v) => (Math.abs(v) < 0.005 ? '±0' : `${v > 0 ? right : left} ${Math.round(Math.abs(v) * 100)}`)}
            onReset={() => set({ [key]: 0 })}
          />
        </Field>
      ))}
      {easy ? (
        <details className="more-settings">
          <summary>くわしい設定（ホイール・トーンカーブ・LUT）</summary>
          {advanced}
        </details>
      ) : (
        advanced
      )}
    </div>
  );
}

/** 色の輪。真ん中は色を足さない。つまんだ所の向きが色相、中心からの距離が強さ。下のつまみは明るさ。 */
function WheelControl({ label, value, onChange }: { label: string; value?: ColorWheel; onChange: (w: ColorWheel) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const wheel: ColorWheel = value ?? { hue: 0, amount: 0, luma: 0 };
  const angle = (wheel.hue * Math.PI) / 180;
  // 画面の上を 0°（赤）から時計回りに見せる。
  const dotX = 50 + Math.sin(angle) * wheel.amount * 50;
  const dotY = 50 - Math.cos(angle) * wheel.amount * 50;

  const pick = (event: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const dx = (event.clientX - box.left) / box.width - 0.5;
    const dy = (event.clientY - box.top) / box.height - 0.5;
    const amount = Math.min(1, Math.hypot(dx, dy) * 2);
    const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    onChange({ ...wheel, hue: Math.round(hue), amount: amount < 0.04 ? 0 : Math.round(amount * 100) / 100 });
  };

  return (
    <div className="wheel">
      <div
        ref={ref}
        className="wheel-disc"
        role="slider"
        tabIndex={0}
        aria-label={`${label}の色`}
        aria-valuetext={wheel.amount > 0 ? `色相 ${wheel.hue}°・強さ ${Math.round(wheel.amount * 100)}` : '色を足さない'}
        aria-valuenow={Math.round(wheel.amount * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons) pick(e);
        }}
        onDoubleClick={() => onChange({ ...wheel, amount: 0 })}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 15 : 5;
          if (e.key === 'ArrowLeft') onChange({ ...wheel, hue: (wheel.hue - step + 360) % 360 });
          else if (e.key === 'ArrowRight') onChange({ ...wheel, hue: (wheel.hue + step) % 360 });
          else if (e.key === 'ArrowUp') onChange({ ...wheel, amount: Math.min(1, wheel.amount + 0.05) });
          else if (e.key === 'ArrowDown') onChange({ ...wheel, amount: Math.max(0, wheel.amount - 0.05) });
          else return;
          e.preventDefault();
        }}
      >
        <span className="wheel-dot" style={{ left: `${dotX}%`, top: `${dotY}%` }} />
      </div>
      <span className="wheel-label">{label}</span>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={wheel.luma}
        aria-label={`${label}の明るさ`}
        onChange={(e) => onChange({ ...wheel, luma: Number(e.target.value) })}
        onDoubleClick={() => onChange({ ...wheel, luma: 0 })}
      />
    </div>
  );
}

/** トーンカーブ。点は 3 つ（暗い所・真ん中・明るい所）で、上下にだけ動かす（左右に動かすと点が入れ替わって分かりにくい）。 */
function ToneCurve({ points, onChange }: { points: [number, number][]; onChange: (p: [number, number][]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const curve = makeCurve(points);
  const W = 160;
  const path = Array.from({ length: 41 }, (_, i) => {
    const x = i / 40;
    return `${i === 0 ? 'M' : 'L'}${(x * W).toFixed(1)},${((1 - curve(x)) * W).toFixed(1)}`;
  }).join(' ');
  const move = (event: React.PointerEvent, index: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const y = 1 - Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
    onChange(points.map((p, i) => (i === index ? [p[0], Math.round(y * 100) / 100] : p)) as [number, number][]);
  };
  return (
    <div className="tone-curve">
      <svg ref={ref} viewBox={`0 0 ${W} ${W}`} width={W} height={W} role="group" aria-label="トーンカーブ">
        <path d={`M0,${W / 2}H${W}M${W / 2},0V${W}M0,${W / 4}H${W}M0,${(W * 3) / 4}H${W}M${W / 4},0V${W}M${(W * 3) / 4},0V${W}`} className="tone-grid" />
        <path d={`M0,${W}L${W},0`} className="tone-diagonal" />
        <path d={path} className="tone-line" />
        {points.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * W}
            cy={(1 - y) * W}
            r={dragging === i ? 8 : 6}
            className="tone-point"
            tabIndex={0}
            role="slider"
            aria-label={['暗い所', '真ん中', '明るい所'][i] ?? `点 ${i + 1}`}
            aria-valuenow={Math.round(y * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(i);
            }}
            onPointerMove={(e) => dragging === i && move(e, i)}
            onPointerUp={() => setDragging(null)}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowUp' ? 0.02 : e.key === 'ArrowDown' ? -0.02 : 0;
              if (!d) return;
              e.preventDefault();
              onChange(points.map((p, j) => (j === i ? [p[0], Math.max(0, Math.min(1, Math.round((p[1] + d) * 100) / 100))] : p)) as [number, number][]);
            }}
          />
        ))}
      </svg>
      <button type="button" className="ghost" onClick={() => onChange([[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]])}>
        まっすぐに戻す
      </button>
    </div>
  );
}

/** LUT（.cube）の読み込み。カメラの LOG を戻す表や、映画風の色の表をそのまま使える。 */
function LutField({ grade, set }: { grade: ColorGrade; set: (changes: Partial<ColorGrade>, key?: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <ButtonField label="LUT（.cube）" hint="カメラの LOG を戻す表や、色の表を読み込んで重ねます">
      <div className="lut-row">
        <input
          ref={input}
          type="file"
          accept=".cube"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              const lut = shrinkCube(parseCube(await file.text(), file.name.replace(/\.cube$/i, '')));
              setError(null);
              set({ lut, lutMix: 1 });
            } catch (err) {
              setError(`読み込めませんでした: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
        />
        <button type="button" onClick={() => input.current?.click()}>
          {grade.lut ? '別の LUT を選ぶ' : 'LUT を読み込む'}
        </button>
        {grade.lut && (
          <>
            <span className="muted small">{grade.lut.name}（{grade.lut.size}³）</span>
            <button type="button" className="ghost" onClick={() => set({ lut: null })}>
              外す
            </button>
          </>
        )}
      </div>
      {grade.lut && (
        <Slider
          value={grade.lutMix ?? 1}
          min={0}
          max={1}
          step={0.01}
          onChange={(lutMix) => set({ lutMix }, 'lutMix')}
          format={(v) => `${Math.round(v * 100)}%`}
          onReset={() => set({ lutMix: 1 })}
        />
      )}
      {error && <p className="error-note">{error}</p>}
    </ButtonField>
  );
}
