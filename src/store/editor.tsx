/**
 * プロジェクト状態と履歴（元に戻す / やり直す）。
 * ここに入るのは JSON 化できるデータだけ。素材の実体は mediaRegistry 側にある。
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import {
  ASPECT_PRESETS,
  DEFAULT_FILTERS,
  DEFAULT_TRANSFORM,
  clipDuration,
  createEmptyProject,
  relayout,
  type AspectKey,
  type Clip,
  type MusicTrack,
  type Project,
  type TextOverlay,
} from '../types';
import { uid, type MediaAsset } from '../engine/media';
import { TEXT_PRESETS } from '../presets';

const HISTORY_LIMIT = 80;
const COALESCE_MS = 700;
/** 画像クリップの初期表示秒数。 */
export const DEFAULT_IMAGE_DURATION = 3;

export type Selection =
  | { type: 'none' }
  | { type: 'clip'; id: string }
  | { type: 'text'; id: string }
  | { type: 'music' };

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  lastKey: string | null;
  lastAt: number;
}

export type DeepPatch<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };
export type ClipPatch = DeepPatch<Clip>;
export type TextPatch = DeepPatch<TextOverlay>;

export type Action =
  | { type: 'project/patch'; patch: Partial<Project>; key?: string }
  | { type: 'project/aspect'; aspect: AspectKey }
  | { type: 'project/load'; project: Project }
  | { type: 'clip/add'; asset: MediaAsset; at?: number }
  | { type: 'clip/remove'; id: string }
  | { type: 'clip/duplicate'; id: string }
  | { type: 'clip/reorder'; from: number; to: number }
  | { type: 'clip/split'; time: number }
  | { type: 'clip/patch'; id: string; patch: DeepPatch<Clip>; key?: string }
  | { type: 'text/add'; overlay: TextOverlay }
  | { type: 'text/patch'; id: string; patch: DeepPatch<TextOverlay>; key?: string }
  | { type: 'text/remove'; id: string }
  | { type: 'music/set'; music: MusicTrack | null }
  | { type: 'music/patch'; patch: Partial<MusicTrack>; key?: string }
  | { type: 'history/undo' }
  | { type: 'history/redo' };

function commit(state: State, project: Project, key?: string): State {
  const now = Date.now();
  const coalesce = key !== undefined && state.lastKey === key && now - state.lastAt < COALESCE_MS;
  return {
    project,
    past: coalesce ? state.past : [...state.past, state.project].slice(-HISTORY_LIMIT),
    future: [],
    lastKey: key ?? null,
    lastAt: now,
  };
}

function mergeClip(clip: Clip, patch: DeepPatch<Clip>): Clip {
  return {
    ...clip,
    ...(patch as Partial<Clip>),
    transform: patch.transform ? { ...clip.transform, ...patch.transform } : clip.transform,
    filters: patch.filters ? { ...clip.filters, ...patch.filters } : clip.filters,
  };
}

function mergeText(overlay: TextOverlay, patch: DeepPatch<TextOverlay>): TextOverlay {
  return {
    ...overlay,
    ...(patch as Partial<TextOverlay>),
    style: patch.style ? { ...overlay.style, ...patch.style } : overlay.style,
  };
}

function clipFromAsset(asset: MediaAsset): Clip {
  const isImage = asset.kind === 'image';
  return {
    id: uid('c'),
    mediaId: asset.id,
    kind: isImage ? 'image' : 'video',
    fit: 'cover',
    start: 0,
    in: 0,
    out: isImage ? DEFAULT_IMAGE_DURATION : Math.max(0.1, asset.duration),
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    filters: { ...DEFAULT_FILTERS },
    fadeIn: 0,
    fadeOut: 0,
  };
}

