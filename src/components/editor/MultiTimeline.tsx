import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { formatTime, assetHasSound, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import { sourceLengthOf } from '../../engine/sourceLength';
import { EDIT_MODES, dragByMode, trimByMode, type EditMode } from '../../model/editModes';
import { placeWithSound } from '../../model/links';
import {
  adoptSourceFps,
  clipsOnTrack,
  moveClips,
  previousAdjacent,
  sequenceDuration,
  snapCandidates,
  snapTime,
} from '../../model/ops';
import { clipFromAsset, uid } from '../../model/factory';
import { nestClips, unnestClips } from '../../model/nest';
import { clipEnd, previewText, type Clip, type Sequence, type Track } from '../../model/types';
import { shortcutLabel, useApp, useShortcutHint } from '../../store/app';
import { useEditor } from '../../store/editor';
import { EyeIcon, EyeOffIcon, MuteIcon, SoundIcon } from '../ui';
import { Icon } from '../Icon';
import { TRANSITION_ICON } from './transitionIcon';
import { hasClipboard, useTimelineActions } from './timelineActions';
import { ContextMenu, type MenuItem } from '../ContextMenu';
import { Dual, Hint } from '../Hint';
import type { ComponentProps } from 'react';
import { TimelineDemo } from '../demos';

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
/** 編集モードごとのショートカット。 */
const MODE_SHORTCUT = {
  normal: 'modeNormal',
  ripple: 'modeRipple',
  roll: 'modeRoll',
  slip: 'modeSlip',
  slide: 'modeSlide',
} as const;

/**
 * タイムラインの道具の名前。
 * 「かんたん」では、何が起きるかで言った名前に元の専門用語を添える。
 * 「くわしく」では、専門用語だけ（Premiere などと同じ呼び名で、列も短く収まる）。
 */
const EasyNames = createContext(false);

function Name({ plain, alias }: { plain: string; alias?: string }) {
  const easy = useContext(EasyNames);
  return easy || !alias ? <Dual plain={plain} alias={alias} /> : <>{alias}</>;
}

/** 説明カード。「くわしく」では見出しを専門用語にし、やさしい言い方を横に添える（ボタンの名前と揃える）。 */
function TlHint({ title, alias, ...rest }: ComponentProps<typeof Hint>) {
  const easy = useContext(EasyNames);
  return easy || !alias ? <Hint title={title} alias={alias} {...rest} /> : <Hint title={alias} alias={title} {...rest} />;
}

/** 指で長押ししてメニューを出すまでの時間と、その間に許す指のぶれ。 */
const LONG_PRESS_MS = 520;
const TOUCH_SLOP_PX = 7;

/** 指で触る端末か（iPad をパソコン表示で使っているときも含む）。 */
function hasCoarsePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(any-pointer: coarse)').matches;
}

/** compact はスマホ表示用に一回り小さくしたレーンの高さ。 */
export function laneHeight(track: Track, compact = false, scale = 1): number {
  const base = compact
    ? track.kind === 'video' ? 44 : track.kind === 'audio' ? 30 : 26
    : track.kind === 'video' ? 56 : track.kind === 'audio' ? 40 : 34;
  return Math.max(16, Math.round(base * scale));
}

/**
 * レーンの高さの倍率（縦の拡大縮小）。トラックが多いと、既定の高さでは 3 本ほどしか見えないので、
 * 縮めて一度に多く見られるようにする。設定（timelineRowScale）に覚える。
 */
export const ROW_SCALES = [0.4, 0.55, 0.7, 0.85, 1, 1.25, 1.5, 2];
/** 既定の倍率。いちばん低い段から 2 段上（使う人の希望。トラックが多くても一度に見えるように）。 */
export const DEFAULT_ROW_SCALE = ROW_SCALES[2];
const RowScaleContext = createContext(DEFAULT_ROW_SCALE);

/** 倍率の段を 1 つ上げ下げする。 */
export function stepRowScale(current: number, direction: 1 | -1): number {
  const index = ROW_SCALES.reduce((best, v, i) => (Math.abs(v - current) < Math.abs(ROW_SCALES[best] - current) ? i : best), 0);
  return ROW_SCALES[Math.min(ROW_SCALES.length - 1, Math.max(0, index + direction))];
}

/** Premiere と同じく、上からテロップ → V2 → V1 → A1 の順に並べる。 */
export function displayTracks(sequence: Sequence): Track[] {
  const byKind = (kind: Track['kind']) => sequence.tracks.filter((t) => t.kind === kind);
  return [...byKind('text').reverse(), ...byKind('video').reverse(), ...byKind('audio')];
}

