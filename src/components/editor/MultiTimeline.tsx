import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import { sourceLengthOf } from '../../engine/sourceLength';
import { EDIT_MODES, dragByMode, trimByMode, type EditMode } from '../../model/editModes';
import { placeClips } from '../../model/editOps';
import {
  adoptSourceFps,
  clipsOnTrack,
  moveClips,
  previousAdjacent,
  removeClips,
  sequenceDuration,
  snapCandidates,
  snapTime,
} from '../../model/ops';
import { clipFromAsset } from '../../model/factory';
import { clipEnd, previewText, type Clip, type Sequence, type Track } from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { EyeIcon, EyeOffIcon, MuteIcon, SoundIcon } from '../ui';
import { Icon } from '../Icon';
import { TRANSITION_ICON } from './transitionIcon';
import { useTimelineActions } from './timelineActions';

export const MEDIA_DND_TYPE = 'application/x-vivid-media';
/** 複数の素材をまとめてドラッグするときの id の配列（JSON）。単体の `MEDIA_DND_TYPE` も併せて入れる。 */
export const MEDIA_LIST_DND_TYPE = 'application/x-vivid-media-list';

/** ドラッグされている素材の id を、複数・単体どちらの形からでも取り出す。 */
export function draggedMediaIds(dt: DataTransfer): string[] {
  try {
    const list = JSON.parse(dt.getData(MEDIA_LIST_DND_TYPE) || 'null');
    if (Array.isArray(list) && list.every((v) => typeof v === 'string') && list.length > 0) return list;
  } catch {
    /* 単体の形へ */
  }
  const one = dt.getData(MEDIA_DND_TYPE);
  return one ? [one] : [];
}

/** 修飾キーでの一時的なモード切り替え（Premiere のツールを押している間だけ変える動きに相当）。 */
function effectiveMode(mode: EditMode, event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }, target: 'edge' | 'body'): EditMode {
  const mod = event.ctrlKey || event.metaKey;
  if (target === 'edge') return event.altKey ? 'ripple' : mod ? 'roll' : mode;
  return event.altKey ? 'slip' : mod ? 'slide' : mode;
}
const MIN_PPS = 6;
const MAX_PPS = 400;
const SNAP_PX = 8;

/** compact はスマホ表示用に一回り小さくしたレーンの高さ。 */
export function laneHeight(track: Track, compact = false): number {
  if (compact) return track.kind === 'video' ? 44 : track.kind === 'audio' ? 30 : 26;
  return track.kind === 'video' ? 56 : track.kind === 'audio' ? 40 : 34;
}

/** Premiere と同じく、上からテロップ → V2 → V1 → A1 の順に並べる。 */
export function displayTracks(sequence: Sequence): Track[] {
  const byKind = (kind: Track['kind']) => sequence.tracks.filter((t) => t.kind === kind);
  return [...byKind('text').reverse(), ...byKind('video').reverse(), ...byKind('audio')];
}

function beginDrag(
  event: React.PointerEvent,
  onMove: (dx: number, dy: number, native: PointerEvent) => void,
  onEnd?: () => void,
) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startY = event.clientY;
  const move = (e: PointerEvent) => onMove(e.clientX - startX, e.clientY - startY, e);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onEnd?.();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

interface Props {
  pps: number;
  setPps: (value: number | ((prev: number) => number)) => void;
  onPickTransition: (clipId: string) => void;
  compact?: boolean;
}

