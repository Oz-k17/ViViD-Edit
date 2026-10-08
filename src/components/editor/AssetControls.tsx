import type { ReactNode } from 'react';
import { formatBytes, mediaRegistry, type MediaAsset } from '../../engine/media';
import { cancelProxy, canMakeProxy, removeProxy, requestProxies, shouldSuggestProxy, useProxyJobs } from '../../engine/proxy';
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

/**
 * 軽量版（プロキシ）の状態と操作。
 * - 作成中: 進み具合と中止
 * - あり: 印（`withRemove` なら消すボタンも）
 * - なし: 長い・大きい動画なら作成ボタン（`always` なら動画すべてに出す）
 */
export function ProxyStatus({ asset, always = false, withRemove = false }: { asset: MediaAsset; always?: boolean; withRemove?: boolean }) {
  const jobs = useProxyJobs();
  const job = jobs[asset.id];
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  if (asset.kind !== 'video') return null;
  if (job?.state === 'running' || job?.state === 'queued') {
    return (
      <span className="proxy-status busy" onClick={stop} onDoubleClick={stop}>
        {job.state === 'running' ? `軽量版 ${Math.round(job.progress * 100)}%` : '軽量版 待機中'}
        <button type="button" className="ghost proxy-cancel" title="軽量版の作成をやめる" onClick={() => void cancelProxy(asset.id)}>
          ×
        </button>
      </span>
    );
  }
  if (job?.state === 'error') {
    return (
      <span className="proxy-status error" title={job.message} onClick={stop} onDoubleClick={stop}>
        軽量版 失敗
        <button type="button" className="ghost proxy-cancel" title="もう一度作る" onClick={() => requestProxies([asset.id])}>
          ↻
        </button>
      </span>
    );
  }
  if (asset.proxy) {
    return (
      <span
        className="proxy-status ready"
        title={`軽量版あり（${asset.proxy.width}×${asset.proxy.height}・${formatBytes(asset.proxy.size)}）。プレビューと再生はこちらを使います`}
        onClick={stop}
        onDoubleClick={stop}
      >
        軽量版
        {withRemove && (
          <button type="button" className="ghost proxy-cancel" title="軽量版を消す（元の素材はそのまま）" onClick={() => void removeProxy(asset.id)}>
            ×
          </button>
        )}
      </span>
    );
  }
  if (always ? canMakeProxy(asset.id) : shouldSuggestProxy(asset.id)) {
    return (
      <button
        type="button"
        className="ghost proxy-make"
        title="プレビュー用の軽い複製を作る（書き出しは元の画質のまま）"
        onClick={(e) => {
          e.stopPropagation();
          requestProxies([asset.id]);
        }}
        onDoubleClick={stop}
      >
        軽量版を作る
      </button>
    );
  }
  return null;
}

/** 選んだ素材のうち、軽量版を作れる動画に作る。作れるものが無ければ出さない。 */
export function MakeProxiesButton({ ids }: { ids: string[] }) {
  useProxyJobs();
  const targets = ids.filter((id) => canMakeProxy(id));
  if (targets.length === 0) return null;
  return (
    <button type="button" className="ghost" title="選んだ動画に、プレビュー用の軽い複製を作る" onClick={() => requestProxies(targets)}>
      軽量版を作る（{targets.length}）
    </button>
  );
}
