import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatTime, mediaRegistry, SFX_FOLDER, UNSORTED, type MediaAsset } from '../../engine/media';
import { renderPreset, SFX_PRESETS } from '../../engine/sfx';
import { player } from '../../engine/player';
import { clipFromAsset } from '../../model/factory';
import { adoptSourceFps, placeClip, tracksOf } from '../../model/ops';
import { useEditor } from '../../store/editor';
import { MEDIA_DND_TYPE } from './MultiTimeline';
import { matchesQuery } from '../../model/bins';
import { BinTree, type BinSelection } from './BinTree';
import { NasBrowser } from './NasBrowser';
import { EmptyHint, Panel } from '../ui';
import { Icon } from '../Icon';

const PAGE_SIZE = 6;

export function useMediaAssets(): MediaAsset[] {
  // 保存済みの素材を読み戻す（何度呼んでも 1 回だけ）。ライブラリページを直接開いたときも必要。
  useEffect(() => {
    void mediaRegistry.restore();
  }, []);
  return useSyncExternalStore(mediaRegistry.subscribe, mediaRegistry.getSnapshot, mediaRegistry.getSnapshot);
}

export async function importFiles(files: FileList | File[], folder = UNSORTED): Promise<string[]> {
  const errors: string[] = [];
  for (const file of Array.from(files)) {
    try {
      await mediaRegistry.add(file, folder);
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : '読み込み失敗'}`);
    }
  }
  return errors;
}

/** 効果音プリセットを 1 度だけライブラリへ入れる。 */
export async function seedSoundEffects(): Promise<void> {
  await mediaRegistry.restore();
  if (mediaRegistry.all().some((a) => a.folder === SFX_FOLDER)) return;
  for (const preset of SFX_PRESETS) {
    try {
      await mediaRegistry.add(await renderPreset(preset), SFX_FOLDER);
    } catch {
      /* 合成できない環境では黙って諦める */
    }
  }
}

export function MediaPanel() {
  const assets = useMediaAssets();
  const { sequence, apply } = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<BinSelection>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // 検索しているときはビンを問わず全体から探す（どこに入れたか忘れても見つかるように）。
  const searching = query.trim().length > 0;
  const filtered = useMemo(
    () =>
      searching
        ? assets.filter((a) => matchesQuery(a.name, a.folder || UNSORTED, query))
        : folder === null
          ? assets
          : assets.filter((a) => (a.folder || UNSORTED) === folder),
    [assets, folder, query, searching],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const visible = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const handleFiles = async (files: FileList | File[]) => {
    setBusy(true);
    setError(null);
    const errors = await importFiles(files, folder ?? UNSORTED);
    setBusy(false);
    if (errors.length) setError(errors.join(' / '));
    // 新しい素材は一覧の先頭（1 ページ目）に入るので、他のページを見ていても追加したものが見える位置に戻す。
    setPage(0);
  };

  /** ダブルクリック / ボタンで、再生ヘッド位置の空いているトラックへ置く。 */
  const addToTimeline = (asset: MediaAsset) => {
    const kind = asset.kind === 'audio' ? 'audio' : 'video';
    const candidates = tracksOf(sequence, kind);
    if (candidates.length === 0) return;
    const start = player.time;
    const free =
      candidates.find(
        (track) => !sequence.clips.some((c) => c.trackId === track.id && c.start < start + 0.05 && c.start + c.duration > start + 0.05),
      ) ?? candidates[0];
    apply((seq) => placeClip(adoptSourceFps(seq, asset.fps), clipFromAsset(asset, free.id, start)));
  };

  return (
    <Panel
      title="素材"
      action={
        <div className="panel-actions">
          <button
            type="button"
            className="ghost"
            title="NAS の共有／個人フォルダから、コピーせずに参照する"
            onClick={() => setBrowsing(true)}
            disabled={busy}
          >
            NAS
          </button>
          <button type="button" className="ghost" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? '読込中…' : <><Icon name="plus" />追加</>}
          </button>
        </div>
      }
    >
      {browsing && <NasBrowser onClose={() => setBrowsing(false)} />}
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

      <BinTree
        selected={folder}
        onSelect={(path) => {
          setFolder(path);
          setPage(0);
        }}
        compact
      />

      <input
        type="search"
        className="asset-search"
        value={query}
        placeholder="素材を検索（名前・ビン）"
        aria-label="素材を検索"
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(0);
        }}
      />

      {error && <p className="error-note">{error}</p>}

      {filtered.length === 0 ? (
        searching ? (
          <EmptyHint>「{query.trim()}」に合う素材はありません。</EmptyHint>
        ) : assets.length > 0 ? (
          <EmptyHint>このビンには素材がありません。中のビンを選ぶか、素材をドラッグして入れてください。</EmptyHint>
        ) : (
          <EmptyHint>
            動画・画像・音声をドラッグ＆ドロップ、または「追加」で読み込みます。
            <br />
            ファイルはブラウザの中だけで処理され、どこにもアップロードされません。
          </EmptyHint>
        )
      ) : (
        <ul className="asset-grid">
          {visible.map((asset) => (
            <li
              key={asset.id}
              className="asset-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_DND_TYPE, asset.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onDoubleClick={() => addToTimeline(asset)}
              title={asset.warning ? `${asset.name}\n${asset.warning}` : `${asset.name}\nタイムラインへドラッグ、またはダブルクリックで配置`}
            >
              <div className="asset-thumb">
                {asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : <span className="asset-icon"><Icon name={asset.kind === 'audio' ? 'music-note' : asset.kind === 'image' ? 'photo' : 'film'} size={20} /></span>}
              </div>
              <strong>{asset.name}</strong>
              <span>
                {asset.warning ? <><Icon name="warning" size={13} />読み取れず</> : asset.kind === 'image' ? '画像' : formatTime(asset.duration)}
                {asset.fps ? <em className="asset-fps">{asset.fps}fps</em> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <div className="pager">
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
            <Icon name="chevron-left" size={15} label="前のページ" />
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button type="button" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>
            <Icon name="chevron-right" size={15} label="次のページ" />
          </button>
        </div>
      )}
    </Panel>
  );
}