export function MultiTimeline({ pps, setPps, onPickTransition, compact = false }: Props) {
  const { sequence, apply, selection, setSelection, editMode, setEditMode, insertMode, setInsertMode, markIn, markOut } = useEditor();
  const { settings, updateSettings } = useApp();
  const actions = useTimelineActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  /** いま見えている横の範囲（px）。ルーラーの目盛りを見える分だけ描くのに使う。 */
  const [view, setView] = useState({ left: 0, width: 1600 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setView((prev) =>
        Math.abs(prev.left - box.scrollLeft) < 40 && Math.abs(prev.width - box.clientWidth) < 1
          ? prev
          : { left: box.scrollLeft, width: box.clientWidth },
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    box.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(box);
    return () => {
      box.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const tracks = useMemo(() => displayTracks(sequence), [sequence]);
  const duration = Math.max(sequenceDuration(sequence), 12);
  const innerWidth = duration * pps + 200;

  const timeFromClientX = (clientX: number) => {
    const lanes = lanesRef.current;
    if (!lanes) return 0;
    return Math.max(0, (clientX - lanes.getBoundingClientRect().left) / pps);
  };

  const scrub = (clientX: number) => player.seek(timeFromClientX(clientX));

  /** 空き領域のドラッグで範囲選択。 */
  const startMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    const lanes = lanesRef.current;
    if (!lanes) return;
    const rect = lanes.getBoundingClientRect();
    const origin = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // 途中の値を追いかけるので、state ではなく ref に持つ
    const box = { ...origin, w: 0, h: 0 };
    setMarquee(box);
    if (!event.shiftKey) setSelection([]);

    beginDrag(
      event,
      (dx, dy) => {
        const next = {
          x: dx < 0 ? origin.x + dx : origin.x,
          y: dy < 0 ? origin.y + dy : origin.y,
          w: Math.abs(dx),
          h: Math.abs(dy),
        };
        box.x = next.x;
        box.y = next.y;
        box.w = next.w;
        box.h = next.h;
        setMarquee(next);
      },
      () => {
        setMarquee(null);
        if (box.w < 4 && box.h < 4) {
          scrub(rect.left + box.x);
          return;
        }
        const from = box.x / pps;
        const to = (box.x + box.w) / pps;
        let top = 0;
        const hits: string[] = [];
        for (const track of tracks) {
          const height = laneHeight(track, compact) + 4;
          const overlapsRow = top < box.y + box.h && top + height > box.y;
          if (overlapsRow) {
            for (const clip of clipsOnTrack(sequence, track.id)) {
              if (clip.start < to && clipEnd(clip) > from) hits.push(clip.id);
            }
          }
          top += height;
        }
        setSelection(hits);
      },
    );
  };

  return (
    <div className={`tl${compact ? ' compact' : ''} mode-${editMode}`}>
      <div className="tl-toolbar">
        <button type="button" onClick={() => apply((seq) => removeClips(seq, selection, false))} disabled={!selection.length}>
          削除
        </button>
        <button
          type="button"
          onClick={() => apply((seq) => removeClips(seq, selection, true))}
          disabled={!selection.length}
          title="後続のクリップを詰めて削除（Shift+Delete）"
        >
          <Icon name="ripple-delete" />リップル削除
        </button>
        <span className="tl-count">{selection.length > 0 ? `${selection.length} 個選択中` : ''}</span>
        <span className="spacer" />
        <button
          type="button"
          className={settings.snap ? 'active' : ''}
          onClick={() => updateSettings({ snap: !settings.snap })}
          title="クリップの端に吸着"
        >
          <Icon name="magnet" />スナップ
        </button>
        <button type="button" className={follow ? 'active' : ''} onClick={() => setFollow((f) => !f)} title="再生中だけ、再生ヘッドに合わせてスクロール">
          <Icon name="link" />追従
        </button>
        <div className="zoom">
          <button type="button" onClick={() => setPps((p) => Math.max(MIN_PPS, p / 1.4))} title="縮小">
            <Icon name="minus" size={15} label="縮小" />
          </button>
          <button type="button" onClick={() => setPps((p) => Math.min(MAX_PPS, p * 1.4))} title="拡大">
            <Icon name="plus" size={15} label="拡大" />
          </button>
        </div>
      </div>

      <div className="tl-tools" role="toolbar" aria-label="編集ツール">
        <div className="tl-modes" role="radiogroup" aria-label="編集モード">
          {EDIT_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={editMode === m.key}
              className={editMode === m.key ? 'active' : ''}
              title={m.hint}
              onClick={() => setEditMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={insertMode ? 'active' : ''}
          aria-pressed={insertMode}
          onClick={() => setInsertMode(!insertMode)}
          title="素材を置くとき、既存のクリップを上書きせず、後ろへ送って挿入する"
        >
          挿入配置
        </button>
        <span className="tl-sep" />
        <button type="button" onClick={actions.markIn} title="再生ヘッドに In 点を打つ（I）">
          In
        </button>
        <button type="button" onClick={actions.markOut} title="再生ヘッドに Out 点を打つ（O）">
          Out
        </button>
        <button type="button" onClick={actions.lift} disabled={!actions.hasRange} title="In〜Out を取り除く（隙間が残る）">
          リフト
        </button>
        <button type="button" onClick={actions.extract} disabled={!actions.hasRange} title="In〜Out を取り除いて詰める">
          抽出
        </button>
        <button
          type="button"
          onClick={actions.clearMarks}
          disabled={markIn === null && markOut === null}
          title="In / Out を消す"
        >
          <Icon name="xmark" size={13} label="In / Out を消す" />
        </button>
        <span className="tl-sep" />
        <button type="button" onClick={actions.closeGap} title="再生ヘッド位置の隙間を詰める">
          隙間を詰める
        </button>
        <button type="button" onClick={actions.addEditAll} title="全トラックの再生ヘッド位置で分割（編集点を追加）">
          全トラック分割
        </button>
        <button type="button" onClick={actions.prevEdit} title="前の編集点へ（↑）">
          <Icon name="step-back" size={14} label="前の編集点へ" />
        </button>
        <button type="button" onClick={actions.nextEdit} title="次の編集点へ（↓）">
          <Icon name="step-forward" size={14} label="次の編集点へ" />
        </button>
      </div>

      <div className="tl-body">
        <div className="tl-heads">
          <div className="tl-head-spacer" />
          {tracks.map((track) => (
            <TrackHead key={track.id} track={track} compact={compact} />
          ))}
        </div>

        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-inner" style={{ width: innerWidth }}>
            {markIn !== null && (
              <div
                className={`tl-range${markOut === null ? ' open' : ''}`}
                style={{ left: markIn * pps, width: markOut === null ? 2 : Math.max(2, (markOut - markIn) * pps) }}
                aria-hidden
              />
            )}
            <Ruler pps={pps} duration={duration} view={view} onScrub={scrub} />
            <div className="tl-lanes" ref={lanesRef} onPointerDown={(e) => e.target === e.currentTarget && startMarquee(e)}>
              {tracks.map((track) => (
                <Lane
                  key={track.id}
                  track={track}
                  pps={pps}
                  compact={compact}
                  onEmptyPointerDown={startMarquee}
                  onPickTransition={onPickTransition}
                />
              ))}
              {marquee && (
                <div
                  className="marquee"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
                />
              )}
            </div>
            <Playhead pps={pps} follow={follow} scrollRef={scrollRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackHead({ track, compact }: { track: Track; compact: boolean }) {
  const { apply } = useEditor();
  const patch = (changes: Partial<Track>) =>
    apply((seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.id === track.id ? { ...t, ...changes } : t)) }));

  return (
    <div className={`tl-head kind-${track.kind}`} style={{ height: laneHeight(track, compact) }}>
      <strong>{track.name}</strong>
      <div className="tl-head-buttons">
        {track.kind !== 'audio' && (
          <button
            type="button"
            className={track.hidden ? 'off' : ''}
            title="表示 / 非表示"
            onClick={() => patch({ hidden: !track.hidden })}
          >
            {track.hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
        {track.kind !== 'text' && (
          <button
            type="button"
            className={track.muted ? 'off' : ''}
            title="ミュート"
            onClick={() => patch({ muted: !track.muted })}
          >
            {track.muted ? <MuteIcon /> : <SoundIcon />}
          </button>
        )}
      </div>
    </div>
  );
}

function Ruler({
  pps,
  duration,
  view,
  onScrub,
}: {
  pps: number;
  duration: number;
  view: { left: number; width: number };
  onScrub: (clientX: number) => void;
}) {
  const step = pps >= 90 ? 1 : pps >= 45 ? 2 : pps >= 20 ? 5 : pps >= 10 ? 10 : 30;
  // 長い素材（3 時間なら 5000 個以上）の目盛りを全部 DOM にすると、拡大縮小のたびに止まる。
  // 見えている範囲と、その左右に画面 1 枚ぶんの余白だけを描く。
  const from = Math.max(0, Math.floor((view.left - view.width) / pps / step) * step);
  const to = Math.min(duration, (view.left + view.width * 2) / pps);
  const ticks: number[] = [];
  for (let t = from; t <= to; t += step) ticks.push(t);

  return (
    <div
      className="tl-ruler"
      onPointerDown={(event) => {
        onScrub(event.clientX);
        beginDrag(event, (_dx, _dy, native) => onScrub(native.clientX));
      }}
    >
      {ticks.map((t) => (
        <span key={t} className="tick" style={{ left: t * pps }}>
          {formatTime(t)}
        </span>
      ))}
    </div>
  );
}

function Lane({
  track,
  pps,
  compact,
  onEmptyPointerDown,
  onPickTransition,
}: {
  track: Track;
  pps: number;
  compact: boolean;
  onEmptyPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPickTransition: (clipId: string) => void;
}) {
  const { sequence, apply, insertMode } = useEditor();
  const { settings } = useApp();
  const [dropping, setDropping] = useState(false);
  const clips = clipsOnTrack(sequence, track.id);

  const accepts = (kind: string) =>
    (track.kind === 'audio' && kind === 'audio') || (track.kind === 'video' && (kind === 'video' || kind === 'image'));

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const assets = draggedMediaIds(event.dataTransfer)
      .map((id) => mediaRegistry.get(id))
      .filter((a): a is NonNullable<typeof a> => !!a && accepts(a.kind));
    if (assets.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    let start = Math.max(0, (event.clientX - rect.left) / pps);
    if (settings.snap) {
      start = snapTime(start, snapCandidates(sequence, player.time, []), SNAP_PX / pps);
    }
    // 複数なら、ドロップした位置から順に隙間なく並べる。
    const clips: Clip[] = [];
    let at = start;
    for (const asset of assets) {
      const clip = clipFromAsset(asset, track.id, at);
      clips.push(clip);
      at = clipEnd(clip);
    }
    apply((seq) => placeClips(adoptSourceFps(seq, assets[0].fps), clips, insertMode));
  };

  return (
    <div
      className={`tl-lane kind-${track.kind}${dropping ? ' dropping' : ''}${track.locked ? ' locked' : ''}`}
      style={{ height: laneHeight(track, compact) }}
      onPointerDown={(e) => e.target === e.currentTarget && onEmptyPointerDown(e)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MEDIA_DND_TYPE) || e.dataTransfer.types.includes(MEDIA_LIST_DND_TYPE)) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {clips.length === 0 && <span className="tl-lane-empty">{track.kind === 'text' ? 'テロップ' : '素材をドラッグ'}</span>}
      {clips.map((clip) => (
        <ClipBlock key={clip.id} clip={clip} track={track} pps={pps} compact={compact} onPickTransition={onPickTransition} />
      ))}
    </div>
  );
}

function ClipBlock({
  clip,
  track,
  pps,
  compact,
  onPickTransition,
}: {
  clip: Clip;
  track: Track;
  pps: number;
  compact: boolean;
  onPickTransition: (clipId: string) => void;
}) {
  const { sequence, apply, selection, setSelection, toggleSelection, isSelected, editMode } = useEditor();
  const { settings } = useApp();
  const asset = mediaRegistry.get(clip.mediaId);
  const selected = isSelected(clip.id);
  const width = Math.max(14, clip.duration * pps);
  const hasPrevious = track.kind === 'video' && previousAdjacent(sequence, clip) !== null;

  const label =
    clip.kind === 'text' ? `T ${previewText(clip.text?.content ?? '').split('\n')[0] || '（空）'}` : (asset?.name ?? '素材');

  const startMove = (event: React.PointerEvent) => {
    if (track.locked) return;
    // スリップ / スライドは、動かすのではなく中身・前後を変えるドラッグ。選択はそのクリップだけにする。
    const bodyMode = effectiveMode(editMode, event, 'body');
    if (bodyMode === 'slip' || bodyMode === 'slide') {
      setSelection([clip.id]);
      const original = sequence;
      beginDrag(event, (dx) => {
        const delta = dx / pps;
        apply(() => dragByMode(original, clip.id, delta, bodyMode, sourceLengthOf) ?? original, `${bodyMode}:${clip.id}`);
      });
      return;
    }
    const additive = event.shiftKey;
    if (!selected) toggleSelection(clip.id, additive);
    const ids = selected ? selection : additive ? [...selection, clip.id] : [clip.id];
    const rowHeight = laneHeight(track, compact) + 4;
    // 差分を積み上げると carve と噛み合ってズレるので、常に開始時点の状態から作り直す。
    const original = sequence;
    const candidates = snapCandidates(sequence, player.time, ids);
    let moved = false;

    beginDrag(
      event,
      (dx, dy) => {
        let deltaTime = dx / pps;
        if (settings.snap) {
          deltaTime = snapTime(clip.start + deltaTime, candidates, SNAP_PX / pps) - clip.start;
        }
        // 画面では上ほど番号が大きいので、下方向のドラッグは -1 段
        const deltaTrack = -Math.round(dy / rowHeight);
        if (Math.abs(deltaTime) < 0.002 && deltaTrack === 0) return;
        moved = true;
        apply(() => moveClips(original, ids, deltaTime, deltaTrack), `move:${clip.id}`);
      },
      () => {
        if (!moved && !event.shiftKey) setSelection([clip.id]);
      },
    );
  };

  const startTrim = (event: React.PointerEvent, side: 'left' | 'right') => {
    if (track.locked) return;
    setSelection([clip.id]);
    const original = sequence;
    const mode = effectiveMode(editMode, event, 'edge');
    const candidates = snapCandidates(sequence, player.time, [clip.id]);
    beginDrag(event, (dx) => {
      const edge = side === 'left' ? clip.start : clipEnd(clip);
      let delta = dx / pps;
      if (settings.snap) delta = snapTime(edge + delta, candidates, SNAP_PX / pps) - edge;
      apply(() => trimByMode(original, clip.id, side, delta, mode, sourceLengthOf), `trim:${mode}:${clip.id}:${side}`);
    });
  };

  return (
    <div
      className={`tl-clip kind-${clip.kind}${selected ? ' selected' : ''}`}
      style={{
        left: clip.start * pps,
        width,
        backgroundImage: asset?.thumbnail ? `url(${asset.thumbnail})` : undefined,
      }}
      onPointerDown={startMove}
      title={`${label} — ${clip.duration.toFixed(2)}秒`}
    >
      <span className="tl-handle left" onPointerDown={(e) => startTrim(e, 'left')} />
      {hasPrevious && (
        <button
          type="button"
          className={`tl-transition${clip.transitionIn.type !== 'none' ? ' on' : ''}`}
          title="継ぎ目の切り替え効果"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onPickTransition(clip.id);
          }}
        >
          <Icon name={TRANSITION_ICON[clip.transitionIn.type]} size={12} />
        </button>
      )}
      <span className="tl-clip-label">
        {clip.muted && <MuteIcon />}
        {clip.speed !== 1 && `${clip.speed}× `}
        {label}
      </span>
      {width > 54 && <span className="tl-clip-time">{clip.duration.toFixed(1)}s</span>}
      <span className="tl-handle right" onPointerDown={(e) => startTrim(e, 'right')} />
    </div>
  );
}

/** 追従スクロールの確認間隔（ミリ秒）。毎フレームやると同期レイアウトを起こす。 */
const FOLLOW_CHECK_MS = 250;

function Playhead({
  pps,
  follow,
  scrollRef,
}: {
  pps: number;
  follow: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 再生ヘッドは毎フレーム動くので、React の再描画ではなく transform を直接書き換える。
  // 追従スクロールは scrollLeft を読む＝同期レイアウトが走るため、毎フレームではなく間引く。
  useEffect(() => {
    let lastCheck = 0;
    return player.subscribeFrame((time) => {
      const x = time * pps;
      if (ref.current) ref.current.style.transform = `translateX(${x}px)`;
      // 追従は再生中だけ。停止中にシーク・コマ送り・編集点移動をしても、見ている位置を動かさない。
      if (!follow || !player.playing) return;
      const now = performance.now();
      if (now - lastCheck < FOLLOW_CHECK_MS) return;
      lastCheck = now;
      const box = scrollRef.current;
      if (!box) return;
      const margin = 80;
      if (x < box.scrollLeft + margin || x > box.scrollLeft + box.clientWidth - margin) {
        box.scrollLeft = Math.max(0, x - box.clientWidth / 2);
      }
    });
  }, [pps, follow, scrollRef]);

  return (
    <div className="tl-playhead" ref={ref} style={{ transform: `translateX(${player.time * pps}px)` }}>
      <span className="tl-playhead-grip" />
    </div>
  );
}
