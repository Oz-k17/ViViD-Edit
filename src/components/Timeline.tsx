import { useEffect, useRef, useState } from 'react';
import { formatTime, mediaRegistry } from '../engine/media';
import { player } from '../engine/player';
import { clipDuration, projectDuration, type Clip, type TextOverlay } from '../types';
import { makeTextOverlay, useEditor } from '../store/editor';
import { usePlayerTime } from './Preview';

const MIN_PPS = 8;
const MAX_PPS = 320;
const LANE_MIN_SECONDS = 12;

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

export function Timeline() {
  const { project, dispatch, selection, select } = useEditor();
  const [pps, setPps] = useState(60);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<{ from: number; to: number; dx: number } | null>(null);

  const duration = Math.max(projectDuration(project), LANE_MIN_SECONDS);
  const innerWidth = duration * pps + 160;

  const seekFromEvent = (event: { clientX: number }) => {
    const track = laneRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    player.seek(Math.max(0, (event.clientX - rect.left) / pps));
  };

  const addText = () => {
    const overlay = makeTextOverlay('caption', player.time, 3);
    dispatch({ type: 'text/add', overlay });
    select({ type: 'text', id: overlay.id });
  };

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button type="button" onClick={addText}>
          ＋ テキスト
        </button>
        <button type="button" onClick={() => dispatch({ type: 'clip/split', time: player.time })}>
          ✂ 分割
        </button>
        <span className="spacer" />
        <button
          type="button"
          className={follow ? 'active' : ''}
          title="再生に合わせてスクロール"
          onClick={() => setFollow((f) => !f)}
        >
          ⇥ 追従
        </button>
        <div className="zoom">
          <button type="button" onClick={() => setPps((p) => Math.max(MIN_PPS, p / 1.4))} title="ズームアウト">
            −
          </button>
          <button type="button" onClick={() => setPps((p) => Math.min(MAX_PPS, p * 1.4))} title="ズームイン">
            ＋
          </button>
        </div>
      </div>

      <div className="timeline-scroll" ref={scrollRef}>
        <div className="timeline-inner" style={{ width: innerWidth }} ref={laneRef}>
          <Ruler pps={pps} duration={duration} onSeek={seekFromEvent} />

          <div className="lane lane-clips" onPointerDown={(e) => e.target === e.currentTarget && seekFromEvent(e)}>
            {project.clips.length === 0 && <span className="lane-empty">素材を「タイムラインへ」で追加</span>}
            {project.clips.map((clip, index) => (
              <ClipBlock
                key={clip.id}
                clip={clip}
                index={index}
                pps={pps}
                selected={selection.type === 'clip' && selection.id === clip.id}
                dragState={dragIndex}
                onDragState={setDragIndex}
              />
            ))}
          </div>

          <div className="lane lane-texts" onPointerDown={(e) => e.target === e.currentTarget && seekFromEvent(e)}>
            {project.texts.length === 0 && <span className="lane-empty">テキスト</span>}
            {project.texts.map((overlay) => (
              <TextBlock
                key={overlay.id}
                overlay={overlay}
                pps={pps}
                selected={selection.type === 'text' && selection.id === overlay.id}
              />
            ))}
          </div>

          <div className="lane lane-music" onPointerDown={(e) => e.target === e.currentTarget && seekFromEvent(e)}>
            {!project.music && <span className="lane-empty">BGM（音声素材を読み込んで設定）</span>}
            {project.music && <MusicBlock pps={pps} selected={selection.type === 'music'} />}
          </div>

          <Playhead pps={pps} follow={follow} scrollRef={scrollRef} />
        </div>
      </div>
    </div>
  );
}

