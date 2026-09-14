/**
 * アプリ全体の設定とテンプレート。
 * エディタの状態とは寿命が違う（ページを跨いで生き残る）ので、別ストアにして localStorage に置く。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setLang, type Lang } from '../i18n';
import { uid } from '../model/factory';
import type { AspectKey, Sequence, TextProps } from '../model/types';
import { migrateStorageKey } from './storage';
import {
  currentProfile,
  listProfiles,
  newProfileId,
  saveProfiles,
  scopedKey,
  setCurrentProfileId,
  type Profile,
} from './profile';
import {
  loadMediaRoots,
  personalBaseFor,
  saveMediaRoots,
  type MediaRoots,
} from './mediaRoots';

export type ShortcutAction =
  | 'playPause'
  | 'split'
  | 'addText'
  | 'delete'
  | 'rippleDelete'
  | 'undo'
  | 'redo'
  | 'stepBack'
  | 'stepForward'
  | 'zoomIn'
  | 'zoomOut';

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  playPause: '再生 / 一時停止',
  split: '再生ヘッドで分割',
  addText: 'テロップを追加',
  delete: '削除',
  rippleDelete: 'リップル削除',
  undo: '元に戻す',
  redo: 'やり直す',
  stepBack: '1 フレーム戻る',
  stepForward: '1 フレーム進む',
  zoomIn: 'タイムラインを拡大',
  zoomOut: 'タイムラインを縮小',
};

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  playPause: 'Space',
  split: 'KeyC',
  addText: 'KeyT',
  delete: 'Delete',
  rippleDelete: 'shift+Delete',
  undo: 'mod+KeyZ',
  redo: 'mod+shift+KeyZ',
  stepBack: 'ArrowLeft',
  stepForward: 'ArrowRight',
  zoomIn: 'mod+Equal',
  zoomOut: 'mod+Minus',
};

export type LayoutMode = 'desktop' | 'mobile';

/** 編集画面に置けるパネル。 */
export type PanelId = 'media' | 'inspector' | 'timeline';
/** パネルを置ける場所。 */
export type PanelSlot = 'left' | 'right' | 'bottom';

export const PANEL_IDS: PanelId[] = ['media', 'inspector', 'timeline'];
export const PANEL_SLOTS: PanelSlot[] = ['left', 'right', 'bottom'];

export const PANEL_LABELS: Record<PanelId, string> = {
  media: '素材',
  inspector: 'インスペクタ',
  timeline: 'タイムライン',
};

/**
 * 同じ場所に重ねたパネルのまとまり。
 * 2 つ以上入っているとタブになり、前に出ているものだけが表示される。
 * id を持たせてあるのは、並べ替えのときに「どのまとまりへ／どの手前へ」を
 * 位置ではなく相手そのもので指せるようにするため（位置は取り除いた拍子にずれる）。
 */
export interface PanelGroup {
  id: string;
  panels: PanelId[];
  /** いま前に出ているパネル。 */
  active: PanelId;
}

export interface PanelLayout {
  slots: Record<PanelSlot, PanelGroup[]>;
  /** どこにも置いていない（非表示にした）パネル。 */
  hidden: PanelId[];
  /** 左右のレールの幅と、下段の高さ（px）。 */
  leftWidth: number;
  rightWidth: number;
  dockHeight: number;
}

const group = (...panels: PanelId[]): PanelGroup => ({ id: uid('g'), panels, active: panels[0] });

export const DEFAULT_PANELS: PanelLayout = {
  slots: { left: [group('media')], right: [group('inspector')], bottom: [group('timeline')] },
  hidden: [],
  leftWidth: 290,
  rightWidth: 330,
  dockHeight: 300,
};

export const PANEL_LIMITS = {
  railMin: 200,
  railMax: 560,
  dockMin: 120,
  dockMax: 720,
};

const clampSize = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)));

/** そのパネルが既定でどこに置かれるか。 */
export function homeSlotOf(id: PanelId): PanelSlot {
  return PANEL_SLOTS.find((slot) => DEFAULT_PANELS.slots[slot].some((g) => g.panels.includes(id))) ?? 'left';
}

/** 保存された値は、まとまりの形にも文字列の並びにもなりうる（古い形からの引き継ぎ）。 */
type StoredGroup = PanelGroup | PanelId;

