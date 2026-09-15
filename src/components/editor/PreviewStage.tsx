import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { exporter } from '../../engine/exporter';
import { formatTime } from '../../engine/media';
import { player } from '../../engine/player';
import {
  CROP_CORNERS,
  CROP_HANDLES,
  drawCropRect,
  ensureMinimum,
  largestRectForRatio,
  moveCropRect,
  resizeCropRect,
  selectionFromRect,
  selectionRect,
  snapCropRect,
  type CropHandle,
} from '../../engine/crop';
import { cropDestForSelection, cropDestFromRect, cropDestRect, renderFrame, type Rect } from '../../engine/renderer';
import { clipAtTime, clipsOnTrack, splitAt } from '../../model/ops';
import { clipEnd, type Clip, type Sequence } from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { Icon } from '../Icon';

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

/**
 * 範囲指定モードの操作。すべて画面上の矩形（シーケンス座標）で計算する。
 * origin は掴んだ瞬間の枠、anchor は引き始めた点。
 */
type CropDrag =
  | { mode: 'draw'; anchor: { x: number; y: number }; started: boolean }
  | { mode: 'move'; grabX: number; grabY: number; origin: Rect }
  | { mode: 'resize'; handle: CropHandle; origin: Rect };

type Drag =
  | { kind: 'none' }
  | { kind: 'move'; id: string; startX: number; startY: number; originX: number; originY: number }
  /** 完了後の「切り抜きを置く枠」。動かすのと、四隅で大きさを変えるのと。 */
  | { kind: 'cropDest'; id: string; handle: CropHandle | null; startX: number; startY: number; origin: Rect }
  | { kind: 'cropSelect'; id: string; source: Rect; drag: CropDrag };

/** 端や中心へ吸着させる距離（画角の幅に対する割合）。 */
const SNAP_RATIO = 0.012;