/**
 * 新しく現れたクリップ（分割で生まれた側・置いたばかりのもの）を覚えておき、
 * 出てきた瞬間だけ軽く弾ませる。開いた時点で既にあったクリップは動かさない。
 * タイムラインはスマホのシート切り替えで作り直されるので、部品の外に持つ。
 */
const FRESH_MS = 450;
const bornAt = new Map<string, number>();
let knownClipIds: Set<string> | null = null;

function noteClips(clips: Clip[]) {
  if (!knownClipIds) {
    knownClipIds = new Set(clips.map((clip) => clip.id));
    return;
  }
  const now = performance.now();
  for (const clip of clips) {
    if (knownClipIds.has(clip.id)) continue;
    knownClipIds.add(clip.id);
    bornAt.set(clip.id, now);
  }
}

function isFresh(id: string): boolean {
  const born = bornAt.get(id);
  return born !== undefined && performance.now() - born < FRESH_MS;
}

function beginDrag(
  event: React.PointerEvent,
  onMove: (dx: number, dy: number, native: PointerEvent) => void,
  onEnd?: () => void,
) {
  event.preventDefault();
  event.stopPropagation();
  // preventDefault はフォーカスの移動も止めてしまう。直前に素材パネルなどにあったフォーカスが残ると、
  // タイムラインを触ったあとの Delete / Ctrl+A がそちらへ飛ぶ（素材の削除確認が出てしまう）。外しておく。
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
  const startX = event.clientX;
  const startY = event.clientY;
  // ドラッグ中はクリップの位置の動き（詰める時のアニメーション）を止める。指から遅れて付いてくると掴みにくい。
  document.documentElement.classList.add('tl-dragging');
  const move = (e: PointerEvent) => onMove(e.clientX - startX, e.clientY - startY, e);
  const up = () => {
    document.documentElement.classList.remove('tl-dragging');
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
  const { sequence, rootSequence, nestPath, enterNest, exitNest, apply, selection, setSelection, editMode, setEditMode, insertMode, setInsertMode, markIn, markOut } = useEditor();
  const { settings, updateSettings } = useApp();
  const rowScale = settings.timelineRowScale ?? DEFAULT_ROW_SCALE;
  noteClips(sequence.clips);
  const easy = settings.uiMode === 'easy';
  const actions = useTimelineActions();
  const key = (action: Parameters<typeof hint>[0]) => shortcutLabel(settings.shortcuts[action]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  /** いま見えている横の範囲（px）。ルーラーの目盛りを見える分だけ描くのに使う。 */
  const [view, setView] = useState({ left: 0, width: 1600 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 右クリック（長押し）のメニュー。clipId が null なら空いた所。 */
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string | null } | null>(null);
  const closeMenu = useRef(() => setMenu(null)).current;
  /** タップで選び足す（Shift を押せない指のための切り替え）。 */
  const [multi, setMulti] = useState(false);
  const [touch] = useState(hasCoarsePointer);
  const hint = useShortcutHint();

  // ---- 拡大縮小の中心 ----
  // ホイール・ピンチはカーソルの下を、ボタン・キーは再生ヘッド（見えていなければ画面の中央）を動かさずに拡大縮小する。
  const zoomAnchor = useRef<{ time: number; x: number } | null>(null);
  const ppsNow = useRef(pps);
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const from = ppsNow.current;
    ppsNow.current = pps;
    if (!box || from === pps) return;
    let anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!anchor) {
      const headX = player.time * from - box.scrollLeft;
      anchor =
        headX >= 0 && headX <= box.clientWidth
          ? { time: player.time, x: headX }
          : { time: (box.scrollLeft + box.clientWidth / 2) / from, x: box.clientWidth / 2 };
    }
    box.scrollLeft = Math.max(0, anchor.time * pps - anchor.x);
  }, [pps]);

  // Ctrl/⌘+ホイール（トラックパッドのピンチも同じ形で届く）と、Safari のピンチ。
  // preventDefault が要るので、React の onWheel（passive）ではなく直接聞く。
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const clampPps = (value: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, value));
    const anchorAt = (clientX: number) => {
      const x = clientX - box.getBoundingClientRect().left;
      zoomAnchor.current = { time: (box.scrollLeft + x) / ppsNow.current, x };
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const raw = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const delta = Math.max(-120, Math.min(120, raw));
      if (delta === 0) return;
      anchorAt(event.clientX);
      setPps((p) => clampPps(p * Math.exp(-delta * 0.0025)));
    };
    let pinchFrom = 0;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      pinchFrom = ppsNow.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number };
      if (!pinchFrom || !gesture.scale) return;
      anchorAt(gesture.clientX ?? box.getBoundingClientRect().left + box.clientWidth / 2);
      setPps(clampPps(pinchFrom * gesture.scale));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('gesturestart', onGestureStart);
    box.addEventListener('gesturechange', onGestureChange);
    return () => {
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('gesturestart', onGestureStart);
      box.removeEventListener('gesturechange', onGestureChange);
    };
  }, [setPps]);

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
  // 拡大縮小のあいだは、クリップの「滑る」動き（詰める・ずらすときの演出）を止める。
  // 全クリップの位置と幅が一度に変わるので、動かすと数百個を毎コマ並べ直すことになり、固まる。
  // 描く直前（useLayoutEffect）に印を付け、2 コマ後に外す。編集で詰めたときの動きはそのまま。
  const lastPps = useRef(pps);
  useLayoutEffect(() => {
    if (lastPps.current === pps) return;
    lastPps.current = pps;
    const root = document.documentElement;
    root.classList.add('tl-zooming');
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => root.classList.remove('tl-zooming'));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      root.classList.remove('tl-zooming');
    };
  }, [pps]);

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
    if (!event.shiftKey && !multi) setSelection([]);

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
          const height = laneHeight(track, compact, rowScale) + 4;
          const overlapsRow = top < box.y + box.h && top + height > box.y;
          if (overlapsRow) {
            for (const clip of clipsOnTrack(sequence, track.id)) {
              if (clip.start < to && clipEnd(clip) > from) hits.push(clip.id);
            }
          }
          top += height;
        }
        setSelection(event.shiftKey || multi ? [...new Set([...selection, ...hits])] : hits);
      },
    );
  };

  const menuItems = (): MenuItem[] => {
    const paste: MenuItem = { label: '再生位置に貼り付け', hint: key('paste'), onSelect: actions.paste, disabled: !hasClipboard() };
    if (!menu?.clipId) {
      return [paste, { label: 'すべて選ぶ', hint: key('selectAll'), onSelect: actions.selectAll, disabled: sequence.clips.length === 0 }];
    }
    const clip = sequence.clips.find((c) => c.id === menu.clipId);
    const none = selection.length === 0;
    const items: MenuItem[] = [
      { label: '再生位置で分割', hint: key('split'), onSelect: actions.split, disabled: none },
      { label: '複製', hint: key('duplicate'), onSelect: actions.duplicate, disabled: none },
      'separator',
      { label: 'コピー', hint: key('copy'), onSelect: actions.copy, disabled: none },
      { label: '切り取り', hint: key('cut'), onSelect: actions.cut, disabled: none },
      paste,
    ];
    // まとめる・解く。選んだ中にまとめたクリップがあれば、全部まとめて解ける。
    const nests = selection.filter((id) => sequence.clips.find((c) => c.id === id)?.kind === 'nest');
    if (clip?.kind === 'nest' && !nests.includes(clip.id)) nests.push(clip.id);
    if (clip?.kind === 'nest' || nests.length > 0 || selection.length >= 2) items.push('separator');
    if (clip?.kind === 'nest') items.push({ label: '中身を編集する', onSelect: () => enterNest(clip.id) });
    if (nests.length > 0) {
      items.push({
        label: nests.length > 1 ? `まとめを解く（${nests.length} 本）` : 'まとめを解く',
        onSelect: () => {
          const before = new Set(sequence.clips.map((c) => c.id));
          const after = unnestClips(sequence, nests);
          apply((seq) => unnestClips(seq, nests));
          setSelection(after.clips.filter((c) => !before.has(c.id)).map((c) => c.id));
        },
      });
    }
    if (selection.length >= 2) {
      items.push({
        label: `1 つにまとめる（${selection.length} 本）`,
        onSelect: () => {
          const id = uid('cl');
          const picked = [...selection];
          apply((seq) => nestClips(seq, picked, 'まとめたクリップ', id).sequence);
          setSelection([id]);
        },
      });
    }
    items.push('separator', { label: '削除', hint: key('delete'), onSelect: actions.remove, disabled: none, danger: true });
    if (!easy) items.push({ label: 'リップル削除', hint: key('rippleDelete'), onSelect: actions.rippleRemove, disabled: none, danger: true });
    return items;
  };

  return (
    <div
      className={`tl${compact ? ' compact' : ''}${rowScale < 0.8 ? ' dense' : ''} mode-${editMode}${nestPath.length > 0 ? ' in-nest' : ''}`}
    >
      {nestPath.length > 0 && (
        <div className="tl-nest-bar">
          <button type="button" className="primary" onClick={() => exitNest()}>
            <Icon name="chevron-left" /> 外へ戻る
          </button>
          <span className="tl-nest-path">
            シーケンス
            {nestNames(rootSequence, nestPath).map((name, i) => (
              <span key={i}> › {name}</span>
            ))}
          </span>
          <span className="muted small">まとめたクリップの中を編集しています。プレビューは中身だけを映します。</span>
        </div>
      )}
      <EasyNames.Provider value={easy}>
      <div className="tl-toolbar">
        <TlHint
          title="削除"
          keys={key('delete')}
          desc={easy ? '選んだクリップを消して、後ろのクリップを前へ詰めます。' : '選んだクリップを消します。空いた所はそのまま残ります。'}
          demo={() => <TimelineDemo kind={easy ? 'rippleDelete' : 'delete'} />}
        >
          <button type="button" onClick={actions.remove} disabled={!selection.length}>
            削除
          </button>
        </TlHint>
        <TlHint
          title="複製"
          keys={key('duplicate')}
          desc="選んだクリップを、すぐ後ろへもう 1 本置きます。後ろのクリップは送るので、何も上書きしません。"
          demo={() => <TimelineDemo kind="duplicate" />}
        >
          <button type="button" onClick={actions.duplicate} disabled={!selection.length}>
            複製
          </button>
        </TlHint>
        {(touch || compact) && (
          <button
            type="button"
            className={multi ? 'active' : ''}
            aria-pressed={multi}
            onClick={() => setMulti((on) => !on)}
            title="オンの間、タップしたクリップを選び足します（もう一度タップで外す）"
          >
            複数選択
          </button>
        )}
        {!easy && (
          <TlHint
            title="詰めて削除"
            alias="リップル削除"
            keys={key('rippleDelete')}
            desc="選んだクリップを消して、後ろのクリップを前へ詰めます。隙間が残りません。"
            demo={() => <TimelineDemo kind="rippleDelete" />}
          >
            <button type="button" onClick={actions.rippleRemove} disabled={!selection.length}>
              <Icon name="ripple-delete" />
              <Name plain="詰めて削除" alias="リップル削除" />
            </button>
          </TlHint>
        )}
        <span className="tl-count">{selection.length > 0 ? `${selection.length} 個選択中` : ''}</span>
        <span className="spacer" />
            <TlHint
              title="ぴったり合わせる"
              alias="スナップ"
              desc="オンの間、動かしたクリップが、他のクリップの端や再生位置に吸い付きます。細かくずらしたいときはオフに。"
              demo={() => <TimelineDemo kind="snap" />}
            >
              <button type="button" className={settings.snap ? 'active' : ''} aria-pressed={settings.snap} onClick={() => updateSettings({ snap: !settings.snap })}>
                <Icon name="magnet" />
                <Name plain="ぴったり合わせる" alias="スナップ" />
              </button>
            </TlHint>
            <TlHint
              title="再生に合わせて送る"
              alias="追従"
              desc="オンの間、再生位置が画面の端まで来ると、タイムラインが自動で先へ送られます（再生中だけ）。"
              demo={() => <TimelineDemo kind="follow" />}
            >
              <button type="button" className={follow ? 'active' : ''} aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
                <Icon name="link" />
                <Name plain="再生に合わせて送る" alias="追従" />
              </button>
            </TlHint>
        <div className="zoom" role="group" aria-label="横（時間）の拡大縮小">
          <span className="zoom-label" aria-hidden="true">横</span>
          <button type="button" onClick={() => setPps((p) => Math.max(MIN_PPS, p / 1.4))} title={`横を縮小（長い時間を見る）${hint('zoomOut')}・Ctrl/⌘+ホイールでも`}>
            <Icon name="minus" size={15} label="横を縮小" />
          </button>
          <button type="button" onClick={() => setPps((p) => Math.min(MAX_PPS, p * 1.4))} title={`横を拡大（細かく見る）${hint('zoomIn')}・Ctrl/⌘+ホイールでも`}>
            <Icon name="plus" size={15} label="横を拡大" />
          </button>
        </div>
        <div className="zoom" role="group" aria-label="縦（トラックの高さ）の拡大縮小">
          <span className="zoom-label" aria-hidden="true">縦</span>
          <button
            type="button"
            disabled={rowScale <= ROW_SCALES[0]}
            onClick={() => updateSettings({ timelineRowScale: stepRowScale(rowScale, -1) })}
            title="縦を縮小（トラックを低くして、たくさん見る）"
          >
            <Icon name="minus" size={15} label="縦を縮小" />
          </button>
          <button
            type="button"
            disabled={rowScale >= ROW_SCALES[ROW_SCALES.length - 1]}
            onClick={() => updateSettings({ timelineRowScale: stepRowScale(rowScale, 1) })}
            title="縦を拡大（トラックを高くする）"
          >
            <Icon name="plus" size={15} label="縦を拡大" />
          </button>
        </div>
      </div>

      <div className="tl-tools" role="toolbar" aria-label="編集ツール">
        <div className="tl-modes" role="radiogroup" aria-label="編集モード（ドラッグしたときの動き方）">
          {EDIT_MODES.map((m) => (
            <TlHint
              key={m.key}
              title={m.plain}
              alias={m.plain === m.label ? undefined : m.label}
              keys={key(MODE_SHORTCUT[m.key])}
              desc={m.hint}
              demo={() => <TimelineDemo kind={m.key} />}
            >
              <button
                type="button"
                role="radio"
                aria-checked={editMode === m.key}
                className={editMode === m.key ? 'active' : ''}
                onClick={() => setEditMode(m.key)}
              >
                <Name plain={m.plain} alias={m.plain === m.label ? undefined : m.label} />
              </button>
            </TlHint>
          ))}
        </div>
        <TlHint
          title="割り込ませて置く"
          alias="挿入配置"
          keys={key('toggleInsert')}
          desc="オンの間、素材を置いたり貼り付けたりすると、そこにあるクリップを上書きせず、後ろへ送って割り込ませます。"
          demo={() => <TimelineDemo kind="insert" />}
        >
          <button type="button" className={insertMode ? 'active' : ''} aria-pressed={insertMode} onClick={() => setInsertMode(!insertMode)}>
            <Name plain="割り込ませて置く" alias="挿入配置" />
          </button>
        </TlHint>
        <span className="tl-sep" />
        <TlHint
          title="範囲の始め"
          alias="In"
          keys={key('markIn')}
          desc="いまの再生位置を、範囲の始めにします。「範囲の終わり」と組みにして、その間をまとめて消せます。"
          demo={() => <TimelineDemo kind="range" />}
        >
          <button type="button" onClick={actions.markIn}>
            <Name plain="範囲の始め" alias="In" />
          </button>
        </TlHint>
        <TlHint
          title="範囲の終わり"
          alias="Out"
          keys={key('markOut')}
          desc="いまの再生位置を、範囲の終わりにします。"
          demo={() => <TimelineDemo kind="range" />}
        >
          <button type="button" onClick={actions.markOut}>
            <Name plain="範囲の終わり" alias="Out" />
          </button>
        </TlHint>
        <TlHint
          title="範囲を消す"
          alias="リフト"
          keys={key('lift')}
          desc="決めた範囲の中身を消します。空いた所はそのまま残り、後ろのクリップは動きません。"
          demo={() => <TimelineDemo kind="lift" />}
        >
          <button type="button" onClick={actions.lift} disabled={!actions.hasRange}>
            <Name plain="範囲を消す" alias="リフト" />
          </button>
        </TlHint>
        <TlHint
          title="範囲を消して詰める"
          alias="抽出"
          keys={key('extract')}
          desc="決めた範囲の中身を消して、後ろのクリップを前へ詰めます。"
          demo={() => <TimelineDemo kind="extract" />}
        >
          <button type="button" onClick={actions.extract} disabled={!actions.hasRange}>
            <Name plain="範囲を消して詰める" alias="抽出" />
          </button>
        </TlHint>
        <button
          type="button"
          onClick={actions.clearMarks}
          disabled={markIn === null && markOut === null}
          title={`範囲を取り消す${hint('clearMarks')}`}
        >
          <Icon name="xmark" size={13} label="範囲を取り消す" />
        </button>
        <span className="tl-sep" />
        <TlHint
          title="隙間を詰める"
          keys={key('closeGap')}
          desc="再生位置にある隙間を、後ろのクリップを前へ寄せて埋めます。"
          demo={() => <TimelineDemo kind="closeGap" />}
        >
          <button type="button" onClick={actions.closeGap}>
            隙間を詰める
          </button>
        </TlHint>
        <TlHint
          title="全部の段を分割"
          alias="全トラック分割"
          keys={key('addEditAll')}
          desc="再生位置で、映像・テロップ・音のすべての段をまとめて切ります。"
          demo={() => <TimelineDemo kind="splitAll" />}
        >
          <button type="button" onClick={actions.addEditAll}>
            <Name plain="全部の段を分割" alias="全トラック分割" />
          </button>
        </TlHint>
        <button type="button" onClick={actions.prevEdit} title={`前の切れ目へ${hint('prevEdit')}`}>
          <Icon name="step-back" size={14} label="前の切れ目へ" />
        </button>
        <button type="button" onClick={actions.nextEdit} title={`次の切れ目へ${hint('nextEdit')}`}>
          <Icon name="step-forward" size={14} label="次の切れ目へ" />
        </button>
      </div>

      </EasyNames.Provider>
      <RowScaleContext.Provider value={rowScale}>
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
            <div
              className="tl-lanes"
              ref={lanesRef}
              onPointerDown={(e) => e.button === 0 && e.target === e.currentTarget && startMarquee(e)}
              onContextMenu={(e) => {
                // 空いた所の右クリック。押した所へ再生位置を移してから、貼り付けなどを出す。
                e.preventDefault();
                scrub(e.clientX);
                setMenu({ x: e.clientX, y: e.clientY, clipId: null });
              }}
            >
              {tracks.map((track) => (
                <Lane
                  key={track.id}
                  track={track}
                  pps={pps}
                  compact={compact}
                  onEmptyPointerDown={startMarquee}
                  onPickTransition={onPickTransition}
                  multi={multi}
                  onMenu={(x, y, clipId) => setMenu({ x, y, clipId })}
                />
              ))}
              {marquee && (
                <div
                  className="marquee"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
                />
              )}
            </div>
            <Playhead pps={pps} follow={follow} scrollRef={scrollRef} onScrub={scrub} />
          </div>
        </div>
      </div>
      </RowScaleContext.Provider>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={closeMenu} />}
    </div>
  );
}

