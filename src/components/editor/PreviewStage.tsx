import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { exporter } from '../../engine/exporter';
import { formatTime } from '../../engine/media';
import { player } from '../../engine/player';
import { renderFrame, type Rect } from '../../engine/renderer';
import { clipAtTime, clipsOnTrack, splitAt } from '../../model/ops';
import { clipEnd, type Clip, type Sequence } from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';

/**
 * プレビューを描く解像度。実解像度のまま描くと重いので落とす。
 * 素材が重くて再生がカクつくときは、設定でさらに下げられる（書き出しには影響しない）。
 */
function previewSize(sequence: Sequence, longEdge: number) {
  const scale = Math.min(1, longEdge / Math.max(sequence.width, sequence.height));
  return { width: Math.round(sequence.width * scale), height: Math.round(sequence.height * scale) };
}

export function usePlayerTime(): number {
  return useSyncExternalStore(player.subscribeTime, player.getTime, player.getTime);
}

export function usePlayerPlaying(): boolean {
  return useSyncExternalStore(player.subscribeState, player.getPlaying, player.getPlaying);
}

type Drag =
  | { kind: 'none' }
  | { kind: 'move'; id: string; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'crop'; id: string; startX: number; startY: number; originX: number; originY: number };

export function PreviewStage() {
  const { sequence, selection, setSelection, apply } = useEditor();
  const { settings } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boundsRef = useRef<Map<string, Rect>>(new Map());
  const dragRef = useRef<Drag>({ kind: 'none' });
  const [guides, setGuides] = useState(true);

  // 描画ループから最新値を読むための箱（RAF ごとに購読し直したくない）
  const latest = useRef({ sequence, selection, guides });
  latest.current = { sequence, selection, guides };

  const size = useMemo(
    () => previewSize(sequence, settings.previewQuality),
    [sequence.width, sequence.height, settings.previewQuality],
  );

  useEffect(() => {
    player.update(sequence);
  }, [sequence]);

  useEffect(() => {
    const sources = player.renderSources();
    // getContext は毎フレーム呼ばず一度だけ取る。
    let ctx: CanvasRenderingContext2D | null = null;
    let ctxOwner: HTMLCanvasElement | null = null;
    player.start((time) => {
      const canvas = canvasRef.current;
      if (canvas && canvas !== ctxOwner) {
        ctx = canvas.getContext('2d', { alpha: false });
        ctxOwner = canvas;
      }
      const { sequence: seq, selection: sel, guides: g } = latest.current;
      // 書き出し中はプレビューを描かない。モーダルの裏に隠れて見えないうえ、
      // 描画に処理時間を取られると書き出しそのものが遅く・不安定になる。
      if (exporter.active) {
        // 実時間収録で書き出す場合のみ、収録用キャンバスへ描く。
        if (exporter.ctx && exporter.sequence) {
          renderFrame(exporter.ctx, exporter.sequence, time, sources, { guides: false, selectedIds: [] });
        }
      } else if (ctx) {
        boundsRef.current = renderFrame(ctx, seq, time, sources, { guides: g, selectedIds: sel });
      }
    });
    return () => player.stop();
  }, []);

  const toSequenceCoords = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * sequence.width,
        y: ((event.clientY - rect.top) / rect.height) * sequence.height,
      };
    },
    [sequence.width, sequence.height],
  );

  const hit = (rect: Rect | undefined, point: { x: number; y: number }) =>
    !!rect && point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toSequenceCoords(event);
    const time = player.time;

    // 選択中クリップのクロップ枠を最優先で掴む
    for (const id of selection) {
      const clip = sequence.clips.find((c) => c.id === id);
      if (!clip?.crop.enabled) continue;
      if (hit(boundsRef.current.get(`crop:${id}`), point)) {
        dragRef.current = {
          kind: 'crop',
          id,
          startX: point.x,
          startY: point.y,
          originX: clip.crop.dx,
          originY: clip.crop.dy,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    // テキストは上に描かれているものから
    const textClips = sequence.clips.filter(
      (c) => c.kind === 'text' && time >= c.start && time < clipEnd(c),
    );
    for (let i = textClips.length - 1; i >= 0; i -= 1) {
      const clip = textClips[i];
      if (hit(boundsRef.current.get(clip.id), point)) {
        setSelection([clip.id]);
        dragRef.current = { kind: 'move', id: clip.id, startX: point.x, startY: point.y, originX: clip.x, originY: clip.y };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    // それ以外は一番上の映像トラックのクリップを動かす
    const videoTracks = sequence.tracks.filter((t) => t.kind === 'video' && !t.hidden);
    for (let i = videoTracks.length - 1; i >= 0; i -= 1) {
      const clip = clipAtTime(sequence, videoTracks[i].id, time);
      if (!clip) continue;
      setSelection([clip.id]);
      dragRef.current = { kind: 'move', id: clip.id, startX: point.x, startY: point.y, originX: clip.x, originY: clip.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.kind === 'none') return;
    const point = toSequenceCoords(event);
    const dx = (point.x - drag.startX) / sequence.width;
    const dy = (point.y - drag.startY) / sequence.height;

    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => {
          if (c.id !== drag.id) return c;
          if (drag.kind === 'crop') {
            return { ...c, crop: { ...c.crop, dx: drag.originX + dx, dy: drag.originY + dy } };
          }
          return { ...c, x: drag.originX + dx, y: drag.originY + dy };
        }),
      }),
      `${drag.kind}:${drag.id}`,
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current.kind !== 'none' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = { kind: 'none' };
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const id = selection[0];
    const clip = id ? sequence.clips.find((c) => c.id === id) : null;
    if (!clip) return;
    const next = Math.max(0.1, Math.min(6, clip.scale * (event.deltaY > 0 ? 0.96 : 1.04)));
    apply(
      (seq) => ({ ...seq, clips: seq.clips.map((c) => (c.id === clip.id ? { ...c, scale: next } : c)) }),
      `scale:${clip.id}`,
    );
  };

  return (
    <div className="preview">
      <div className="preview-stage">
        <canvas
          ref={canvasRef}
          width={size.width}
          height={size.height}
          style={{ aspectRatio: `${sequence.width} / ${sequence.height}` }}
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
  const { sequence, apply, selection } = useEditor();
  const playing = usePlayerPlaying();
  const duration = player.duration;
  const frame = 1 / (sequence.fps || 30);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);

  // 時刻の表示は毎フレーム更新が要るが、React を通すと再描画のたびに
  // ツリー全体を作り直すことになるので、DOM を直接書き換える。
  useEffect(
    () =>
      player.subscribeFrame((t) => {
        if (timeRef.current) timeRef.current.textContent = formatTime(t, true, sequence.fps);
        const scrub = scrubRef.current;
        // つまみを掴んでいる間は上書きしない。
        if (scrub && document.activeElement !== scrub) {
          scrub.max = String(Math.max(0.01, player.duration));
          scrub.value = String(Math.min(t, player.duration));
        }
      }),
    [sequence.fps],
  );

  const boundaries = useMemo(() => {
    const points = new Set<number>([0]);
    for (const track of sequence.tracks) {
      for (const clip of clipsOnTrack(sequence, track.id)) {
        points.add(clip.start);
        points.add(clipEnd(clip));
      }
    }
    return [...points].sort((a, b) => a - b);
  }, [sequence]);

  const jump = (direction: -1 | 1) => {
    const now = player.time;
    if (direction < 0) {
      const previous = [...boundaries].reverse().find((b) => b < now - 0.05);
      player.seek(previous ?? 0);
    } else {
      const next = boundaries.find((b) => b > now + 0.05);
      player.seek(next ?? duration);
    }
  };

  return (
    <div className="transport">
      <div className="transport-scrub">
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={Math.max(0.01, duration)}
          step={0.01}
          defaultValue={0}
          onChange={(e) => player.seek(Number(e.target.value))}
          aria-label="再生位置"
        />
      </div>
      <div className="transport-row">
        <span className="timecode">
          <span ref={timeRef}>{formatTime(player.time, true, sequence.fps)}</span> <em>/ {formatTime(duration)}</em>
        </span>
        <div className="transport-buttons">
          <button type="button" title="前の継ぎ目へ" onClick={() => jump(-1)}>
            ⏮
          </button>
          <button type="button" title="1 フレーム戻る" onClick={() => player.nudge(-frame)}>
            ◀
          </button>
          <button type="button" className="primary" title="再生 / 一時停止" onClick={() => player.toggle()}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" title="1 フレーム進む" onClick={() => player.nudge(frame)}>
            ▶
          </button>
          <button type="button" title="次の継ぎ目へ" onClick={() => jump(1)}>
            ⏭
          </button>
        </div>
        <div className="transport-tools">
          <button type="button" title="再生ヘッドで分割" onClick={() => apply((seq) => splitAt(seq, player.time, selection))}>
            ✂ 分割
          </button>
          <button type="button" className={guides ? 'active' : ''} title="SNS の UI に隠れる範囲" onClick={onToggleGuides}>
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

export type { Clip };