export function PreviewStage() {
  const { sequence, selection, setSelection, apply, cropTarget, setCropTarget, cropRatio, setCropRatio } = useEditor();
  const { settings } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boundsRef = useRef<Map<string, Rect>>(new Map());
  const dragRef = useRef<Drag>({ kind: 'none' });
  const [guides, setGuides] = useState(true);

  // 描画ループから最新値を読むための箱（RAF ごとに購読し直したくない）
  const latest = useRef({ sequence, selection, guides, cropTarget });
  latest.current = { sequence, selection, guides, cropTarget };

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
      const { sequence: seq, selection: sel, guides: g, cropTarget: crop } = latest.current;
      // 書き出し中はプレビューを描かない。モーダルの裏に隠れて見えないうえ、
      // 描画に処理時間を取られると書き出しそのものが遅く・不安定になる。
      if (exporter.active) {
        // 実時間収録で書き出す場合のみ、収録用キャンバスへ描く。
        if (exporter.ctx && exporter.sequence) {
          renderFrame(exporter.ctx, exporter.sequence, time, sources, { guides: false, selectedIds: [] });
        }
      } else if (ctx) {
        boundsRef.current = renderFrame(ctx, seq, time, sources, { guides: g, selectedIds: sel, cropTarget: crop });
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

  /** 範囲指定モード中の 1 本道。ここでは切り抜き範囲だけを触る。 */
  const beginCropSelect = (event: React.PointerEvent<HTMLCanvasElement>, point: { x: number; y: number }): boolean => {
    if (!cropTarget) return false;
    const clip = sequence.clips.find((c) => c.id === cropTarget);
    const source = boundsRef.current.get(`cropsrc:${cropTarget}`);
    if (!clip || !source || source.w <= 0 || source.h <= 0) return false;
    const rect = selectionRect(source, clip.crop);

    let drag: CropDrag | null = null;
    for (const handle of CROP_HANDLES) {
      if (hit(boundsRef.current.get(`crophandle:${cropTarget}:${handle}`), point)) {
        drag = { mode: 'resize', handle, origin: rect };
        break;
      }
    }
    // 全体が選ばれている間は「動かす」余地が無いので、内側を押しても引き直しにする。
    const wholeFrame = clip.crop.sw >= 0.995 && clip.crop.sh >= 0.995;
    if (!drag && !wholeFrame && hit(boundsRef.current.get(`cropsel:${cropTarget}`), point)) {
      drag = { mode: 'move', grabX: point.x, grabY: point.y, origin: rect };
    }
    // 枠の外を押したら、そこを起点に新しい範囲を引き直す。
    // ただし書き換えるのは実際に引き始めてから。ただ触れただけで
    // それまで選んでいた範囲が消えると、取り返しがつかない。
    if (!drag) drag = { mode: 'draw', anchor: point, started: false };

    dragRef.current = { kind: 'cropSelect', id: cropTarget, source, drag };
    event.currentTarget.setPointerCapture(event.pointerId);
    return true;
  };

  /** 引き始めたと認めるまでの距離（これ未満は「押しただけ」とみなす）。 */
  const DRAW_THRESHOLD = sequence.width / 90;

  /** 画面上の矩形をそのまま「切り抜く範囲」として書き込む。 */
  const setSelectionRect = (id: string, source: Rect, rect: Rect) => {
    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) =>
          c.id === id
            ? { ...c, crop: cropDestForSelection(seq, c, source, { ...c.crop, ...selectionFromRect(source, rect) }) }
            : c,
        ),
      }),
      `cropSelect:${id}`,
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toSequenceCoords(event);
    const time = player.time;

    if (beginCropSelect(event, point)) return;

    // 選択中クリップのクロップ枠を最優先で掴む（つまみ → 枠の中、の順）
    for (const id of selection) {
      const clip = sequence.clips.find((c) => c.id === id);
      if (!clip?.crop.enabled) continue;
      const origin = cropDestRect(sequence, clip);
      const handle = CROP_CORNERS.find((h) => hit(boundsRef.current.get(`crophandle:${id}:${h}`), point));
      if (handle || hit(boundsRef.current.get(`crop:${id}`), point)) {
        dragRef.current = { kind: 'cropDest', id, handle: handle ?? null, startX: point.x, startY: point.y, origin };
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

    if (drag.kind === 'cropSelect') {
      const { source, drag: d } = drag;
      const snap = sequence.width * SNAP_RATIO;
      let rect: Rect;
      if (d.mode === 'draw') {
        if (!d.started) {
          if (Math.hypot(point.x - d.anchor.x, point.y - d.anchor.y) < DRAW_THRESHOLD) return;
          d.started = true;
        }
        rect = drawCropRect(d.anchor, point, source, cropRatio);
      }
      else if (d.mode === 'move') rect = moveCropRect(d.origin, point.x - d.grabX, point.y - d.grabY, source);
      else rect = resizeCropRect(d.origin, d.handle, point, source, cropRatio);
      // 比率を固定しているあいだは、吸着させると形が崩れるので大きさを変える操作では吸わせない。
      if (cropRatio === null || d.mode === 'move') rect = snapCropRect(rect, source, snap);
      setSelectionRect(drag.id, source, rect);
      return;
    }

    if (drag.kind === 'cropDest') {
      // 切り抜いた絵は伸ばしたくないので、四隅は元の縦横比を保ったまま動かす。
      const ratio = drag.origin.h > 0 ? drag.origin.w / drag.origin.h : null;
      const frame = { x: 0, y: 0, w: sequence.width, h: sequence.height };
      const rect = drag.handle
        ? resizeCropRect(drag.origin, drag.handle, point, frame, ratio)
        : {
            ...drag.origin,
            x: drag.origin.x + (point.x - drag.startX),
            y: drag.origin.y + (point.y - drag.startY),
          };
      const snapped = snapCropRect(rect, frame, sequence.width * SNAP_RATIO);
      // 吸着で比率が崩れないよう、大きさは動かさず位置だけを採る。
      const placed = drag.handle ? rect : { ...rect, x: snapped.x, y: snapped.y };
      apply(
        (seq) => ({
          ...seq,
          clips: seq.clips.map((c) => (c.id === drag.id ? { ...c, crop: cropDestFromRect(seq, c, placed, c.crop) } : c)),
        }),
        `cropDest:${drag.id}`,
      );
      return;
    }

    const dx = (point.x - drag.startX) / sequence.width;
    const dy = (point.y - drag.startY) / sequence.height;

    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => (c.id === drag.id ? { ...c, x: drag.originX + dx, y: drag.originY + dy } : c)),
      }),
      `${drag.kind}:${drag.id}`,
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.kind !== 'none' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 指を離した時点で潰れていたら、選び直しやすい大きさへ戻す。
    if (drag.kind === 'cropSelect' && !(drag.drag.mode === 'draw' && !drag.drag.started)) {
      const clip = sequence.clips.find((c) => c.id === drag.id);
      if (clip) {
        const rect = ensureMinimum(selectionRect(drag.source, clip.crop), drag.source, cropRatio);
        setSelectionRect(drag.id, drag.source, rect);
      }
    }
    dragRef.current = { kind: 'none' };
  };

  // 範囲指定中は Esc / Enter で抜けられるようにする。
  useEffect(() => {
    if (!cropTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      setCropTarget(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cropTarget, setCropTarget]);

  /** 選んだ範囲を画角いっぱいに広げる（切り抜いて寄る、いわゆるクロップズーム）。 */
  const fillFrame = () => {
    if (!cropTarget) return;
    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => {
          if (c.id !== cropTarget) return c;
          const rect = cropDestRect(seq, c);
          if (rect.w <= 0 || rect.h <= 0) return c;
          // 縦横比は保ったまま、画角を覆う倍率まで拡大して中央へ。
          const zoom = Math.max(seq.width / rect.w, seq.height / rect.h);
          const w = rect.w * zoom;
          const h = rect.h * zoom;
          const placed = { x: (seq.width - w) / 2, y: (seq.height - h) / 2, w, h };
          return { ...c, crop: cropDestFromRect(seq, c, placed, c.crop) };
        }),
      }),
      `cropFill:${cropTarget}`,
    );
  };

  const resetCrop = () => {
    if (!cropTarget) return;
    const source = boundsRef.current.get(`cropsrc:${cropTarget}`);
    if (!source) return;
    setCropRatio(null);
    setSelectionRect(cropTarget, source, source);
  };

  /** 比率を選び直したら、いまの枠に収まる最大の大きさで作り直して見せる。 */
  const chooseRatio = (ratio: number | null) => {
    setCropRatio(ratio);
    const source = cropTarget ? boundsRef.current.get(`cropsrc:${cropTarget}`) : null;
    const clip = cropTarget ? sequence.clips.find((c) => c.id === cropTarget) : null;
    if (!source || !clip || ratio === null) return;
    const current = selectionRect(source, clip.crop);
    const centered = largestRectForRatio(source, ratio);
    // いまの枠と同じくらいの大きさを保ちたいので、面積は current 寄りにする。
    const scale = Math.min(1, Math.max(current.w / centered.w, current.h / centered.h));
    const w = centered.w * scale;
    const h = centered.h * scale;
    const cx = current.x + current.w / 2;
    const cy = current.y + current.h / 2;
    const rect = moveCropRect({ x: cx - w / 2, y: cy - h / 2, w, h }, 0, 0, source);
    setSelectionRect(clip.id, source, rect);
  };

  const sameRatio = (a: number | null, b: number | null) =>
    a === null || b === null ? a === b : Math.abs(a - b) < 0.001;

  // 画角がプリセットと同じ比率のときは 1 つにまとめる（同じものが 2 つ光ると迷う）。
  const ratioOptions = [
    { label: 'フリー', value: null },
    { label: '画角', value: sequence.width / sequence.height },
    { label: '1:1', value: 1 },
    { label: '4:5', value: 4 / 5 },
    { label: '9:16', value: 9 / 16 },
    { label: '16:9', value: 16 / 9 },
  ].filter((option, i, all) => all.findIndex((o) => sameRatio(o.value, option.value)) === i);

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
      <div className={`preview-stage${cropTarget ? ' cropping' : ''}`}>
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
      {cropTarget && (
        <div className="crop-hud">
          <div className="crop-hud-row">
            <span className="crop-hud-label">比率</span>
            <div className="crop-hud-ratios">
              {ratioOptions.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={sameRatio(cropRatio, option.value) ? 'chip active' : 'chip'}
                  onClick={() => chooseRatio(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="crop-hud-row">
            <span>
              なぞって範囲を決めます。つまみで大きさ、内側をドラッグで位置。端と中心には吸い付きます（Enter で完了）。
            </span>
            <div className="crop-hud-actions">
              <button type="button" onClick={fillFrame}>
                画角いっぱいに
              </button>
              <button type="button" onClick={resetCrop}>
                全体に戻す
              </button>
              <button type="button" className="primary" onClick={() => setCropTarget(null)}>
                完了
              </button>
            </div>
          </div>
        </div>
      )}
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
            <Icon name="skip-back" label="前の継ぎ目へ" />
          </button>
          <button type="button" title="1 フレーム戻る" onClick={() => player.nudge(-frame)}>
            <Icon name="step-back" label="1 フレーム戻る" />
          </button>
          <button type="button" className="primary" title="再生 / 一時停止" onClick={() => player.toggle()}>
            <Icon name={playing ? 'pause' : 'play'} size={20} label="再生 / 一時停止" />
          </button>
          <button type="button" title="1 フレーム進む" onClick={() => player.nudge(frame)}>
            <Icon name="step-forward" label="1 フレーム進む" />
          </button>
          <button type="button" title="次の継ぎ目へ" onClick={() => jump(1)}>
            <Icon name="skip-forward" label="次の継ぎ目へ" />
          </button>
        </div>
        <div className="transport-tools">
          <button type="button" title="再生ヘッドで分割" onClick={() => apply((seq) => splitAt(seq, player.time, selection))}>
            <Icon name="scissors" />分割
          </button>
          <button type="button" className={guides ? 'active' : ''} title="SNS の UI に隠れる範囲" onClick={onToggleGuides}>
            <Icon name="grid" />ガイド
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
      <Icon name="loop" />ループ
    </button>
  );
}

export type { Clip };