/**
 * 保存されたレイアウトを、必ず「すべてのパネルがちょうど 1 回ずつ出てくる」形に直す。
 *
 * パネルが増えたり名前が変わったりしても、古い設定のせいで画面が欠けないようにするため。
 * 重ねる仕組みを入れる前は `slots` が文字列の並びだったので、その形も受け取れるようにしてある。
 */
export function sanitizePanels(layout: Partial<PanelLayout> | undefined): PanelLayout {
  const slots: Record<PanelSlot, PanelGroup[]> = { left: [], right: [], bottom: [] };
  const placed = new Set<PanelId>();

  const take = (ids: PanelId[]): PanelId[] => {
    const out: PanelId[] = [];
    for (const id of ids) {
      if (!PANEL_IDS.includes(id) || placed.has(id)) continue;
      placed.add(id);
      out.push(id);
    }
    return out;
  };

  for (const slot of PANEL_SLOTS) {
    for (const stored of (layout?.slots?.[slot] ?? []) as StoredGroup[]) {
      // 古い形（文字列だけ）は、1 枚だけのまとまりとして読む。
      const panels = take(typeof stored === 'string' ? [stored] : (stored?.panels ?? []));
      if (panels.length === 0) continue;
      const wanted = typeof stored === 'string' ? undefined : stored?.active;
      slots[slot].push({
        id: typeof stored === 'string' ? uid('g') : stored?.id || uid('g'),
        panels,
        active: wanted && panels.includes(wanted) ? wanted : panels[0],
      });
    }
  }

  // 非表示にしたものは、置き場のあとで読む（両方に出てきたら「表示」を採る）。
  const hidden = take((layout?.hidden ?? []) as PanelId[]);

  // どちらにも出てこなかったものは、既定の置き場へ戻す。
  // 新しく増えたパネルが、古い設定のせいで消えたままにならないようにするため。
  for (const id of PANEL_IDS) {
    if (placed.has(id)) continue;
    slots[homeSlotOf(id)].push({ id: uid('g'), panels: [id], active: id });
  }

  return {
    slots,
    hidden,
    leftWidth: clampSize(layout?.leftWidth ?? DEFAULT_PANELS.leftWidth, PANEL_LIMITS.railMin, PANEL_LIMITS.railMax),
    rightWidth: clampSize(layout?.rightWidth ?? DEFAULT_PANELS.rightWidth, PANEL_LIMITS.railMin, PANEL_LIMITS.railMax),
    dockHeight: clampSize(layout?.dockHeight ?? DEFAULT_PANELS.dockHeight, PANEL_LIMITS.dockMin, PANEL_LIMITS.dockMax),
  };
}

/**
 * パネルをどこからでも取り除く（空になったまとまりは畳む）。
 *
 * 配置をいじる操作はすべてこれを土台にしている。「掴んで動かす」も「仕舞う」も、
 * まず抜いてから置き直すという同じ形なので、抜くところだけを 1 か所に置いた。
 */
export function detachPanel(layout: PanelLayout, id: PanelId): { slots: Record<PanelSlot, PanelGroup[]>; hidden: PanelId[] } {
  const slots = {} as Record<PanelSlot, PanelGroup[]>;
  for (const slot of PANEL_SLOTS) {
    slots[slot] = layout.slots[slot]
      .map((g) => ({ ...g, panels: g.panels.filter((p) => p !== id) }))
      .filter((g) => g.panels.length > 0)
      .map((g) => ({ ...g, active: g.panels.includes(g.active) ? g.active : g.panels[0] }));
  }
  return { slots, hidden: layout.hidden.filter((p) => p !== id) };
}

/** 仕舞う（画面から下ろす）。 */
export function hidePanel(layout: PanelLayout, id: PanelId): Partial<PanelLayout> {
  const { slots, hidden } = detachPanel(layout, id);
  return { slots, hidden: [...hidden, id] };
}

/** 既定の置き場へ戻す。 */
export function showPanel(layout: PanelLayout, id: PanelId): Partial<PanelLayout> {
  const { slots, hidden } = detachPanel(layout, id);
  slots[homeSlotOf(id)] = [...slots[homeSlotOf(id)], { id: uid('g'), panels: [id], active: id }];
  return { slots, hidden };
}

/** プレビューを描く解像度（長辺の px）。書き出しの画質には影響しない。 */
export type PreviewQuality = 480 | 720 | 1080;

