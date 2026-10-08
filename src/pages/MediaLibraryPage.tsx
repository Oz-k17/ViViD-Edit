import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { useMediaAssets, importFiles } from '../components/editor/MediaPanel';
import { formatBytes, formatTime, mediaRegistry, UNSORTED } from '../engine/media';
import { matchesQuery } from '../model/bins';
import { pick, prune, sortAssets, type PickState } from '../model/assetView';
import { BinTree, useBinOptions, type BinSelection } from '../components/editor/BinTree';
import { BulkBar, MakeProxiesButton, ProxyStatus, SortControl } from '../components/editor/AssetControls';
import { startAssetDrag } from '../components/editor/assetDrag';
import { useAssetView } from '../store/assetView';
import { Panel } from '../components/ui';
import { Icon } from '../components/Icon';

export default function MediaLibraryPage() {
  const assets = useMediaAssets();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<BinSelection>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const { sortKey, direction } = useAssetView();
  const binOptions = useBinOptions();
  const [picked, setPicked] = useState<PickState>({ selected: [], anchor: null });

  const searching = query.trim().length > 0;
  const ordered = useMemo(() => {
    const filtered = searching
      ? assets.filter((a) => matchesQuery(a.name, a.folder || UNSORTED, query))
      : folder === null
        ? assets
        : assets.filter((a) => (a.folder || UNSORTED) === folder);
    return sortAssets(filtered, sortKey, direction);
  }, [assets, folder, query, searching, sortKey, direction]);
  const orderedIds = useMemo(() => ordered.map((a) => a.id), [ordered]);
  const filtered = ordered;

  useEffect(() => {
    setPicked((prev) => prune(prev, orderedIds));
  }, [orderedIds]);

  const allPicked = orderedIds.length > 0 && picked.selected.length === orderedIds.length;

  const upload = async (files: FileList) => {
    setBusy(true);
    await importFiles(files, folder ?? UNSORTED);
    setBusy(false);
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <SiteNav />
        <div className="topbar-actions">
          <LayoutToggle />
          <button type="button" className="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? '読込中…' : <><Icon name="plus" />素材を追加</>}
          </button>
        </div>
      </header>

      <input
        ref={inputRef}
        type="file"
        accept="video/*,image/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files);
          e.target.value = '';
        }}
      />

      <main className="page-body">
        <Panel title="ビン">
          <BinTree selected={folder} onSelect={setFolder} />
          <p className="muted">
            素材はブラウザ内（IndexedDB）に保存されます。ページを移動したりリロードしても残り、エディタの素材パネルにも同じものが並びます。
            素材やビンはドラッグして別のビンへ移せます。
          </p>
        </Panel>

        <Panel title={`素材（${filtered.length}）`}>
          <SortControl />
          <label className="media-select-all">
            <input
              type="checkbox"
              checked={allPicked}
              disabled={orderedIds.length === 0}
              onChange={() => setPicked(allPicked ? { selected: [], anchor: null } : { selected: orderedIds, anchor: orderedIds[0] ?? null })}
            />
            表示中をすべて選ぶ
          </label>
          <input
            type="search"
            className="asset-search"
            value={query}
            placeholder="素材を検索（名前・ビン）"
            aria-label="素材を検索"
            onChange={(e) => setQuery(e.target.value)}
          />
          {filtered.length === 0 ? (
            <p className="empty-hint">
              {searching ? `「${query.trim()}」に合う素材はありません。` : assets.length > 0 ? 'このビンには素材がありません。' : 'まだ素材がありません。「素材を追加」から読み込んでください。'}
            </p>
          ) : (
            <ul className="media-table">
              {filtered.map((asset) => (
                <li
                  key={asset.id}
                  className={picked.selected.includes(asset.id) ? 'selected' : undefined}
                  draggable
                  onDragStart={(e) => {
                    if (!picked.selected.includes(asset.id)) setPicked({ selected: [asset.id], anchor: asset.id });
                    startAssetDrag(e, asset.id, picked.selected);
                  }}
                >
                  <input
                    type="checkbox"
                    className="media-check"
                    aria-label={`${asset.name} を選ぶ`}
                    checked={picked.selected.includes(asset.id)}
                    onChange={() => undefined}
                    onClick={(e) => setPicked((prev) => pick(prev, orderedIds, asset.id, { toggle: !e.shiftKey, range: e.shiftKey }))}
                  />
                  <div className="asset-thumb">
                    {asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : <span className="asset-icon"><Icon name={asset.kind === 'audio' ? 'music-note' : asset.kind === 'image' ? 'photo' : 'film'} size={20} /></span>}
                  </div>
                  <div className="media-meta">
                    <input
                      type="text"
                      value={asset.name}
                      onChange={(e) => mediaRegistry.update(asset.id, { name: e.target.value })}
                    />
                    <span className="muted">
                      {asset.kind === 'image' ? '画像' : formatTime(asset.duration)} ・ {formatBytes(asset.size)}
                      {asset.width > 0 && ` ・ ${asset.width}×${asset.height}`}
                    </span>
                    <ProxyStatus asset={asset} always withRemove />
                  </div>
                  <select
                    value={asset.folder || UNSORTED}
                    title="移動先のビン"
                    onChange={(e) => mediaRegistry.update(asset.id, { folder: e.target.value })}
                  >
                    {binOptions.map((option) => (
                      <option key={option.path} value={option.path}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="danger" onClick={() => mediaRegistry.remove(asset.id)}>
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <BulkBar
            ids={picked.selected}
            total={orderedIds.length}
            onClear={() => setPicked({ selected: [], anchor: null })}
            onSelectAll={() => setPicked({ selected: orderedIds, anchor: orderedIds[0] ?? null })}
          >
            <MakeProxiesButton ids={picked.selected} />
          </BulkBar>
        </Panel>
      </main>
    </div>
  );
}
