import type { ReactNode } from 'react';
import { mediaRegistry } from '../../engine/media';
import { ASSET_SORT_LABELS, type AssetSortKey } from '../../model/assetView';
import { chooseSort, toggleDirection, useAssetView } from '../../store/assetView';
import { moveAssetsToBin } from '../../store/bins';
import { useBinOptions } from './BinTree';

const KEYS = Object.keys(ASSET_SORT_LABELS) as AssetSortKey[];

/** 並び替え（キーの選択と、昇順／降順の切り替え）。 */
export function SortControl() {
  const { sortKey, direction } = useAssetView();
  return (
    <div className="asset-sort">
      <label className="asset-sort-label">
        並び順
        <select value={sortKey} aria-label="並び順" onChange={(e) => chooseSort(e.target.value as AssetSortKey)}>
          {KEYS.map((key) => (
            <option key={key} value={key}>
              {ASSET_SORT_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="ghost"
        onClick={toggleDirection}
        title={direction === 'asc' ? '昇順（クリックで降順）' : '降順（クリックで昇順）'}
        aria-label={direction === 'asc' ? '昇順' : '降順'}
      >
        {direction === 'asc' ? '↑ 昇順' : '↓ 降順'}
      </button>
    </div>
  );
}

/** 素材を削除する前に確認する。複数のときは件数を出す。 */
export function confirmRemoveAssets(ids: string[]): boolean {
  if (ids.length === 0) return false;
  const what = ids.length === 1 ? `「${mediaRegistry.get(ids[0])?.name ?? '素材'}」` : `素材 ${ids.length} 件`;
  return window.confirm(
    `${what}を削除しますか？\nタイムラインで使っているクリップは残りますが、映像・音が出なくなります。`,
  );
}

export function removeAssets(ids: string[]) {
  ids.forEach((id) => mediaRegistry.remove(id));
}

/** 選択した素材への一括操作（ビンへ移す・削除・選択解除）。`children` に画面固有のボタンを足せる。 */
export function BulkBar({
  ids,
  total,
  onClear,
  onSelectAll,
  children,
}: {
  ids: string[];
  /** 見えている素材の総数（「すべて選ぶ」の出し分けに使う）。 */
  total: number;
  onClear: () => void;
  onSelectAll: () => void;
  children?: ReactNode;
}) {
  const options = useBinOptions();
  if (ids.length === 0) return null;
  return (
    <div className="bulk-bar" role="toolbar" aria-label="選択した素材の操作">
      <strong>{ids.length} 件選択中</strong>
      {ids.length < total && (
        <button type="button" className="ghost" onClick={onSelectAll}>
          すべて選ぶ
        </button>
      )}
      <label className="bulk-move">
        移動先
        <select
          value=""
          aria-label="選択した素材の移動先"
          onChange={(e) => {
            if (e.target.value === '') return;
            moveAssetsToBin(ids, e.target.value);
          }}
        >
          <option value="">ビンを選ぶ…</option>
          {options.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {children}
      <button
        type="button"
        className="danger"
        onClick={() => {
          if (confirmRemoveAssets(ids)) {
            removeAssets(ids);
            onClear();
          }
        }}
      >
        削除
      </button>
      <button type="button" className="ghost" onClick={onClear}>
        解除
      </button>
    </div>
  );
}
