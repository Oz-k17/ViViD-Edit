import {
  ASPECT_PRESETS,
  DEFAULT_BG_BLUR,
  DEFAULT_CROP,
  type Clip,
  type ClipKind,
  type Project,
  type Sequence,
  type TextProps,
  type Track,
  type TrackKind,
} from './types';

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function createTrack(kind: TrackKind, name: string): Track {
  return { id: uid('tr'), kind, name, muted: false, hidden: false, locked: false };
}

export const DEFAULT_TEXT: TextProps = {
  content: 'テキストを入力',
  fontFamily: '"Noto Sans JP", system-ui, sans-serif',
  fontSize: 64,
  weight: 900,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 6,
  bgColor: '#000000',
  bgOpacity: 0,
  shadow: 12,
  align: 'center',
  lineHeight: 1.25,
  letterSpacing: 0,
  maxWidth: 0.82,
  animation: 'pop',
  animationDuration: 0.4,
};

export function baseClip(kind: ClipKind, trackId: string): Clip {
  return {
    id: uid('cl'),
    trackId,
    kind,
    mediaId: null,
    start: 0,
    duration: 3,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    muted: false,
    loop: false,
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotate: 0,
    fit: 'cover',
    bgBlur: { ...DEFAULT_BG_BLUR },
    crop: { ...DEFAULT_CROP },
    effects: [],
    fadeIn: 0,
    fadeOut: 0,
    transitionIn: { type: 'none', duration: 0.5 },
    text: null,
  };
}

/** V1/V2 のように、種類ごとの連番を振る。 */
export function nextTrackName(tracks: Track[], kind: TrackKind): string {
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T';
  return `${prefix}${tracks.filter((t) => t.kind === kind).length + 1}`;
}

export function createSequence(): Sequence {
  const preset = ASPECT_PRESETS[0];
  // 下から V1 → V2、テキストは常に最前面。
  const tracks: Track[] = [
    createTrack('video', 'V1'),
    createTrack('video', 'V2'),
    createTrack('text', 'T1'),
    createTrack('audio', 'A1'),
    createTrack('audio', 'A2'),
  ];
  return {
    fps: 30,
    aspect: preset.key,
    width: preset.width,
    height: preset.height,
    background: '#000000',
    tracks,
    clips: [],
  };
}

export function createProject(name = 'ショート動画'): Project {
  return { name, sequence: createSequence() };
}

/** 素材からクリップを作る（画像は既定の表示秒数を持たせる）。 */
export function clipFromAsset(
  asset: { id: string; kind: 'video' | 'image' | 'audio'; duration: number },
  trackId: string,
  start: number,
  imageDuration = 3,
): Clip {
  const kind = asset.kind === 'image' ? 'image' : asset.kind;
  return {
    ...baseClip(kind, trackId),
    mediaId: asset.id,
    start: Math.max(0, start),
    duration: asset.kind === 'image' ? imageDuration : Math.max(0.2, asset.duration),
  };
}

export function textClip(trackId: string, start: number, duration = 3, text?: Partial<TextProps>): Clip {
  return {
    ...baseClip('text', trackId),
    start: Math.max(0, start),
    duration,
    text: { ...DEFAULT_TEXT, ...text },
  };
}
