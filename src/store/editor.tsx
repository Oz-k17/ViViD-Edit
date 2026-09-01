/**
 * 編集中のプロジェクトと履歴。
 * タイムライン操作そのものは model/ops.ts の純粋関数に置き、ここは
 * 「適用して履歴に積む」ことと選択状態だけを受け持つ。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import { createProject } from '../model/factory';
import { ASPECT_PRESETS, type AspectKey, type Project, type Sequence } from '../model/types';

const HISTORY_LIMIT = 80;
const COALESCE_MS = 700;
const PROJECT_KEY = 'tateyoko.project';

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  lastKey: string | null;
  lastAt: number;
}

export type Action =
  | { type: 'apply'; fn: (sequence: Sequence) => Sequence; key?: string }
  | { type: 'project'; patch: Partial<Omit<Project, 'sequence'>>; key?: string }
  | { type: 'aspect'; aspect: AspectKey }
  | { type: 'load'; project: Project }
  | { type: 'undo' }
  | { type: 'redo' };

function commit(state: State, project: Project, key?: string): State {
  const now = Date.now();
  // スライダーを動かしている間に履歴が 100 件増えないよう、同じ操作は少しの間まとめる。
  const coalesce = key !== undefined && state.lastKey === key && now - state.lastAt < COALESCE_MS;
  return {
    project,
    past: coalesce ? state.past : [...state.past, state.project].slice(-HISTORY_LIMIT),
    future: [],
    lastKey: key ?? null,
    lastAt: now,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, HISTORY_LIMIT),
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        project: next,
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'load':
      return { project: action.project, past: [], future: [], lastKey: null, lastAt: 0 };
    case 'project':
      return commit(state, { ...state.project, ...action.patch }, action.key);
    case 'aspect': {
      const preset = ASPECT_PRESETS.find((p) => p.key === action.aspect);
      if (!preset) return state;
      return commit(state, {
        ...state.project,
        sequence: { ...state.project.sequence, aspect: preset.key, width: preset.width, height: preset.height },
      });
    }
    case 'apply': {
      const sequence = action.fn(state.project.sequence);
      if (sequence === state.project.sequence) return state;
      return commit(state, { ...state.project, sequence }, action.key);
    }
    default:
      return state;
  }
}

interface EditorApi {
  project: Project;
  sequence: Sequence;
  dispatch: Dispatch<Action>;
  /** よく使うので短縮版。 */
  apply: (fn: (sequence: Sequence) => Sequence, key?: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  selection: string[];
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string, additive: boolean) => void;
  isSelected: (id: string) => boolean;
}

const EditorContext = createContext<EditorApi | null>(null);

function restoreProject(): Project {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Project;
      if (parsed?.sequence?.tracks?.length) return parsed;
    }
  } catch {
    /* 壊れていたら作り直す */
  }
  return createProject();
}

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    project: restoreProject(),
    past: [],
    future: [],
    lastKey: null,
    lastAt: 0,
  }));
  const [selection, setSelectionState] = useState<string[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);

  // ページを移動しても戻ってこられるように、編集内容を控えておく。
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(PROJECT_KEY, JSON.stringify(state.project));
      } catch {
        /* 容量超過は無視 */
      }
    }, 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [state.project]);

  const apply = useCallback((fn: (sequence: Sequence) => Sequence, key?: string) => {
    dispatch({ type: 'apply', fn, key });
  }, []);

  const setSelection = useCallback((ids: string[]) => setSelectionState(ids), []);

  const toggleSelection = useCallback((id: string, additive: boolean) => {
    setSelectionState((prev) => {
      if (!additive) return [id];
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }, []);

  // 消えたクリップが選択に残らないようにする。
  useEffect(() => {
    setSelectionState((prev) => {
      const alive = prev.filter((id) => state.project.sequence.clips.some((c) => c.id === id));
      return alive.length === prev.length ? prev : alive;
    });
  }, [state.project.sequence.clips]);

  const value = useMemo<EditorApi>(
    () => ({
      project: state.project,
      sequence: state.project.sequence,
      dispatch,
      apply,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      selection,
      setSelection,
      toggleSelection,
      isSelected: (id: string) => selection.includes(id),
    }),
    [state, apply, selection, setSelection, toggleSelection],
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorApi {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('EditorProvider の外側で useEditor が呼ばれました');
  return ctx;
}
