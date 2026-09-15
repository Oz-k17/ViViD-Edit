/**
 * 編集画面のパネル配置。
 *
 * パネルは「左レール / 右レール / 下段」の 3 つの置き場を行き来でき、
 * 同じ場所へ**重ねる**とタブになる。要らないものは仕舞える。
 *
 * 掴むのは各パネルの見出し（.panel-head）か、重ねたときのタブ。
 * 見出しは中身のコンポーネントが自前で描いているため、ドラッグの開始だけを
 * コンテキストで渡している。HTML5 の drag&drop ではなく Pointer Events を使うのは、
 * これならタッチでも同じコードで動くため。
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { uid } from '../../model/factory';
import {
  detachPanel,
  hidePanel,
  PANEL_IDS,
  PANEL_LABELS,
  PANEL_LIMITS,
  PANEL_SLOTS,
  showPanel,
  useApp,
  type PanelGroup,
  type PanelId,
  type PanelSlot,
} from '../../store/app';
import { Icon } from '../Icon';

/**
 * ドロップ先。位置ではなく**相手そのもの**で指す。
 * 掴んだパネルを取り除くと並びが詰まるので、番号で覚えていると 1 つずれる。
 */
interface DropTarget {
  slot: PanelSlot;
  /** このまとまりへ重ねる。 */
  joinGroupId: string | null;
  /** 重ねる相手の名前（案内に出すだけ）。 */
  joinPanel: PanelId | null;
  /** このまとまりの手前へ置く（null なら末尾）。 */
  beforeGroupId: string | null;
}

interface DockState {
  dragging: PanelId | null;
  target: DropTarget | null;
  pointer: { x: number; y: number } | null;
}

interface DockApi extends DockState {
  beginDrag: (id: PanelId, event: ReactPointerEvent, onTap?: () => void) => void;
  hide: (id: PanelId) => void;
}

/** 重ねるとみなす、まとまりの上端からの高さ（px）。見出し 1 行ぶん。 */
const JOIN_ZONE = 40;
/** これ以上動かしたらドラッグ。それ未満は「押しただけ」でタブの切り替えに使う。 */
const DRAG_THRESHOLD = 4;

const DockContext = createContext<DockApi | null>(null);
/** いま描いているパネルの id と、重なっているかどうか。 */
const DockPanelContext = createContext<{ id: PanelId; grouped: boolean } | null>(null);
const SlotRegistryContext = createContext<(slot: PanelSlot, el: HTMLElement | null) => void>(() => {});

export interface DockGrip {
  onPointerDown: (event: ReactPointerEvent) => void;
  dragging: boolean;
  /** タブとして重なっている（見出しの名前はタブ側に出ているので省いてよい）。 */
  grouped: boolean;
  /** 仕舞う。 */
  hide: () => void;
}

export function useDockGrip(): DockGrip | null {
  const dock = useContext(DockContext);
  const panel = useContext(DockPanelContext);
  if (!dock || !panel) return null;
  return {
    onPointerDown: (event: ReactPointerEvent) => dock.beginDrag(panel.id, event),
    dragging: dock.dragging === panel.id,
    grouped: panel.grouped,
    hide: () => dock.hide(panel.id),
  };
}

type SlotElements = Partial<Record<PanelSlot, HTMLElement | null>>;

/**
 * ポインタの位置から、どこへ落とすかを決める。
 * まとまりの上端（見出しのあたり）なら重ね、それ以外は前後へ差し込む。
 */
function findTarget(elements: SlotElements, x: number, y: number): DropTarget | null {
  for (const slot of PANEL_SLOTS) {
    const el = elements[slot];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;

    const horizontal = slot === 'bottom';
    const items = [...el.querySelectorAll<HTMLElement>(':scope > .dock-item')];

    for (const item of items) {
      const box = item.getBoundingClientRect();
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (inside && y - box.top <= JOIN_ZONE) {
        return {
          slot,
          joinGroupId: item.dataset.groupId ?? null,
          joinPanel: (item.dataset.active as PanelId) ?? null,
          beforeGroupId: null,
        };
      }
    }

    for (const item of items) {
      const box = item.getBoundingClientRect();
      const middle = horizontal ? box.left + box.width / 2 : box.top + box.height / 2;
      if ((horizontal ? x : y) < middle) {
        return { slot, joinGroupId: null, joinPanel: null, beforeGroupId: item.dataset.groupId ?? null };
      }
    }
    return { slot, joinGroupId: null, joinPanel: null, beforeGroupId: null };
  }
  return null;
}