function TrackHead({ track, compact }: { track: Track; compact: boolean }) {
  const { apply } = useEditor();
  const rowScale = useContext(RowScaleContext);
  const patch = (changes: Partial<Track>) =>
    apply((seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.id === track.id ? { ...t, ...changes } : t)) }));

  return (
    <div className={`tl-head kind-${track.kind}`} style={{ height: laneHeight(track, compact, rowScale) }}>
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
        // ドラッグ中は本物の動画をシークしない（手を止めたときに 1 回だけ。player.setScrubbing）。
        player.setScrubbing(true);
        onScrub(event.clientX);
        beginDrag(
          event,
          (_dx, _dy, native) => onScrub(native.clientX),
          () => player.setScrubbing(false),
        );
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
  multi,
  onMenu,
}: {
  track: Track;
  pps: number;
  compact: boolean;
  onEmptyPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPickTransition: (clipId: string) => void;
  multi: boolean;
  onMenu: (x: number, y: number, clipId: string) => void;
}) {
  const { sequence, apply, insertMode, selection, setSelection, toggleSelection, isSelected, editMode, enterNest } = useEditor();
  const { settings } = useApp();
  const rowScale = useContext(RowScaleContext);
  const [dropping, setDropping] = useState(false);
  const clips = clipsOnTrack(sequence, track.id);
  // クリップの操作（ドラッグ・トリム）が使う「いまの状態」。描くたびに入れ替えるが、入れ物は同じなので
  // クリップ側は描き直しのきっかけにならない（押した瞬間に、ここから最新を読む）。
  const live = useRef<ClipLive>(null as unknown as ClipLive);
  live.current = { sequence, apply, selection, setSelection, toggleSelection, editMode, snap: settings.snap, onPickTransition, enterNest, multi, onMenu };

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
    apply((seq) => placeWithSound(adoptSourceFps(seq, assets[0].fps), clips, insertMode, assetHasSound));
  };

  return (
    <div
      className={`tl-lane kind-${track.kind}${dropping ? ' dropping' : ''}${track.locked ? ' locked' : ''}`}
      style={{ height: laneHeight(track, compact, rowScale) }}
      onPointerDown={(e) => e.button === 0 && e.target === e.currentTarget && onEmptyPointerDown(e)}
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
      {clips.map((clip) => {
        const asset = mediaRegistry.get(clip.mediaId);
        return (
          <ClipBlock
            key={clip.id}
            clip={clip}
            track={track}
            pps={pps}
            compact={compact}
            selected={isSelected(clip.id)}
            hasPrevious={track.kind === 'video' && previousAdjacent(sequence, clip) !== null}
            fresh={isFresh(clip.id)}
            thumbnail={asset?.thumbnail}
            assetName={asset?.name}
            live={live}
          />
        );
      })}
    </div>
  );
}

