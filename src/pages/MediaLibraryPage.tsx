import { useMemo, useRef, useState } from 'react';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { useMediaAssets, importFiles } from '../components/editor/MediaPanel';
import { formatBytes, formatTime, mediaRegistry, UNSORTED } from '../engine/media';
import { allBinPaths, baseName, matchesQuery, splitPath } from '../model/bins';
import { BinTree, type BinSelection } from '../components/editor/BinTree';
import { MEDIA_DND_TYPE } from '../components/editor/MultiTimeline';
import { useBinState } from '../store/bins';
import { Panel } from '../components/ui';
import { Icon } from '../components/Icon';

export default function MediaLibraryPage() {
  const assets = useMediaAssets();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<BinSelection>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const { extra } = useBinState();

  /** 移動先の選択肢。階層が分かるよう、深さぶんだけ字下げする。 */
  const binOptions = useMemo(
    () =>
      allBinPaths(
        assets.map((a) => a.folder || UNSORTED),
        extra,
      )
        .sort((a, b) => a.localeCompare(b, 'ja'))
        .map((path) => ({ path, label: `${'　'.repeat(splitPath(path).length - 1)}${baseName(path)}` })),
    [assets, extra],
  );

  const searching = query.trim().length > 0;
  const filtered = searching
    ? assets.filter((a) => matchesQuery(a.name, a.folder || UNSORTED, query))
    : folder === null
      ? assets
      : assets.filter((a) => (a.folder || UNSORTED) === folder);

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
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(MEDIA_DND_TYPE, asset.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
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
        </Panel>
      </main>
    </div>
  );
}
