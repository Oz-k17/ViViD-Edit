import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatTime, mediaRegistry, SFX_FOLDER, UNSORTED, type MediaAsset } from '../../engine/media';
import { renderPreset, SFX_PRESETS } from '../../engine/sfx';
import { player } from '../../engine/player';
import { clipFromAsset } from '../../model/factory';
import { adoptSourceFps, tracksOf } from '../../model/ops';
import { useEditor } from '../../store/editor';
import { matchesQuery } from '../../model/bins';
import { pick, prune, sortAssets, type PickState } from '../../model/assetView';
import { clipEnd } from '../../model/types';
import { placeClips } from '../../model/editOps';
import { useAssetView } from '../../store/assetView';
import { BulkBar, MakeProxiesButton, ProxyStatus, SortControl, StripStatus, removeAssets, confirmRemoveAssets } from './AssetControls';
import { startAssetDrag } from './assetDrag';
import { BinTree, type BinSelection } from './BinTree';
import { NasBrowser } from './NasBrowser';
import { EmptyHint, Panel } from '../ui';
import { Icon } from '../Icon';

/** 一度に並べる素材の数。多いときは「さらに表示」で足す（サムネイルを一度に出しすぎない）。 */
const CHUNK = 48;

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
  const { apply, insertMode } = useEditor();
  const { sortKey, direction } = useAssetView();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<BinSelection>(null);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(CHUNK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [picked, setPicked] = useState<PickState>({ selected: [], anchor: null });

  // 検索しているときはビンを問わず全体から探す（どこに入れたか忘れても見つかるように）。
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
  const visible = ordered.slice(0, shown);

  // 並びや絞り込みが変わったら、見えなくなった素材を選択から外し、表示件数も戻す。
  useEffect(() => {
    setPicked((prev) => prune(prev, orderedIds));
  }, [orderedIds]);
  useEffect(() => {
    setShown(CHUNK);
  }, [folder, query, sortKey, direction]);

  const handleFiles = async (files: FileList | File[]) => {
    setBusy(true);
    setError(null);
    const errors = await importFiles(files, folder ?? UNSORTED);
    setBusy(false);
    if (errors.length) setError(errors.join(' / '));
  };

  /**
   * 再生ヘッド位置から、素材の種類ごとに空いているトラックへ続けて置く（挿入配置がオンなら挿入）。
   * 複数のときは、選んだ順ではなく**いま見えている並び順**で置く。
   */
  const addToTimeline = (list: MediaAsset[]) => {
    if (list.length === 0) return;
    apply((seq) => {
      let next = seq;
      for (const kind of ['video', 'audio'] as const) {
        const group = list.filter((a) => (a.kind === 'audio' ? 'audio' : 'video') === kind);
        const candidates = tracksOf(next, kind);
        if (group.length === 0 || candidates.length === 0) continue;
        let at = player.time;
        // 挿入は「流れを押し広げる」操作なので、空きを探さず基本のトラック（V1 / A1）へ入れる。
        const free = insertMode
          ? candidates[0]
          : (candidates.find(
              (track) => !next.clips.some((c) => c.trackId === track.id && c.start < at + 0.05 && c.start + c.duration > at + 0.05),
            ) ?? candidates[0]);
        const clips = group.map((asset) => {
          const clip = clipFromAsset(asset, free.id, at);
          at = clipEnd(clip);
          return clip;
        });
        next = placeClips(adoptSourceFps(next, group[0].fps), clips, insertMode);
      }
      return next;
    });
  };

  const selectedAssets = ordered.filter((a) => picked.selected.includes(a.id));

  const onCardClick = (event: React.MouseEvent, asset: MediaAsset) => {
    setPicked((prev) => pick(prev, orderedIds, asset.id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyA') {
      setPicked({ selected: orderedIds, anchor: orderedIds[0] ?? null });
    } else if (event.key === 'Escape') {
      setPicked({ selected: [], anchor: null });
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && picked.selected.length > 0) {
      if (confirmRemoveAssets(picked.selected)) {
        removeAssets(picked.selected);
        setPicked({ selected: [], anchor: null });
      }
    } else if (event.key === 'Enter' && picked.selected.length > 0) {
      addToTimeline(selectedAssets);
    } else {
      return;
    }
    // ここで扱ったキーは、タイムライン側のショートカット（Ctrl+A=全クリップ選択、Delete=クリップ削除）へ渡さない。
    event.preventDefault();
    event.stopPropagation();
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

      <BinTree selected={folder} onSelect={setFolder} compact />

      <input
        type="search"
        className="asset-search"
        value={query}
        placeholder="素材を検索（名前・ビン）"
        aria-label="素材を検索"
        onChange={(e) => setQuery(e.target.value)}
      />

      <SortControl />

      <BulkBar
        ids={picked.selected}
        total={orderedIds.length}
        onClear={() => setPicked({ selected: [], anchor: null })}
        onSelectAll={() => setPicked({ selected: orderedIds, anchor: orderedIds[0] ?? null })}
      >
        <button type="button" className="ghost" onClick={() => addToTimeline(selectedAssets)} title={insertMode ? '再生ヘッドへ挿入（Enter）' : '再生ヘッドへ置く（Enter）'}>
          タイムラインへ
        </button>
        <MakeProxiesButton ids={picked.selected} />
      </BulkBar>

      {error && <p className="error-note">{error}</p>}

      {ordered.length === 0 ? (
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
        <ul className="asset-grid" role="listbox" aria-multiselectable="true" aria-label="素材" tabIndex={0} onKeyDown={onKeyDown}>
          {visible.map((asset) => {
            const isPicked = picked.selected.includes(asset.id);
            return (
              <li
                key={asset.id}
                role="option"
                aria-selected={isPicked}
                className={isPicked ? 'asset-card selected' : 'asset-card'}
                draggable
                onClick={(e) => onCardClick(e, asset)}
                onDragStart={(e) => {
                  // 選択に入っていない素材をつかんだら、その 1 つだけを選び直す。
                  if (!isPicked) setPicked({ selected: [asset.id], anchor: asset.id });
                  startAssetDrag(e, asset.id, picked.selected);
                }}
                onDoubleClick={() => addToTimeline(isPicked && picked.selected.length > 1 ? selectedAssets : [asset])}
                title={asset.warning ? `${asset.name}\n${asset.warning}` : `${asset.name}\nクリックで選択（Ctrl/⌘で追加、Shiftで範囲）・ダブルクリックでタイムラインへ・ドラッグで配置／ビンへ移動`}
              >
                <div className="asset-thumb">
                  {asset.thumbnail ? <img src={asset.thumbnail} alt="" draggable={false} /> : <span className="asset-icon"><Icon name={asset.kind === 'audio' ? 'music-note' : asset.kind === 'image' ? 'photo' : 'film'} size={26} /></span>}
                </div>
                <strong>{asset.name}</strong>
                <span>
                  {asset.warning ? <><Icon name="warning" size={13} />読み取れず</> : asset.kind === 'image' ? '画像' : formatTime(asset.duration)}
                  {asset.fps ? <em className="asset-fps">{asset.fps}fps</em> : null}
                </span>
                <ProxyStatus asset={asset} />
                <StripStatus asset={asset} />
              </li>
            );
          })}
        </ul>
      )}

      {ordered.length > visible.length && (
        <div className="pager">
          <button type="button" onClick={() => setShown((n) => n + CHUNK)}>
            さらに表示（残り {ordered.length - visible.length} 件）
          </button>
        </div>
      )}
    </Panel>
  );
}
