import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { formatBytes, formatTime, mediaRegistry, type MediaAsset } from '../engine/media';
import { useEditor } from '../store/editor';
import { EmptyHint, Panel } from './ui';

export function useMediaAssets(): MediaAsset[] {
  return useSyncExternalStore(mediaRegistry.subscribe, mediaRegistry.getSnapshot, mediaRegistry.getSnapshot);
}

export async function importFiles(files: FileList | File[]): Promise<string[]> {
  const errors: string[] = [];
  for (const file of Array.from(files)) {
    try {
      await mediaRegistry.add(file);
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : '読み込み失敗'}`);
    }
  }
  return errors;
}

export function MediaLibrary() {
  const assets = useMediaAssets();
  const { project, dispatch, select } = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setBusy(true);
    setError(null);
    const errors = await importFiles(files);
    setBusy(false);
    if (errors.length) setError(errors.join(' / '));
  }, []);

  const addAsClip = (asset: MediaAsset) => {
    dispatch({ type: 'clip/add', asset });
  };

  const useAsMusic = (asset: MediaAsset) => {
    dispatch({
      type: 'music/set',
      music: {
        mediaId: asset.id,
        start: 0,
        in: 0,
        out: asset.duration,
        volume: 0.5,
        fadeIn: 0.5,
        fadeOut: 1,
        loop: true,
      },
    });
    select({ type: 'music' });
  };

  const removeAsset = (asset: MediaAsset) => {
    project.clips.filter((c) => c.mediaId === asset.id).forEach((c) => dispatch({ type: 'clip/remove', id: c.id }));
    if (project.music?.mediaId === asset.id) dispatch({ type: 'music/set', music: null });
    mediaRegistry.remove(asset.id);
  };

  return (
    <Panel
      title="素材"
      action={
        <button type="button" className="ghost" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? '読込中…' : '＋ 追加'}
        </button>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,image/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {error && <p className="error-note">{error}</p>}

      {assets.length === 0 ? (
        <EmptyHint>
          動画・画像・音声をここにドラッグ＆ドロップ、または「＋ 追加」で読み込みます。
          <br />
          ファイルはブラウザの中だけで処理され、どこにもアップロードされません。
        </EmptyHint>
      ) : (
        <ul className="asset-list">
          {assets.map((asset) => (
            <li key={asset.id} className="asset">
              <div className="asset-thumb">
                {asset.thumbnail ? (
                  <img src={asset.thumbnail} alt="" />
                ) : (
                  <span className="asset-icon">{asset.kind === 'audio' ? '♪' : '▦'}</span>
                )}
              </div>
              <div className="asset-meta">
                <strong title={asset.name}>{asset.name}</strong>
                <span>
                  {asset.kind === 'image' ? '画像' : formatTime(asset.duration)} ・ {formatBytes(asset.size)}
                  {asset.width > 0 && ` ・ ${asset.width}×${asset.height}`}
                </span>
                <div className="asset-actions">
                  {asset.kind === 'audio' ? (
                    <button type="button" onClick={() => useAsMusic(asset)}>
                      BGM に設定
                    </button>
                  ) : (
                    <button type="button" onClick={() => addAsClip(asset)}>
                      タイムラインへ
                    </button>
                  )}
                  <button type="button" className="danger" onClick={() => removeAsset(asset)}>
                    削除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