export interface Settings {
  lang: Lang;
  layout: LayoutMode;
  previewQuality: PreviewQuality;
  exportQuality: number;
  exportAspect: AspectKey;
  exportFormat: 'auto' | 'mp4' | 'webm';
  snap: boolean;
  shortcuts: Record<ShortcutAction, string>;
  /** 編集画面のパネル配置。 */
  panels: PanelLayout;
  /**
   * 共有素材フォルダの場所（NAS など）。ページからの相対パスで持つ。
   * 既定の `media/` は「アプリと素材を同じ Web サーバから配る」構成（deploy/nas/）に合わせたもの。
   * 相対で持つのは、NAS のホスト名や口が変わってもプロジェクトが壊れないようにするため。
   */
  mediaBase: string;
}

/** 初回だけ画面幅で当たりをつける。以後はユーザーが選んだものを記憶する。 */
function guessLayout(): LayoutMode {
  return typeof window !== 'undefined' && window.innerWidth < 820 ? 'mobile' : 'desktop';
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'ja',
  layout: 'desktop',
  previewQuality: 720,
  exportQuality: 1080,
  exportAspect: '9:16',
  exportFormat: 'auto',
  snap: true,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  panels: DEFAULT_PANELS,
  mediaBase: 'media/',
};

export interface TextTemplate {
  id: string;
  kind: 'text';
  name: string;
  text: TextProps;
  createdAt: number;
}

export interface LayoutTemplate {
  id: string;
  kind: 'layout';
  name: string;
  sequence: Sequence;
  createdAt: number;
}

export type Template = TextTemplate | LayoutTemplate;

// 使う人ごとに分ける。既定の人は昔のキーのまま（`profile.ts` を見よ）。
const SETTINGS_KEY = scopedKey('vivid.settings');
const TEMPLATES_KEY = scopedKey('vivid.templates');

// 旧名で保存されていた分を引き継ぐ（アプリ名変更にともなう一度きりの処理）。
migrateStorageKey('tateyoko.settings', SETTINGS_KEY);
migrateStorageKey('tateyoko.templates', TEMPLATES_KEY);

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 容量超過などは黙って諦める */
  }
}

interface AppApi {
  settings: Settings;
  /** いま使っている人。 */
  profile: Profile;
  profiles: Profile[];
  /** 使う人を切り替える。保存先ごと切り替わるので、読み込み直す。 */
  switchProfile: (id: string) => void;
  addProfile: (name: string) => Profile;
  updateProfile: (id: string, patch: Partial<Omit<Profile, 'id'>>) => void;
  removeProfile: (id: string) => void;
  /** 素材の置き場所（端末で 1 つ。人ごとには分けない）。 */
  mediaRoots: MediaRoots;
  updateMediaRoots: (patch: Partial<MediaRoots>) => void;
  /** いまの人の個人素材フォルダ。設定が足りなければ null。 */
  personalBase: string | null;
  updateSettings: (patch: Partial<Settings>) => void;
  resetShortcuts: () => void;
  /** 編集画面のパネル配置を更新する（保存まで面倒をみる）。 */
  updatePanels: (patch: Partial<PanelLayout>) => void;
  resetPanels: () => void;
  templates: Template[];
  addTemplate: (template: Omit<TextTemplate, 'id' | 'createdAt'> | Omit<LayoutTemplate, 'id' | 'createdAt'>) => Template;
  removeTemplate: (id: string) => void;
  renameTemplate: (id: string, name: string) => void;
}

const AppContext = createContext<AppApi | null>(null);

/**
 * 素材の置き場所を初めて作るときの種。
 * 「共有」と「個人」に分ける前は `settings.mediaBase` 1 本だったので、そこから引き継ぐ。
 */