export function DockProvider({ children }: { children: ReactNode }) {
  const { settings, updatePanels } = useApp();
  const elements = useRef<SlotElements>({});
  const [state, setState] = useState<DockState>({ dragging: null, target: null, pointer: null });
  // ドラッグ中の値をイベントハンドラから読むための箱。
  const live = useRef<DockState>(state);
  live.current = state;
  const layout = useRef(settings.panels);
  layout.current = settings.panels;

  const registerSlot = useCallback((slot: PanelSlot, el: HTMLElement | null) => {
    elements.current[slot] = el;
  }, []);

  const drop = useCallback(
    (id: PanelId, target: DropTarget) => {
      // 相手が「自分ひとりのまとまり」なら、もう目的の場所に居る。動かさない。
      // （抜いた時点で相手が消えてしまい、末尾へ飛んでしまうのを防ぐ。）
      const wanted = target.joinGroupId ?? target.beforeGroupId;
      const here = layout.current.slots[target.slot].find((g) => g.id === wanted);
      if (here && here.panels.length === 1 && here.panels[0] === id) return;

      const { slots, hidden } = detachPanel(layout.current, id);
      const list = slots[target.slot];

      // 重ねる相手が、自分を抜いたせいで消えていることがある（1 枚だけのまとまりだった場合）。
      const join = target.joinGroupId ? list.find((g) => g.id === target.joinGroupId) : undefined;
      if (join) {
        join.panels = [...join.panels, id];
        join.active = id;
      } else {
        const fresh: PanelGroup = { id: uid('g'), panels: [id], active: id };
        const at = target.beforeGroupId ? list.findIndex((g) => g.id === target.beforeGroupId) : -1;
        if (at >= 0) list.splice(at, 0, fresh);
        else list.push(fresh);
      }
      updatePanels({ slots, hidden });
    },
    [updatePanels],
  );

  /** 掴む・動かす・離すの一連。少ししか動かなければ「押しただけ」として onTap を呼ぶ。 */
  const startDrag = useCallback(
    (id: PanelId, event: ReactPointerEvent, onTap?: () => void) => {
      event.preventDefault();
      const from = { x: event.clientX, y: event.clientY };
      let moved = false;

      const move = (e: PointerEvent) => {
        if (!moved && Math.hypot(e.clientX - from.x, e.clientY - from.y) < DRAG_THRESHOLD) return;
        moved = true;
        setState({
          dragging: id,
          target: findTarget(elements.current, e.clientX, e.clientY),
          pointer: { x: e.clientX, y: e.clientY },
        });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        const target = live.current.target;
        setState({ dragging: null, target: null, pointer: null });
        if (!moved) onTap?.();
        else if (target) drop(id, target);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [drop],
  );

  const beginDrag = useCallback(
    (id: PanelId, event: ReactPointerEvent, onTap?: () => void) => {
      // 見出しの中のボタン（＋追加・削除など）を押したときは掴まない。
      // タブ（onTap を渡してくる側）はタブ自体がボタンなので、この判定は掛けない。
      if (!onTap && (event.target as HTMLElement).closest('button, input, select, textarea, a')) return;
      startDrag(id, event, onTap);
    },
    [startDrag],
  );

  const hide = useCallback((id: PanelId) => updatePanels(hidePanel(layout.current, id)), [updatePanels]);

  const api = useMemo<DockApi>(() => ({ ...state, beginDrag, hide }), [state, beginDrag, hide]);

  return (
    <DockContext.Provider value={api}>
      <SlotRegistryContext.Provider value={registerSlot}>
        {children}
        {state.dragging && state.pointer && (
          <div className="dock-ghost" style={{ left: state.pointer.x, top: state.pointer.y }}>
            {PANEL_LABELS[state.dragging]}
            {state.target?.joinPanel && <em>→ {PANEL_LABELS[state.target.joinPanel]} に重ねる</em>}
          </div>
        )}
      </SlotRegistryContext.Provider>
    </DockContext.Provider>
  );
}

/**
 * どのパネルを出しているかの一覧と、その切り替え。
 * 仕舞ったパネルを戻す道がどこかに要る（画面から消えると二度と出せなくなる）。
 */
export function PanelMenu() {
  const { settings, updatePanels } = useApp();
  const [open, setOpen] = useState(false);
  const hidden = new Set(settings.panels.hidden);

  // ここは DockProvider の外（上部バー）からも使うので、
  // ドラッグの仕組みには触らず、配置の純粋関数だけを呼ぶ。
  const toggle = (id: PanelId) =>
    updatePanels(hidden.has(id) ? showPanel(settings.panels, id) : hidePanel(settings.panels, id));

  return (
    <div className="panel-menu">
      <button
        type="button"
        className={hidden.size > 0 ? 'has-hidden' : ''}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="出すパネルを選ぶ"
      >
        <Icon name="panels" />パネル{hidden.size > 0 ? `（${PANEL_IDS.length - hidden.size}/${PANEL_IDS.length}）` : ''}
      </button>
      {open && (
        <>
          {/* 外側を押したら閉じる。メニューの外に置いたクリック受け。 */}
          <div className="panel-menu-scrim" onClick={() => setOpen(false)} />
          <div className="panel-menu-list">
            {PANEL_IDS.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={!hidden.has(id)}
                  onChange={() => toggle(id)}
                />
                {PANEL_LABELS[id]}
              </label>
            ))}
            <p className="muted small">見出しを他のパネルの見出しへ落とすと、重なってタブになります。</p>
          </div>
        </>
      )}
    </div>
  );
}