/** クリップの操作が押した瞬間に読む、エディタの「いまの状態」。 */
interface ClipLive {
  sequence: Sequence;
  apply: ReturnType<typeof useEditor>['apply'];
  selection: string[];
  setSelection: (ids: string[]) => void;
  toggleSelection: ReturnType<typeof useEditor>['toggleSelection'];
  editMode: EditMode;
  snap: boolean;
  onPickTransition: (clipId: string) => void;
  enterNest: (clipId: string) => void;
  /** タップで選び足すモード。 */
  multi: boolean;
  onMenu: (x: number, y: number, clipId: string) => void;
}

/**
 * 1 つのクリップ。
 *
 * エディタ全体の状態は**見ない**（見ると、どれか 1 つを選んだだけで全クリップが描き直しになる。
 * 400 クリップで 1 回 100ms を超えていた）。描くのに要るものは引数で受け、
 * ドラッグなどの操作は、押した瞬間に `live` から最新の状態を読む。
 * 引数が変わったクリップだけが描き直される（memo）。
 */
const ClipBlock = memo(function ClipBlock({
  clip,
  track,
  pps,
  compact,
  selected,
  hasPrevious,
  fresh,
  thumbnail,
  assetName,
  live,
}: {
  clip: Clip;
  track: Track;
  pps: number;
  compact: boolean;
  selected: boolean;
  hasPrevious: boolean;
  fresh: boolean;
  thumbnail: string | undefined;
  assetName: string | undefined;
  live: MutableRefObject<ClipLive>;
}) {
  const rowScale = useContext(RowScaleContext);
  const width = Math.max(14, clip.duration * pps);

  const label =
    clip.kind === 'text'
      ? `T ${previewText(clip.text?.content ?? '').split('\n')[0] || '（空）'}`
      : clip.kind === 'nest'
        ? `${clip.name || 'まとめたクリップ'}（${clip.nested?.clips.length ?? 0} 本）`
        : (assetName ?? '素材');

  /** メニューを出す。選んでいないクリップの上なら、まずそれを選ぶ（メニューは選んだもの全部に効く）。 */
  const openMenu = (x: number, y: number) => {
    if (!selected) live.current.setSelection([clip.id]);
    live.current.onMenu(x, y, clip.id);
  };

  const startMove = (event: React.PointerEvent) => {
    // 右クリックはメニュー（onContextMenu）。ドラッグを始めない。
    if (event.button !== 0) return;
    if (track.locked) return;
    const { sequence, apply, selection, setSelection, toggleSelection, editMode, snap, multi } = live.current;
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
    const additive = event.shiftKey || multi;
    if (!selected) toggleSelection(clip.id, additive);
    const ids = selected ? selection : additive ? [...selection, clip.id] : [clip.id];
    const rowHeight = laneHeight(track, compact, rowScale) + 4;
    // 差分を積み上げると carve と噛み合ってズレるので、常に開始時点の状態から作り直す。
    const original = sequence;
    const candidates = snapCandidates(sequence, player.time, ids);
    let moved = false;
    // 指は押しただけでも少しぶれる。ぶれの分は動かさず、長押しでメニューを出す。
    const byTouch = event.pointerType === 'touch';
    let slipped = !byTouch;
    let menuShown = false;
    const pressX = event.clientX;
    const pressY = event.clientY;
    const longPress = byTouch
      ? window.setTimeout(() => {
          if (moved || slipped) return;
          menuShown = true;
          openMenu(pressX, pressY);
        }, LONG_PRESS_MS)
      : undefined;

    beginDrag(
      event,
      (dx, dy) => {
        if (menuShown) return;
        if (!slipped) {
          if (Math.hypot(dx, dy) < TOUCH_SLOP_PX) return;
          slipped = true;
        }
        let deltaTime = dx / pps;
        if (snap) {
          deltaTime = snapTime(clip.start + deltaTime, candidates, SNAP_PX / pps) - clip.start;
        }
        // 画面では上ほど番号が大きいので、下方向のドラッグは -1 段
        const deltaTrack = -Math.round(dy / rowHeight);
        if (Math.abs(deltaTime) < 0.002 && deltaTrack === 0) return;
        moved = true;
        apply(() => moveClips(original, ids, deltaTime, deltaTrack), `move:${clip.id}`);
      },
      () => {
        window.clearTimeout(longPress);
        if (moved || menuShown) return;
        // 動かさずに離した: ふつうはそのクリップだけを選ぶ。選び足しのときは、選んであったものを外す。
        if (!additive) setSelection([clip.id]);
        else if (selected) toggleSelection(clip.id, true);
      },
    );
  };

  const startTrim = (event: React.PointerEvent, side: 'left' | 'right') => {
    if (event.button !== 0) return;
    if (track.locked) return;
    const { sequence, apply, setSelection, editMode, snap } = live.current;
    setSelection([clip.id]);
    const original = sequence;
    const mode = effectiveMode(editMode, event, 'edge');
    const candidates = snapCandidates(sequence, player.time, [clip.id]);
    beginDrag(event, (dx) => {
      const edge = side === 'left' ? clip.start : clipEnd(clip);
      let delta = dx / pps;
      if (snap) delta = snapTime(edge + delta, candidates, SNAP_PX / pps) - edge;
      apply(() => trimByMode(original, clip.id, side, delta, mode, sourceLengthOf), `trim:${mode}:${clip.id}:${side}`);
    });
  };

  return (
    <div
      className={`tl-clip kind-${clip.kind}${selected ? ' selected' : ''}${fresh ? ' fresh' : ''}`}
      style={{
        left: clip.start * pps,
        width,
        // サムネイルは ::before で敷く（styles.css）。そこで色を落とすので、ここでは場所だけ渡す。
        ['--thumb' as string]: thumbnail ? `url(${thumbnail})` : undefined,
      }}
      onPointerDown={startMove}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }}
      // まとめたクリップは、ダブルクリックで中に入って編集する。
      onDoubleClick={clip.kind === 'nest' ? () => live.current.enterNest(clip.id) : undefined}
      title={clip.kind === 'nest' ? `${label} — ダブルクリックで中身を編集・右クリックでメニュー` : `${label} — ${clip.duration.toFixed(2)}秒・右クリックでメニュー`}
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
            live.current.onPickTransition(clip.id);
          }}
        >
          <Icon name={TRANSITION_ICON[clip.transitionIn.type]} size={12} />
        </button>
      )}
      <span className="tl-clip-label">
        {/* つないだ映像は、音を音声レーンの側で鳴らすので、ミュートの印ではなくつなぎの印を出す。 */}
        {clip.kind === 'nest' && <Icon name="layers" size={11} />}
        {clip.linkId && <Icon name="link" size={11} />}
        {clip.muted && !(clip.linkId && clip.kind === 'video') && <MuteIcon />}
        {clip.speed !== 1 && `${clip.speed}× `}
        {label}
      </span>
      {width > 54 && <span className="tl-clip-time">{clip.duration.toFixed(1)}s</span>}
      <span className="tl-handle right" onPointerDown={(e) => startTrim(e, 'right')} />
    </div>
  );
});

/** 追従スクロールの確認間隔（ミリ秒）。毎フレームやると同期レイアウトを起こす。 */
const FOLLOW_CHECK_MS = 250;

function Playhead({
  pps,
  follow,
  scrollRef,
  onScrub,
}: {
  pps: number;
  follow: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScrub: (clientX: number) => void;
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
      {/* つまみは掴んで左右に動かせる（目盛りをなぞるのと同じ）。 */}
      <span
        className="tl-playhead-grip"
        title="ドラッグで再生位置を動かす"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          player.setScrubbing(true);
          beginDrag(
            event,
            (_dx, _dy, native) => onScrub(native.clientX),
            () => player.setScrubbing(false),
          );
        }}
      />
    </div>
  );
}

/** ネストの道筋の、それぞれの名前（外から順に）。 */
function nestNames(root: Sequence, path: string[]): string[] {
  const names: string[] = [];
  let current: Sequence | undefined = root;
  for (const id of path) {
    const nest: Clip | undefined = current?.clips.find((c) => c.id === id);
    names.push(nest?.name || 'まとめたクリップ');
    current = nest?.nested;
  }
  return names;
}
