import { useState } from 'react';
import { mediaRegistry, type MediaAsset } from '../../engine/media';
import {
  LABEL_COLORS,
  LABEL_HEX,
  LABEL_NAMES,
  NOTE_MAX,
  labelCounts,
  normalizeNote,
  type LabelColor,
  type LabelFilter,
} from '../../model/labels';

/** 色の小さな丸。色タグの無い素材には出さない。 */
export function LabelDot({ color }: { color?: LabelColor }) {
  if (!color) return null;
  return <span className="label-dot" style={{ background: LABEL_HEX[color] }} title={`色タグ: ${LABEL_NAMES[color]}`} aria-label={`色タグ ${LABEL_NAMES[color]}`} />;
}

/** メモがあるとき、カードの隅に出す印。中身は吹き出し（title）で読める。 */
export function NoteBadge({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <span className="note-badge" title={note} aria-label="メモあり">
      メモ
    </span>
  );
}

/** 選んだ素材へ色を付ける（もう一度同じ色を押すと外れる）。 */
export function LabelSwatches({ ids }: { ids: string[] }) {
  const colors = ids.map((id) => mediaRegistry.get(id)?.color);
  const all = colors.length > 0 && colors.every((c) => c === colors[0]) ? colors[0] : undefined;
  return (
    <span className="label-swatches" role="group" aria-label="色タグ">
      色
      {LABEL_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={all === color ? 'swatch on' : 'swatch'}
          style={{ background: LABEL_HEX[color] }}
          title={all === color ? `${LABEL_NAMES[color]}を外す` : `${LABEL_NAMES[color]}を付ける`}
          aria-label={`${LABEL_NAMES[color]}${all === color ? 'を外す' : 'を付ける'}`}
          aria-pressed={all === color}
          onClick={() => mediaRegistry.setLabels(ids, { color: all === color ? undefined : color })}
        />
      ))}
      <button type="button" className="ghost swatch-clear" title="色タグを外す" aria-label="色タグを外す" onClick={() => mediaRegistry.setLabels(ids, { color: undefined })}>
        ×
      </button>
    </span>
  );
}

/**
 * 1 つ選んだ素材のメモ。入力欄を離れたとき（と Ctrl+Enter）に保存する。
 * 打つたびに保存すると、保存のたびに一覧が描き直されて入力が途切れる。
 */
export function NoteField({ asset }: { asset: MediaAsset }) {
  const [text, setText] = useState(asset.note ?? '');
  const save = () => {
    const next = normalizeNote(text);
    if (next !== asset.note) mediaRegistry.setLabels([asset.id], { note: next });
  };
  return (
    <label className="note-field">
      メモ
      <textarea
        value={text}
        rows={2}
        maxLength={NOTE_MAX}
        placeholder="この素材について（どこが良い、どこで切る、など）"
        aria-label="素材のメモ"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          // ここで打つキー（Delete・Ctrl+A など）を、素材の一覧やタイムラインのショートカットへ渡さない。
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
        }}
      />
    </label>
  );
}

/** 色での絞り込み。色の付いた素材が 1 つも無いときは出さない（使う前から場所を取らない）。 */
export function LabelFilterBar({
  assets,
  value,
  onChange,
}: {
  assets: MediaAsset[];
  value: LabelFilter;
  onChange: (next: LabelFilter) => void;
}) {
  const counts = labelCounts(assets);
  const used = LABEL_COLORS.filter((c) => counts[c] > 0 || value === c);
  if (used.length === 0 && value === null) return null;
  const chip = (key: LabelFilter, label: string, count: number, color?: LabelColor) => (
    <button
      key={key ?? 'all'}
      type="button"
      className={value === key ? 'label-chip on' : 'label-chip'}
      aria-pressed={value === key}
      onClick={() => onChange(value === key ? null : key)}
      title={color ? `${LABEL_NAMES[color]}の素材だけ表示` : label}
    >
      {color && <span className="label-dot" style={{ background: LABEL_HEX[color] }} />}
      {label}
      <em>{count}</em>
    </button>
  );
  return (
    <div className="label-filter" role="group" aria-label="色タグで絞り込む">
      {used.map((c) => chip(c, LABEL_NAMES[c], counts[c], c))}
      {chip('none', '色なし', counts.none)}
    </div>
  );
}