/** 置き場ひとつ。中に並ぶパネルの実体は render で受け取る。 */
export function DockSlot({
  slot,
  render,
  style,
}: {
  slot: PanelSlot;
  render: (id: PanelId) => ReactNode;
  style?: CSSProperties;
}) {
  const { settings, updatePanels } = useApp();
  const dock = useContext(DockContext);
  const registerSlot = useContext(SlotRegistryContext);
  const groups = settings.panels.slots[slot];
  const target = dock?.target?.slot === slot ? dock.target : null;

  if (groups.length === 0 && !dock?.dragging) return null;

  const setActive = (groupId: string, id: PanelId) => {
    const slots = {} as Record<PanelSlot, PanelGroup[]>;
    for (const s of PANEL_SLOTS) {
      slots[s] = settings.panels.slots[s].map((g) => (g.id === groupId ? { ...g, active: id } : g));
    }
    updatePanels({ slots });
  };

  return (
    <div
      ref={(el) => registerSlot(slot, el)}
      className={`dock-slot slot-${slot}${dock?.dragging ? ' droppable' : ''}${target ? ' hovered' : ''}`}
      style={style}
    >
      {groups.map((group) => (
        <div
          key={group.id}
          data-group-id={group.id}
          data-active={group.active}
          className={
            `dock-item${group.panels.includes(dock?.dragging as PanelId) ? ' dragging' : ''}` +
            `${target?.joinGroupId === group.id ? ' joining' : ''}`
          }
        >
          {target?.beforeGroupId === group.id && <div className="dock-marker" />}
          {group.panels.length > 1 && (
            <div className="dock-tabs">
              {group.panels.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={id === group.active ? 'active' : ''}
                  title="クリックで切り替え / ドラッグで別の場所へ"
                  onPointerDown={(event) => dock?.beginDrag(id, event, () => setActive(group.id, id))}
                >
                  {PANEL_LABELS[id]}
                  <span
                    className="dock-close"
                    role="button"
                    aria-label={`${PANEL_LABELS[id]} を仕舞う`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => dock?.hide(id)}
                  >
                    <Icon name="xmark" size={13} />
                  </span>
                </button>
              ))}
            </div>
          )}
          <DockPanelContext.Provider value={{ id: group.active, grouped: group.panels.length > 1 }}>
            {render(group.active)}
          </DockPanelContext.Provider>
        </div>
      ))}
      {target && !target.joinGroupId && !target.beforeGroupId && <div className="dock-marker" />}
      {groups.length === 0 && <p className="dock-empty">ここへ</p>}
    </div>
  );
}

/**
 * 置き場の境目。ドラッグで幅・高さを変える。
 * axis が 'x' なら左右、'y' なら上下。sign は「引いた向きに増えるか減るか」。
 */
export function DockSplitter({
  axis,
  value,
  sign = 1,
  onChange,
  label,
}: {
  axis: 'x' | 'y';
  value: number;
  sign?: 1 | -1;
  onChange: (next: number) => void;
  label: string;
}) {
  const min = axis === 'x' ? PANEL_LIMITS.railMin : PANEL_LIMITS.dockMin;
  const max = axis === 'x' ? PANEL_LIMITS.railMax : PANEL_LIMITS.dockMax;

  const onPointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    const origin = axis === 'x' ? event.clientX : event.clientY;
    const start = value;
    const move = (e: PointerEvent) => {
      const delta = ((axis === 'x' ? e.clientX : e.clientY) - origin) * sign;
      onChange(Math.round(Math.max(min, Math.min(max, start + delta))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`dock-splitter axis-${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(axis === 'x' ? PANEL_LIMITS.railMin : PANEL_LIMITS.dockMin)}
      title={`${label}（ドラッグで幅を変更）`}
    />
  );
}