function reducer(state: State, action: Action): State {
  const project = state.project;

  switch (action.type) {
    case 'history/undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        project: previous,
        past: state.past.slice(0, -1),
        future: [project, ...state.future].slice(0, HISTORY_LIMIT),
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'history/redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        project: next,
        past: [...state.past, project].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'project/load':
      return commit(state, action.project);
    case 'project/patch':
      return commit(state, { ...project, ...action.patch }, action.key);
    case 'project/aspect': {
      const preset = ASPECT_PRESETS.find((p) => p.key === action.aspect);
      if (!preset) return state;
      return commit(state, { ...project, aspect: preset.key, width: preset.width, height: preset.height });
    }
    case 'clip/add': {
      const clip = clipFromAsset(action.asset);
      const clips = [...project.clips];
      const index = action.at ?? clips.length;
      clips.splice(Math.max(0, Math.min(clips.length, index)), 0, clip);
      return commit(state, { ...project, clips: relayout(clips) });
    }
    case 'clip/remove':
      return commit(state, { ...project, clips: relayout(project.clips.filter((c) => c.id !== action.id)) });
    case 'clip/duplicate': {
      const index = project.clips.findIndex((c) => c.id === action.id);
      if (index < 0) return state;
      const copy: Clip = { ...structuredClone(project.clips[index]), id: uid('c') };
      const clips = [...project.clips];
      clips.splice(index + 1, 0, copy);
      return commit(state, { ...project, clips: relayout(clips) });
    }
    case 'clip/reorder': {
      const clips = [...project.clips];
      if (action.from < 0 || action.from >= clips.length) return state;
      const [moved] = clips.splice(action.from, 1);
      clips.splice(Math.max(0, Math.min(clips.length, action.to)), 0, moved);
      return commit(state, { ...project, clips: relayout(clips) });
    }
    case 'clip/split': {
      const index = project.clips.findIndex(
        (c) => action.time > c.start + 0.08 && action.time < c.start + clipDuration(c) - 0.08,
      );
      if (index < 0) return state;
      const clip = project.clips[index];
      const speed = clip.kind === 'image' ? 1 : clip.speed || 1;
      const cut = clip.in + (action.time - clip.start) * speed;
      const left: Clip = { ...structuredClone(clip), out: cut, fadeOut: 0 };
      const right: Clip = { ...structuredClone(clip), id: uid('c'), in: cut, fadeIn: 0 };
      const clips = [...project.clips];
      clips.splice(index, 1, left, right);
      return commit(state, { ...project, clips: relayout(clips) });
    }
    case 'clip/patch': {
      const clips = project.clips.map((c) => (c.id === action.id ? mergeClip(c, action.patch) : c));
      return commit(state, { ...project, clips: relayout(clips) }, action.key && `${action.key}:${action.id}`);
    }
    case 'text/add':
      return commit(state, { ...project, texts: [...project.texts, action.overlay] });
    case 'text/patch': {
      const texts = project.texts.map((t) => (t.id === action.id ? mergeText(t, action.patch) : t));
      return commit(state, { ...project, texts }, action.key && `${action.key}:${action.id}`);
    }
    case 'text/remove':
      return commit(state, { ...project, texts: project.texts.filter((t) => t.id !== action.id) });
    case 'music/set':
      return commit(state, { ...project, music: action.music });
    case 'music/patch':
      return commit(state, { ...project, music: project.music ? { ...project.music, ...action.patch } : null }, action.key);
    default:
      return state;
  }
}

interface EditorApi {
  project: Project;
  dispatch: Dispatch<Action>;
  canUndo: boolean;
  canRedo: boolean;
  selection: Selection;
  select: (selection: Selection) => void;
  selectedClip: Clip | null;
  selectedText: TextOverlay | null;
}

const EditorContext = createContext<EditorApi | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    project: createEmptyProject(),
    past: [],
    future: [],
    lastKey: null,
    lastAt: 0,
  }));
  const [selection, setSelection] = useState<Selection>({ type: 'none' });

  const select = useCallback((next: Selection) => setSelection(next), []);

  const value = useMemo<EditorApi>(() => {
    const selectedClip =
      selection.type === 'clip' ? (state.project.clips.find((c) => c.id === selection.id) ?? null) : null;
    const selectedText =
      selection.type === 'text' ? (state.project.texts.find((t) => t.id === selection.id) ?? null) : null;
    return {
      project: state.project,
      dispatch,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      selection,
      select,
      selectedClip,
      selectedText,
    };
  }, [state, selection, select]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorApi {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('EditorProvider の外側で useEditor が呼ばれました');
  return ctx;
}

/** 現在の再生位置に、扱いやすい初期値でテキストを作る。 */
export function makeTextOverlay(presetKey: string, start: number, duration = 3): TextOverlay {
  const preset = TEXT_PRESETS.find((p) => p.key === presetKey) ?? TEXT_PRESETS[0];
  return {
    id: uid('t'),
    text: 'テキストを入力',
    start: Math.max(0, start),
    duration,
    x: 0.5,
    y: preset.key === 'caption' ? 0.78 : 0.4,
    maxWidth: 0.82,
    rotate: 0,
    animation: preset.animation,
    style: { ...preset.style },
  };
}
