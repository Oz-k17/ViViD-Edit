import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { mediaRegistry, UNSORTED } from '../../engine/media';
import { buildTree, parentOf, rebase, visibleNodes, type BinNode } from '../../model/bins';
import {
  createBin,
  deleteBin,
  isProtected,
  moveAssetsToBin,
  moveBin,
  PINNED_BINS,
  renameBin,
  revealBin,
  toggleExpanded,
  useBinState,
} from '../../store/bins';
import { Icon } from '../Icon';
import { MEDIA_DND_TYPE } from './MultiTimeline';

/** ビンをドラッグして別のビンの下へ移すときの印。 */
export const BIN_DND_TYPE = 'application/x-vivid-bin';

/** 選択が「すべて」のときの値。 */
export const ALL_BINS = null;
export type BinSelection = string | null;

interface DragHandlers {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
}

interface Editing {
  mode: 'new' | 'rename';
  /** new: 新しいビンを作る親。rename: 名前を変えるビン。 */
  path: string;
}

export function BinTree({
  selected,
  onSelect,
  compact = false,
}: {
  selected: BinSelection;
  onSelect: (path: BinSelection) => void;
  compact?: boolean;
}) {
  const { extra, expanded } = useBinState();
  const assets = useSyncAssets();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  const treeRef = useRef<HTMLDivElement>(null);

  const folders = useMemo(() => assets.map((a) => a.folder || UNSORTED), [assets]);
  const tree = useMemo(() => buildTree(folders, extra, PINNED_BINS as string[]), [folders, extra]);
  const open = useMemo(() => new Set(expanded), [expanded]);
  const rows = useMemo(() => visibleNodes(tree, open), [tree, open]);

  // 選んだビンが畳まれた枝の中にあっても見えるようにする。
  useEffect(() => {
    if (selected) revealBin(selected);
  }, [selected]);

  const fail = (reason: string) => {
    setMessage(reason);
    window.setTimeout(() => setMessage((m) => (m === reason ? null : m)), 4000);
  };

  const commit = (value: string): boolean => {
    if (!editing) return true;
    const result =
      editing.mode === 'new' ? createBin(editing.path, value) : renameBin(editing.path, value);
    if (!result.ok) {
      fail(result.reason);
      return false;
    }
    setEditing(null);
    setMessage(null);
    if (editing.mode === 'new') {
      onSelect(result.path);
    } else {
      followSelection(editing.path, result.path);
    }
    return true;
  };

  /** ビンの名前変更・移動で、選択中のビンがその中にあったなら、新しいパスへ付け替える。 */
  const followSelection = (from: string, to: string) => {
    if (selected && from !== to) onSelect(rebase(selected, from, to));
  };

  const remove = (path: string) => {
    const node = rows.find((r) => r.path === path);
    const inside = node?.total ?? 0;
    const detail = inside > 0 ? `\n中の素材 ${inside} 件は消さず、ひとつ上のビンへ移します。` : '';
    if (!window.confirm(`ビン「${path}」を削除しますか？${detail}`)) return;
    const result = deleteBin(path);
    if (!result.ok) return fail(result.reason);
    if (selected && (selected === path || selected.startsWith(path + '/'))) onSelect(result.path || ALL_BINS);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing) return;
    const index = rows.findIndex((r) => r.path === selected);
    const node = index >= 0 ? rows[index] : null;
    switch (event.key) {
      case 'ArrowDown':
        onSelect(rows[Math.min(rows.length - 1, index + 1)]?.path ?? ALL_BINS);
        break;
      case 'ArrowUp':
        onSelect(index <= 0 ? ALL_BINS : rows[index - 1].path);
        break;
      case 'ArrowRight':
        if (node && node.children.length > 0) {
          if (!open.has(node.path)) toggleExpanded(node.path);
          else onSelect(node.children[0].path);
        }
        break;
      case 'ArrowLeft':
        if (node) {
          if (open.has(node.path) && node.children.length > 0) toggleExpanded(node.path);
          else onSelect(parentOf(node.path) || ALL_BINS);
        }
        break;
      case 'F2':
        if (node && !isProtected(node.path)) setEditing({ mode: 'rename', path: node.path });
        break;
      case 'Delete':
      case 'Backspace':
        if (node && !isProtected(node.path)) remove(node.path);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const acceptDrop = (event: React.DragEvent, target: BinSelection) => {
    const assetId = event.dataTransfer.getData(MEDIA_DND_TYPE);
    const binPath = event.dataTransfer.getData(BIN_DND_TYPE);
    setDropTarget(undefined);
    if (!assetId && !binPath) return;
    event.preventDefault();
    event.stopPropagation();
    if (assetId) {
      moveAssetsToBin([assetId], target ?? UNSORTED);
      return;
    }
    const result = moveBin(binPath, target ?? '');
    if (!result.ok) fail(result.reason);
    else followSelection(binPath, result.path);
  };

  const dragProps = (target: BinSelection) => ({
    onDragOver: (event: DragEvent) => {
      const types = event.dataTransfer.types;
      if (!types.includes(MEDIA_DND_TYPE) && !types.includes(BIN_DND_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropTarget !== target) setDropTarget(target);
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (event: DragEvent) => acceptDrop(event, target),
  });

  const selectedNode = rows.find((r) => r.path === selected) ?? null;
  const canEditSelected = selected !== null && !isProtected(selected);

  return (
    <div className={compact ? 'bin-tree compact' : 'bin-tree'}>
      <div className="bin-toolbar">
        <button
          type="button"
          className="ghost"
          title={selected ? `「${selected}」の中にビンを作る` : '最上位にビンを作る'}
          onClick={() => setEditing({ mode: 'new', path: selected ?? '' })}
        >
          <Icon name="plus" size={14} />新しいビン
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!canEditSelected}
          title="選んだビンの名前を変える（F2）"
          onClick={() => selected && setEditing({ mode: 'rename', path: selected })}
        >
          名前を変更
        </button>
        <button
          type="button"
          className="ghost danger"
          disabled={!canEditSelected}
          title="選んだビンを削除（中の素材は消えません）"
          onClick={() => selected && remove(selected)}
        >
          <Icon name="trash" size={14} label="ビンを削除" />
        </button>
      </div>

      <div
        ref={treeRef}
        className="bin-rows"
        role="tree"
        aria-label="素材のビン"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div
          role="treeitem"
          aria-selected={selected === ALL_BINS}
          className={`bin-row root${selected === ALL_BINS ? ' selected' : ''}${dropTarget === null ? ' drop' : ''}`}
          onClick={() => onSelect(ALL_BINS)}
          {...dragProps(ALL_BINS)}
        >
          <span className="bin-twisty" />
          <Icon name="grid" size={14} />
          <span className="bin-name">すべての素材</span>
          <span className="bin-count">{assets.length}</span>
        </div>

        {editing?.mode === 'new' && editing.path === '' && (
          <NameField depth={0} initial="" onCommit={commit} onCancel={() => setEditing(null)} />
        )}

        {rows.map((node) => (
          <BinRow
            key={node.path}
            node={node}
            expanded={open.has(node.path)}
            selected={selected === node.path}
            dropping={dropTarget === node.path}
            editing={editing}
            onSelect={() => onSelect(node.path)}
            onCommit={commit}
            onCancel={() => setEditing(null)}
            dragProps={dragProps(node.path)}
          />
        ))}
      </div>

      {message && <p className="error-note bin-message">{message}</p>}
      {selectedNode && selectedNode.children.length === 0 && selectedNode.total === 0 && (
        <p className="muted small">空のビンです。素材をドラッグして入れられます。</p>
      )}
    </div>
  );
}

function BinRow({
  node,
  expanded,
  selected,
  dropping,
  editing,
  onSelect,
  onCommit,
  onCancel,
  dragProps,
}: {
  node: BinNode;
  expanded: boolean;
  selected: boolean;
  dropping: boolean;
  editing: Editing | null;
  onSelect: () => void;
  onCommit: (value: string) => boolean;
  onCancel: () => void;
  dragProps: DragHandlers;
}) {
  const hasChildren = node.children.length > 0;
  const renaming = editing?.mode === 'rename' && editing.path === node.path;
  const addingHere = editing?.mode === 'new' && editing.path === node.path;
  return (
    <>
      {renaming ? (
        <NameField depth={node.depth + 1} initial={node.name} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <div
          role="treeitem"
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          className={`bin-row${selected ? ' selected' : ''}${dropping ? ' drop' : ''}`}
          style={{ paddingLeft: 8 + (node.depth + 1) * 14 }}
          draggable={!isProtected(node.path)}
          onDragStart={(e) => {
            e.dataTransfer.setData(BIN_DND_TYPE, node.path);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onClick={onSelect}
          title={node.path}
          {...dragProps}
        >
          <span
            className={`bin-twisty${hasChildren ? (expanded ? ' open' : '') : ' none'}`}
            onClick={(e) => {
              if (!hasChildren) return;
              e.stopPropagation();
              toggleExpanded(node.path);
            }}
          >
            {hasChildren && <Icon name="chevron-right" size={12} />}
          </span>
          <Icon name="folder" size={14} />
          <span className="bin-name">{node.name}</span>
          <span className="bin-count">{node.total}</span>
        </div>
      )}
      {addingHere && (
        <NameField depth={node.depth + 2} initial="" onCommit={onCommit} onCancel={onCancel} />
      )}
    </>
  );
}

function NameField({
  depth,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  initial: string;
  onCommit: (value: string) => boolean;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    if (commit && value.trim() && value.trim() !== initial) {
      // 名前がぶつかるなど失敗したときは、入力欄を残して直せるようにする。
      if (onCommit(value)) done.current = true;
      return;
    }
    done.current = true;
    onCancel();
  };
  return (
    <div className="bin-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="bin-twisty none" />
      <Icon name="folder" size={14} />
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder="ビンの名前"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}

function useSyncAssets() {
  useEffect(() => {
    void mediaRegistry.restore();
  }, []);
  return useSyncExternalStore(mediaRegistry.subscribe, mediaRegistry.getSnapshot, mediaRegistry.getSnapshot);
}