function legacySharedBase(): string | undefined {
  try {
    const raw = localStorage.getItem('vivid.settings');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return typeof parsed.mediaBase === 'string' ? parsed.mediaBase : undefined;
  } catch {
    return undefined;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = load(SETTINGS_KEY, { ...DEFAULT_SETTINGS, layout: guessLayout() });
    return { ...loaded, panels: sanitizePanels(loaded.panels) };
  });
  const [profiles, setProfiles] = useState<Profile[]>(() => listProfiles());
  const [profile, setProfile] = useState<Profile>(() => currentProfile());
  const [mediaRoots, setMediaRoots] = useState<MediaRoots>(() => loadMediaRoots(legacySharedBase()));
  const [templates, setTemplates] = useState<Template[]>(() => {
    try {
      const raw = localStorage.getItem(TEMPLATES_KEY);
      return raw ? (JSON.parse(raw) as Template[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    setLang(settings.lang);
    // 管理ページ側の CSS もここを見て切り替える
    document.documentElement.dataset.layout = settings.layout;
    save(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    save(TEMPLATES_KEY, templates);
  }, [templates]);

  useEffect(() => {
    saveMediaRoots(mediaRoots);
  }, [mediaRoots]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateMediaRoots = useCallback((patch: Partial<MediaRoots>) => {
    setMediaRoots((prev) => ({ ...prev, ...patch }));
  }, []);

  /**
   * 使う人を切り替える。
   * 設定も下書きも素材ライブラリも保存キーごと変わるので、読み込み直すのが確実。
   * 途中の編集を巻き込まないよう、保存が終わってから動かす。
   */
  const switchProfile = useCallback((id: string) => {
    setCurrentProfileId(id);
    if (typeof window !== 'undefined') window.location.reload();
  }, []);

  const addProfile = useCallback((name: string) => {
    const trimmed = name.trim() || '名無し';
    const created: Profile = { id: newProfileId(), name: trimmed, folder: trimmed };
    setProfiles((prev) => {
      const next = [...prev, created];
      saveProfiles(next);
      return next;
    });
    return created;
  }, []);

  const updateProfile = useCallback((id: string, patch: Partial<Omit<Profile, 'id'>>) => {
    setProfiles((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...patch } : p));
      saveProfiles(next);
      return next;
    });
    setProfile((prev) => (prev.id === id ? { ...prev, ...patch } : prev));
  }, []);

  /**
   * プロフィールを一覧から外す。
   * 保存された下書きや素材はそのまま残す（消すと取り返せないため）。
   * 同じ名前で作り直しても中身は戻らない（id が変わるため）ことは画面側で断る。
   */
  const removeProfile = useCallback((id: string) => {
    setProfiles((prev) => {
      const next = prev.filter((p) => p.id !== id);
      saveProfiles(next);
      return next;
    });
  }, []);

  const resetShortcuts = useCallback(() => {
    setSettings((prev) => ({ ...prev, shortcuts: { ...DEFAULT_SHORTCUTS } }));
  }, []);

  const updatePanels = useCallback((patch: Partial<PanelLayout>) => {
    setSettings((prev) => ({ ...prev, panels: sanitizePanels({ ...prev.panels, ...patch }) }));
  }, []);

  const resetPanels = useCallback(() => {
    // DEFAULT_PANELS をそのまま入れると id を使い回してしまうので、作り直す。
    setSettings((prev) => ({ ...prev, panels: sanitizePanels({ ...DEFAULT_PANELS, slots: undefined }) }));
  }, []);

  const addTemplate = useCallback<AppApi['addTemplate']>((template) => {
    const created = { ...template, id: uid('tpl'), createdAt: Date.now() } as Template;
    setTemplates((prev) => [created, ...prev]);
    return created;
  }, []);

  const removeTemplate = useCallback((id: string) => {
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const renameTemplate = useCallback((id: string, name: string) => {
    setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

  const personalBase = useMemo(() => personalBaseFor(mediaRoots, profile.folder), [mediaRoots, profile.folder]);

  const value = useMemo<AppApi>(
    () => ({
      settings,
      updateSettings,
      resetShortcuts,
      updatePanels,
      resetPanels,
      templates,
      addTemplate,
      removeTemplate,
      renameTemplate,
      profile,
      profiles,
      switchProfile,
      addProfile,
      updateProfile,
      removeProfile,
      mediaRoots,
      updateMediaRoots,
      personalBase,
    }),
    [
      settings,
      updateSettings,
      resetShortcuts,
      updatePanels,
      resetPanels,
      templates,
      addTemplate,
      removeTemplate,
      renameTemplate,
      profile,
      profiles,
      switchProfile,
      addProfile,
      updateProfile,
      removeProfile,
      mediaRoots,
      updateMediaRoots,
      personalBase,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppProvider の外側で useApp が呼ばれました');
  return ctx;
}

/** KeyboardEvent を 'mod+shift+KeyZ' 形式にする。 */
export function shortcutFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  parts.push(event.code);
  return parts.join('+');
}

export function shortcutLabel(value: string): string {
  return value
    .replace('mod', 'Ctrl/⌘')
    .replace('shift', 'Shift')
    .replace('alt', 'Alt')
    .replace('Key', '')
    .replace('Digit', '')
    .replace('Equal', '+')
    .replace('Minus', '-')
    .replace('Arrow', '')
    .replace(/\+/g, ' + ')
    .replace('Ctrl/⌘ + ', 'Ctrl/⌘+');
}
