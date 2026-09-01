import { useMemo, useRef, useState } from 'react';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { useMediaAssets, importFiles } from '../components/editor/MediaPanel';
import { formatBytes, formatTime, mediaRegistry, UNSORTED } from '../engine/media';
import { Field, Panel } from '../components/ui';

export default function MediaLibraryPage() {
  const assets = useMediaAssets();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState('すべて');
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [extraFolders, setExtraFolders] = useState<string[]>([]);

  const folders = useMemo(() => {
    const names = new Set([...mediaRegistry.folders(), ...extraFolders]);
    return ['すべて', ...names];
  }, [assets, extraFolders]);

  const filtered = folder === 'すべて' ? assets : assets.filter((a) => (a.folder || UNSORTED) === folder);

  const upload = async (files: FileList) => {
    setBusy(true);
    await importFiles(files, folder === 'すべて' ? UNSORTED : folder);
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
            {busy ? '読込中…' : '＋ 素材を追加'}
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
        <Panel title="フォルダ">
          <div className="chip-row wrap">
            {folders.map((name) => (
              <button key={name} type="button" className={folder === name ? 'chip active' : 'chip'} onClick={() => setFolder(name)}>
                {name}
              </button>
            ))}
          </div>
          <Field label="フォルダを追加">
            <div className="row">
              <input type="text" value={newFolder} placeholder="例: BGM" onChange={(e) => setNewFolder(e.target.value)} />
              <button
                type="button"
                onClick={() => {
                  const name = newFolder.trim();
                  if (!name) return;
                  setExtraFolders((prev) => [...new Set([...prev, name])]);
                  setFolder(name);
                  setNewFolder('');
                }}
              >
                追加
              </button>
            </div>
          </Field>
          <p className="muted">
            素材はブラウザ内（IndexedDB）に保存されます。ページを移動したりリロードしても残り、エディタの素材パネルにも同じものが並びます。
          </p>
        </Panel>

        <Panel title={`素材（${filtered.length}）`}>
          {filtered.length === 0 ? (
            <p className="empty-hint">まだ素材がありません。「＋ 素材を追加」から読み込んでください。</p>
          ) : (
            <ul className="media-table">
              {filtered.map((asset) => (
                <li key={asset.id}>
                  <div className="asset-thumb">
                    {asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : <span className="asset-icon">{asset.kind === 'audio' ? '♪' : '▦'}</span>}
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
                  <select value={asset.folder || UNSORTED} onChange={(e) => mediaRegistry.update(asset.id, { folder: e.target.value })}>
                    {folders
                      .filter((f) => f !== 'すべて')
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
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
