/** プロジェクトのドメインモデル。ここにあるものは全て JSON 化できる（= 履歴・保存に載せられる）。 */

export type AspectKey = '9:16' | '1:1' | '4:5' | '16:9';

export interface AspectPreset {
  key: AspectKey;
  label: string;
  hint: string;
  width: number;
  height: number;
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { key: '9:16', label: '9:16', hint: 'TikTok / Reels / Shorts', width: 1080, height: 1920 },
  { key: '1:1', label: '1:1', hint: 'フィード投稿', width: 1080, height: 1080 },
  { key: '4:5', label: '4:5', hint: 'Instagram 縦フィード', width: 1080, height: 1350 },
  { key: '16:9', label: '16:9', hint: '横型 / YouTube', width: 1920, height: 1080 },
];

export interface Filters {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  grayscale: number;
  sepia: number;
  hueRotate: number;
}

export const DEFAULT_FILTERS: Filters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  blur: 0,
  grayscale: 0,
  sepia: 0,
  hueRotate: 0,
};

export interface Transform {
  /** 1 = 画面いっぱい（cover）。1 より大きいと寄り。 */
  scale: number;
  /** -1〜1。画面幅・高さに対する相対オフセット。 */
  x: number;
  y: number;
  rotate: number;
}

export const DEFAULT_TRANSFORM: Transform = { scale: 1, x: 0, y: 0, rotate: 0 };

/**
 * 画角に素材を収める方法。
 * cover = 画面いっぱい（はみ出しはカット） / blur = 全体を映してまわりをぼかしで埋める / contain = 全体を映して余白は背景色。
 */
export type FitMode = 'cover' | 'blur' | 'contain';

export interface Clip {
  id: string;
  mediaId: string;
  kind: 'video' | 'image';
  fit: FitMode;
  /** タイムライン上の開始位置（秒）。クリップ列から自動再計算される。 */
  start: number;
  /** 素材内のイン点（秒）。画像は常に 0。 */
  in: number;
  /** 素材内のアウト点（秒）。画像は表示したい秒数。 */
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  transform: Transform;
  filters: Filters;
  /** 黒からのフェードイン / 黒へのフェードアウト（秒）。 */
  fadeIn: number;
  fadeOut: number;
}

export type TextAnimation = 'none' | 'fade' | 'pop' | 'slideUp' | 'typewriter';
export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  fontFamily: string;
  /** プロジェクト幅 1080 を基準にした px。 */
  fontSize: number;
  weight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  bgColor: string;
  bgOpacity: number;
  shadow: number;
  lineHeight: number;
  letterSpacing: number;
  align: TextAlign;
}

export interface TextOverlay {
  id: string;
  text: string;
  start: number;
  duration: number;
  /** 0〜1 の正規化座標（テキストブロックの中心）。 */
  x: number;
  y: number;
  /** 0〜1。折り返し幅の画面比。 */
  maxWidth: number;
  rotate: number;
  animation: TextAnimation;
  style: TextStyle;
}

export interface MusicTrack {
  mediaId: string;
  /** タイムライン上の開始位置（秒）。 */
  start: number;
  in: number;
  out: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
}

export interface Project {
  name: string;
  aspect: AspectKey;
  width: number;
  height: number;
  fps: number;
  background: string;
  clips: Clip[];
  texts: TextOverlay[];
  music: MusicTrack | null;
}

export function createEmptyProject(): Project {
  const preset = ASPECT_PRESETS[0];
  return {
    name: 'ショート動画',
    aspect: preset.key,
    width: preset.width,
    height: preset.height,
    fps: 30,
    background: '#000000',
    clips: [],
    texts: [],
    music: null,
  };
}

/** 速度を反映した、タイムライン上でのクリップの尺（秒）。 */
export function clipDuration(clip: Clip): number {
  const raw = Math.max(0, clip.out - clip.in);
  return clip.kind === 'image' ? raw : raw / (clip.speed || 1);
}

/** クリップを隙間なく並べ直し、start を振り直す。 */
export function relayout(clips: Clip[]): Clip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const next = clip.start === cursor ? clip : { ...clip, start: cursor };
    cursor += clipDuration(clip);
    return next;
  });
}

export function projectDuration(project: Project): number {
  const video = project.clips.reduce((acc, c) => acc + clipDuration(c), 0);
  if (!project.music) return video;
  const musicEnd = project.music.start + Math.max(0, project.music.out - project.music.in);
  // 音楽だけが残っている尾は書き出さない。映像の尺を上限にする。
  return video > 0 ? video : Math.max(video, musicEnd);
}

/** 指定時刻に写っているクリップ。 */
export function clipAt(project: Project, time: number): Clip | null {
  for (const clip of project.clips) {
    if (time >= clip.start && time < clip.start + clipDuration(clip)) return clip;
  }
  // 末尾ちょうどは最後のクリップを返す（停止位置で黒画面にしないため）。
  const last = project.clips[project.clips.length - 1];
  if (last && time >= last.start) return last;
  return null;
}

/** クリップのタイムライン時刻 → 素材内の時刻。 */
export function sourceTimeFor(clip: Clip, time: number): number {
  const local = Math.max(0, time - clip.start);
  const speed = clip.kind === 'image' ? 1 : clip.speed || 1;
  return Math.min(clip.out, clip.in + local * speed);
}
