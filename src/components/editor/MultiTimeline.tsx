import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import {
  clipsOnTrack,
  moveClips,
  placeClip,
  previousAdjacent,
  removeClips,
  sequenceDuration,
  snapCandidates,
  snapTime,
  trimClip,
} from '../../model/ops';
import { clipFromAsset } from '../../model/factory';
import { clipEnd, TRANSITION_META, type Clip, type Sequence, type Track } from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { usePlayerTime } from './PreviewStage';

export const MEDIA_DND_TYPE = 'application/x-tateyoko-media';
const MIN_PPS = 6;
const MAX_PPS = 400;
const SNAP_PX = 8;

export function laneHeight(track: Track): number {
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
}

export function MultiTimeline({ pps, setPps, onPickTransition }: Props) {
  const { sequence, apply, selection, setSelection } = useEditor();
  const { settings, updateSettings } = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

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
          const height = laneHeight(track) + 4;
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
    <div className="tl">
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
          ⇤ リップル削除
        </button>
        <span className="tl-count">{selection.length > 0 ? `${selection.length} 個選択中` : ''}</span>
        <span className="spacer" />
        <button
          type="button"
          className={settings.snap ? 'active' : ''}
          onClick={() => updateSettings({ snap: !settings.snap })}
          title="クリップの端に吸着"
        >
          ⇥ スナップ
        </button>
        <button type="button" className={follow ? 'active' : ''} onClick={() => setFollow((f) => !f)} title="再生に合わせてスクロール">
          ⇉ 追従
        </button>
        <div className="zoom">
          <button type="button" onClick={() => setPps((p) => Math.max(MIN_PPS, p / 1.4))} title="縮小">
            −
          </button>
          <button type="button" onClick={() => setPps((p) => Math.min(MAX_PPS, p * 1.4))} title="拡大">
            ＋
          </button>
        </div>
      </div>

      <div className="tl-body">
        <div className="tl-heads">
          <div className="tl-head-spacer" />
          {tracks.map((track) => (
            <TrackHead key={track.id} track={track} />
          ))}
        </div>

        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-inner" style={{ width: innerWidth }}>
            <Ruler pps={pps} duration={duration} onScrub={scrub} />
            <div className="tl-lanes" ref={lanesRef} onPointerDown={(e) => e.target === e.currentTarget && startMarquee(e)}>
              {tracks.map((track) => (
                <Lane
                  key={track.id}
                  track={track}
                  pps={pps}
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

function TrackHead({ track }: { track: Track }) {
  const { apply } = useEditor();
  const patch = (changes: Partial<Track>) =>
    apply((seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.id === track.id ? { ...t, ...changes } : t)) }));

  return (
    <div className={`tl-head kind-${track.kind}`} style={{ height: laneHeight(track) }}>
      <strong>{track.name}</strong>
      <div className="tl-head-buttons">
        {track.kind !== 'audio' && (
          <button
            type="button"
            className={track.hidden ? 'off' : ''}
            title="表示 / 非表示"
            onClick={() => patch({ hidden: !track.hidden })}
          >
            {track.hidden ? '🚫' : '👁'}
          </button>
        )}
        {track.kind !== 'text' && (
          <button
            type="button"
            className={track.muted ? 'off' : ''}
            title="ミュート"
            onClick={() => patch({ muted: !track.muted })}
          >
            {track.muted ? '🔇' : '🔊'}
          </button>
        )}
      </div>
    </div>
  );
}

function Ruler({ pps, duration, onScrub }: { pps: number; duration: number; onScrub: (clientX: number) => void }) {
  const step = pps >= 90 ? 1 : pps >= 45 ? 2 : pps >= 20 ? 5 : pps >= 10 ? 10 : 30;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);

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
  onEmptyPointerDown,
  onPickTransition,
}: {
  track: Track;
  pps: number;
  onEmptyPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPickTransition: (clipId: string) => void;
}) {
  const { sequence, apply } = useEditor();
  const { settings } = useApp();
  const [dropping, setDropping] = useState(false);
  const clips = clipsOnTrack(sequence, track.id);

  const accepts = (kind: string) =>
    (track.kind === 'audio' && kind === 'audio') || (track.kind === 'video' && (kind === 'video' || kind === 'image'));

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const mediaId = event.dataTransfer.getData(MEDIA_DND_TYPE);
    const asset = mediaRegistry.get(mediaId);
    if (!asset || !accepts(asset.kind)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    let start = Math.max(0, (event.clientX - rect.left) / pps);
    if (settings.snap) {
      start = snapTime(start, snapCandidates(sequence, player.time, []), SNAP_PX / pps);
    }
    const clip = clipFromAsset(asset, track.id, start);
    apply((seq) => placeClip(seq, clip));
  };

  return (
    <div
      className={`tl-lane kind-${track.kind}${dropping ? ' dropping' : ''}${track.locked ? ' locked' : ''}`}
      style={{ height: laneHeight(track) }}
      onPointerDown={(e) => e.target === e.currentTarget && onEmptyPointerDown(e)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MEDIA_DND_TYPE)) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {clips.length === 0 && <span className="tl-lane-empty">{track.kind === 'text' ? 'テロップ' : '素材をドラッグ'}</span>}
      {clips.map((clip) => (
        <ClipBlock key={clip.id} clip={clip} track={track} pps={pps} onPickTransition={onPickTransition} />
      ))}
    </div>
  );
}

