import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { exporter } from '../engine/exporter';
import { formatTime } from '../engine/media';
import { player } from '../engine/player';
import { renderFrame, type Rect } from '../engine/renderer';
import { clipAt, clipDuration, type Project } from '../types';
import { useEditor } from '../store/editor';

/** プレビューは実解像度で描くと重いので、長辺 720px 程度に落として描画する。 */
function previewSize(project: Project) {
  const scale = Math.min(1, 720 / Math.max(project.width, project.height));
  return { width: Math.round(project.width * scale), height: Math.round(project.height * scale) };
}

export function usePlayerTime(): number {
  return useSyncExternalStore(player.subscribeTime, player.getTime, player.getTime);
}

export function usePlayerPlaying(): boolean {
  return useSyncExternalStore(player.subscribeState, player.getPlaying, player.getPlaying);
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'text'; id: string; offsetX: number; offsetY: number }
  | { kind: 'pan'; id: string; startX: number; startY: number; originX: number; originY: number };

export function Preview() {
  const { project, selection, select, dispatch } = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boundsRef = useRef<Map<string, Rect>>(new Map());
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const [guides, setGuides] = useState(true);

  // 描画ループから最新値を読むための箱（RAF ごとに再購読したくない）
  const latest = useRef({ project, selection, guides });
  latest.current = { project, selection, guides };

  const size = useMemo(() => previewSize(project), [project.width, project.height]);

  useEffect(() => {
    player.update(project);
  }, [project]);

  useEffect(() => {
    const sources = player.renderContext();
    player.start((time) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d', { alpha: false });
      const { project: p, selection: sel, guides: g } = latest.current;
      if (ctx) {
        boundsRef.current = renderFrame(ctx, p, time, sources, {
          guides: g,
          highlightTextId: sel.type === 'text' ? sel.id : null,
        });
      }
      if (exporter.active && exporter.ctx) {
        renderFrame(exporter.ctx, p, time, sources, { guides: false, highlightTextId: null });
      }
    });
    return () => player.stop();
  }, []);

  const toProjectCoords = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * project.width,
        y: ((event.clientY - rect.top) / rect.height) * project.height,
      };
    },
    [project.width, project.height],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toProjectCoords(event);
    const time = player.time;

    // 上に描かれているものから当たり判定
    for (let i = project.texts.length - 1; i >= 0; i -= 1) {
      const overlay = project.texts[i];
      const local = time - overlay.start;
      if (local < 0 || local > overlay.duration) continue;
      const box = boundsRef.current.get(overlay.id);
      if (!box) continue;
      if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h) {
        select({ type: 'text', id: overlay.id });
        dragRef.current = {
          kind: 'text',
          id: overlay.id,
          offsetX: point.x - overlay.x * project.width,
          offsetY: point.y - overlay.y * project.height,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    const clip = clipAt(project, time);
    if (clip) {
      select({ type: 'clip', id: clip.id });
      dragRef.current = {
        kind: 'pan',
        id: clip.id,
        startX: point.x,
        startY: point.y,
        originX: clip.transform.x,
        originY: clip.transform.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.kind === 'none') return;
    const point = toProjectCoords(event);

    if (drag.kind === 'text') {
      dispatch({
        type: 'text/patch',
        id: drag.id,
        key: 'move',
        patch: {
          x: Math.max(0, Math.min(1, (point.x - drag.offsetX) / project.width)),
          y: Math.max(0, Math.min(1, (point.y - drag.offsetY) / project.height)),
        },
      });
    } else {
      dispatch({
        type: 'clip/patch',
        id: drag.id,
        key: 'pan',
        patch: {
          transform: {
            x: drag.originX + (point.x - drag.startX) / project.width,
            y: drag.originY + (point.y - drag.startY) / project.height,
          },
        },
      });
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current.kind !== 'none' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = { kind: 'none' };
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const clip = clipAt(project, player.time);
    if (!clip) return;
    const next = Math.max(0.2, Math.min(6, clip.transform.scale * (event.deltaY > 0 ? 0.96 : 1.04)));
    dispatch({ type: 'clip/patch', id: clip.id, key: 'zoom', patch: { transform: { scale: next } } });
  };

  return (
    <div className="preview">
      <div className="preview-stage">
        <canvas
          ref={canvasRef}
          width={size.width}
          height={size.height}
          style={{ aspectRatio: `${project.width} / ${project.height}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
        />
      </div>
      <Transport guides={guides} onToggleGuides={() => setGuides((g) => !g)} />
    </div>
  );
}

function Transport({ guides, onToggleGuides }: { guides: boolean; onToggleGuides: () => void }) {
  const { project, dispatch, select } = useEditor();
  const time = usePlayerTime();
  const playing = usePlayerPlaying();
  const duration = player.duration;
  const frame = 1 / (project.fps || 30);

  const jump = (direction: -1 | 1) => {
    const boundaries = [0, ...project.clips.map((c) => c.start + clipDuration(c))];
    if (direction < 0) {
      const previous = [...boundaries].reverse().find((b) => b < time - 0.05);
      player.seek(previous ?? 0);
    } else {
      const next = boundaries.find((b) => b > time + 0.05);
      player.seek(next ?? duration);
    }
  };

  const split = () => {
    dispatch({ type: 'clip/split', time: player.time });
    const clip = clipAt(project, player.time);
    if (clip) select({ type: 'clip', id: clip.id });
  };

  return (
    <div className="transport">
      <div className="transport-scrub">
        <input
          type="range"
          min={0}
          max={Math.max(0.01, duration)}
          step={0.01}
          value={Math.min(time, duration)}
          onChange={(e) => player.seek(Number(e.target.value))}
          aria-label="再生位置"
        />
      </div>
      <div className="transport-row">
        <span className="timecode">
          {formatTime(time, true, project.fps)} <em>/ {formatTime(duration)}</em>
        </span>
        <div className="transport-buttons">
          <button type="button" title="前のカット境界へ" onClick={() => jump(-1)}>
            ⏮
          </button>
          <button type="button" title="1 フレーム戻る（←）" onClick={() => player.nudge(-frame)}>
            ◀
          </button>
          <button type="button" className="primary" title="再生 / 一時停止（Space）" onClick={() => player.toggle()}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" title="1 フレーム進む（→）" onClick={() => player.nudge(frame)}>
            ▶
          </button>
          <button type="button" title="次のカット境界へ" onClick={() => jump(1)}>
            ⏭
          </button>
        </div>
        <div className="transport-tools">
          <button type="button" title="再生位置で分割（S）" onClick={split}>
            ✂ 分割
          </button>
          <button
            type="button"
            className={guides ? 'active' : ''}
            title="SNS の UI に隠れる範囲を表示"
            onClick={onToggleGuides}
          >
            ⌗ ガイド
          </button>
          <LoopButton />
        </div>
      </div>
    </div>
  );
}

function LoopButton() {
  const [loop, setLoop] = useState(player.loop);
  return (
    <button
      type="button"
      className={loop ? 'active' : ''}
      title="ループ再生"
      onClick={() => {
        player.setLoop(!loop);
        setLoop(!loop);
      }}
    >
      ⟳ ループ
    </button>
  );
}