function Ruler({
  pps,
  duration,
  onSeek,
}: {
  pps: number;
  duration: number;
  onSeek: (event: { clientX: number }) => void;
}) {
  const step = pps >= 80 ? 1 : pps >= 40 ? 2 : pps >= 18 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  return (
    <div
      className="ruler"
      onPointerDown={(event) => {
        onSeek(event);
        beginDrag(event, (_dx, _dy, native) => onSeek({ clientX: native.clientX }));
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

function ClipBlock({
  clip,
  index,
  pps,
  selected,
  dragState,
  onDragState,
}: {
  clip: Clip;
  index: number;
  pps: number;
  selected: boolean;
  dragState: { from: number; to: number; dx: number } | null;
  onDragState: (value: { from: number; to: number; dx: number } | null) => void;
}) {
  const { project, dispatch, select } = useEditor();
  const asset = mediaRegistry.get(clip.mediaId);
  const width = clipDuration(clip) * pps;
  const speed = clip.kind === 'image' ? 1 : clip.speed || 1;
  const maxOut = clip.kind === 'image' ? Number.POSITIVE_INFINITY : (asset?.duration ?? clip.out);
  const isDragging = dragState?.from === index;

  const startTrim = (event: React.PointerEvent, side: 'left' | 'right') => {
    const in0 = clip.in;
    const out0 = clip.out;
    beginDrag(event, (dx) => {
      const ds = (dx / pps) * speed;
      if (side === 'left') {
        if (clip.kind === 'image') return;
        dispatch({ type: 'clip/patch', id: clip.id, key: 'trim', patch: { in: Math.max(0, Math.min(out0 - 0.1, in0 + ds)) } });
      } else {
        dispatch({
          type: 'clip/patch',
          id: clip.id,
          key: 'trim',
          patch: { out: Math.max(in0 + 0.1, Math.min(maxOut, out0 + ds)) },
        });
      }
    });
  };

  const startReorder = (event: React.PointerEvent) => {
    select({ type: 'clip', id: clip.id });
    const widths = project.clips.map((c) => clipDuration(c) * pps);
    const left = widths.slice(0, index).reduce((a, b) => a + b, 0);
    let target = index;
    beginDrag(
      event,
      (dx) => {
        const center = left + dx + widths[index] / 2;
        let acc = 0;
        target = project.clips.length - 1;
        for (let i = 0; i < widths.length; i += 1) {
          if (center < acc + widths[i] / 2) {
            target = i;
            break;
          }
          acc += widths[i];
        }
        onDragState({ from: index, to: target, dx });
      },
      () => {
        if (target !== index) dispatch({ type: 'clip/reorder', from: index, to: target });
        onDragState(null);
      },
    );
  };

  return (
    <div
      className={`block clip-block${selected ? ' selected' : ''}${isDragging ? ' dragging' : ''}`}
      style={{
        left: clip.start * pps,
        width: Math.max(18, width),
        transform: isDragging ? `translateX(${dragState.dx}px)` : undefined,
        backgroundImage: asset?.thumbnail ? `url(${asset.thumbnail})` : undefined,
      }}
      onPointerDown={startReorder}
      title={`${asset?.name ?? '素材'} — ${clipDuration(clip).toFixed(2)}秒`}
    >
      <span className="block-handle left" onPointerDown={(e) => startTrim(e, 'left')} />
      <span className="block-label">
        {clip.muted && '🔇 '}
        {speed !== 1 && `${speed}× `}
        {asset?.name ?? '素材'}
      </span>
      <span className="block-duration">{clipDuration(clip).toFixed(1)}s</span>
      <span className="block-handle right" onPointerDown={(e) => startTrim(e, 'right')} />
    </div>
  );
}

function TextBlock({ overlay, pps, selected }: { overlay: TextOverlay; pps: number; selected: boolean }) {
  const { dispatch, select } = useEditor();

  const move = (event: React.PointerEvent) => {
    select({ type: 'text', id: overlay.id });
    const start0 = overlay.start;
    beginDrag(event, (dx) => {
      dispatch({ type: 'text/patch', id: overlay.id, key: 'slide', patch: { start: Math.max(0, start0 + dx / pps) } });
    });
  };

  const resize = (event: React.PointerEvent, side: 'left' | 'right') => {
    const start0 = overlay.start;
    const dur0 = overlay.duration;
    beginDrag(event, (dx) => {
      const ds = dx / pps;
      if (side === 'left') {
        const start = Math.max(0, Math.min(start0 + dur0 - 0.2, start0 + ds));
        dispatch({
          type: 'text/patch',
          id: overlay.id,
          key: 'resize',
          patch: { start, duration: dur0 + (start0 - start) },
        });
      } else {
        dispatch({ type: 'text/patch', id: overlay.id, key: 'resize', patch: { duration: Math.max(0.2, dur0 + ds) } });
      }
    });
  };

  return (
    <div
      className={`block text-block${selected ? ' selected' : ''}`}
      style={{ left: overlay.start * pps, width: Math.max(18, overlay.duration * pps) }}
      onPointerDown={move}
      title={overlay.text}
    >
      <span className="block-handle left" onPointerDown={(e) => resize(e, 'left')} />
      <span className="block-label">T {overlay.text.split('\n')[0] || '（空）'}</span>
      <span className="block-handle right" onPointerDown={(e) => resize(e, 'right')} />
    </div>
  );
}

function MusicBlock({ pps, selected }: { pps: number; selected: boolean }) {
  const { project, dispatch, select } = useEditor();
  const music = project.music;
  if (!music) return null;
  const asset = mediaRegistry.get(music.mediaId);
  const span = Math.max(0.2, music.out - music.in);

  const move = (event: React.PointerEvent) => {
    select({ type: 'music' });
    const start0 = music.start;
    beginDrag(event, (dx) => {
      dispatch({ type: 'music/patch', key: 'slide', patch: { start: Math.max(0, start0 + dx / pps) } });
    });
  };

  const resize = (event: React.PointerEvent, side: 'left' | 'right') => {
    const in0 = music.in;
    const out0 = music.out;
    beginDrag(event, (dx) => {
      const ds = dx / pps;
      if (side === 'left') {
        dispatch({ type: 'music/patch', key: 'trim', patch: { in: Math.max(0, Math.min(out0 - 0.2, in0 + ds)) } });
      } else {
        dispatch({
          type: 'music/patch',
          key: 'trim',
          patch: { out: Math.max(in0 + 0.2, Math.min(asset?.duration ?? out0, out0 + ds)) },
        });
      }
    });
  };

  return (
    <div
      className={`block music-block${selected ? ' selected' : ''}`}
      style={{ left: music.start * pps, width: Math.max(18, span * pps) }}
      onPointerDown={move}
      title={asset?.name}
    >
      <span className="block-handle left" onPointerDown={(e) => resize(e, 'left')} />
      <span className="block-label">♪ {asset?.name ?? 'BGM'}</span>
      <span className="block-handle right" onPointerDown={(e) => resize(e, 'right')} />
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
    <div className="playhead" style={{ transform: `translateX(${x}px)` }}>
      <span className="playhead-grip" />
    </div>
  );
}