function ClipBlock({
  clip,
  track,
  pps,
  onPickTransition,
}: {
  clip: Clip;
  track: Track;
  pps: number;
  onPickTransition: (clipId: string) => void;
}) {
  const { sequence, apply, selection, setSelection, toggleSelection, isSelected } = useEditor();
  const { settings } = useApp();
  const asset = mediaRegistry.get(clip.mediaId);
  const selected = isSelected(clip.id);
  const width = Math.max(14, clip.duration * pps);
  const hasPrevious = track.kind === 'video' && previousAdjacent(sequence, clip) !== null;

  const label =
    clip.kind === 'text' ? `T ${clip.text?.content.split('\n')[0] || '（空）'}` : (asset?.name ?? '素材');

  const startMove = (event: React.PointerEvent) => {
    if (track.locked) return;
    const additive = event.shiftKey;
    if (!selected) toggleSelection(clip.id, additive);
    const ids = selected ? selection : additive ? [...selection, clip.id] : [clip.id];
    const rowHeight = laneHeight(track) + 4;
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
    const candidates = snapCandidates(sequence, player.time, [clip.id]);
    beginDrag(event, (dx) => {
      const edge = side === 'left' ? clip.start : clipEnd(clip);
      let delta = dx / pps;
      if (settings.snap) delta = snapTime(edge + delta, candidates, SNAP_PX / pps) - edge;
      apply(() => trimClip(original, clip.id, side, delta), `trim:${clip.id}:${side}`);
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
          {TRANSITION_META[clip.transitionIn.type].icon}
        </button>
      )}
      <span className="tl-clip-label">
        {clip.muted && '🔇 '}
        {clip.speed !== 1 && `${clip.speed}× `}
        {label}
      </span>
      {width > 54 && <span className="tl-clip-time">{clip.duration.toFixed(1)}s</span>}
      <span className="tl-handle right" onPointerDown={(e) => startTrim(e, 'right')} />
    </div>
  );
}

function Playhead({
  pps,
  follow,
  scrollRef,
}: {
  pps: number;
  follow: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const time = usePlayerTime();
  const x = time * pps;

  useEffect(() => {
    if (!follow) return;
    const box = scrollRef.current;
    if (!box) return;
    const margin = 80;
    if (x < box.scrollLeft + margin || x > box.scrollLeft + box.clientWidth - margin) {
      box.scrollLeft = Math.max(0, x - box.clientWidth / 2);
    }
  }, [x, follow, scrollRef]);

  return (
    <div className="tl-playhead" style={{ transform: `translateX(${x}px)` }}>
      <span className="tl-playhead-grip" />
    </div>
  );
}
