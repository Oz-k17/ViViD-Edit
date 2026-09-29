/**
 * 書き起こしと素材から、**編集済みのプロジェクトを組み立てる**。
 *
 * 狙いは「自動で組む → 気に入らない所だけ人が直す」という流れ。
 * だからここは**完成品を作らない**。人が直しやすい形で置くことを優先する。
 * 具体的には、テロップを 1 行ずつ別のクリップにして、
 * 後から 1 行だけ消す・書き換えるのが手数 1 で済むようにしてある。
 *
 * 画面にも React にも依存していない。**アプリの外（node）からも同じ物を呼べる**ので、
 * 手元で組み立てて `.vivid.json` を吐き、アプリで開く、という使い方ができる。
 */

import { clipFromAsset, createProject, textClip, uid } from './factory';
import { coverSource } from './layout';
import { addTrack, placeClip, tracksOf } from './ops';
import { buildThreeBand } from './threeBand';
import { buildCaptionClips, clipTimeline, tidyCues, type Cue } from './transcript';
import { SPEAKERS, type Clip, type Project, type TextProps } from './types';

/** 組み立てに要る素材の情報。実体は要らない（在り処と寸法だけ）。 */
export interface SourceMedia {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  /** 素材フォルダからの相対パス。アプリはこれで同じ物を開く。 */
  src: string;
  width: number;
  height: number;
  duration: number;
}

export interface AutoEditOptions {
  /** プロジェクトの名前。 */
  name?: string;
  /** 素材のどこからどこまでを使うか（秒）。省くと丸ごと。 */
  from?: number;
  to?: number;
  /** 画の組み方。'full' は 1 枚、'three' は上下に分けた 3 段。 */
  layout?: 'full' | 'three';
  /** テロップの体裁。 */
  captionStyle?: Partial<TextProps>;
  /** 見出しの体裁。渡さなければ見出しを置かない。 */
  titleStyle?: Partial<TextProps>;
  /** 見出しの文言。 */
  title?: string;
  /** 話者ごとの文字色。 */
  speakerColors?: Record<string, string>;
  /** 1 枚のテロップに入れる文字数の上限。 */
  maxChars?: number;
  /** 短い行を読める長さまで伸ばすか。 */
  extendShort?: boolean;
  /** 顔の帯の寄せ具合（'three' のとき）。 */
  faceZoom?: number;
}

export interface AutoEditResult {
  project: Project;
  /** 置いたテロップの数。 */
  captions: number;
  /** 使った範囲（秒）。 */
  span: { from: number; to: number };
  /** 人に確かめてほしい所。黙って完成扱いにしないための覚え書き。 */
  notes: string[];
}

/**
 * 組み立てる。
 *
 * @param media  素材。`src` は**アプリ側の素材フォルダから見た相対パス**にすること。
 *               ここがずれると、開いた側で絵が出ない。
 * @param cues   書き起こし（素材の頭からの時刻）。
 */
export function buildAutoEdit(media: SourceMedia, cues: Cue[], options: AutoEditOptions = {}): AutoEditResult {
  const notes: string[] = [];
  const total = media.duration > 0 ? media.duration : 0;
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(total || Infinity, options.to ?? (total || Infinity));
  if (!(to > from)) {
    throw new Error(`使う範囲が空です（${from} 〜 ${to} 秒）。--from / --to を見直してください。`);
  }

  const project = createProject(options.name ?? media.name.replace(/\.[^.]+$/, ''));
  let sequence = project.sequence;

  // 1) 素材を 1 本置く。使う範囲だけを切り出す。
  const video = tracksOf(sequence, 'video')[0];
  const base: Clip = {
    ...clipFromAsset({ id: media.id, kind: media.kind, duration: media.duration }, video.id, 0),
    sourceIn: from,
    duration: to - from,
  };
  sequence = placeClip(sequence, base);

  // 2) 画の組み方。
  if (options.layout === 'three') {
    sequence = buildThreeBand(sequence, base, { width: media.width, height: media.height }, {
      faceZoom: options.faceZoom,
    });
    notes.push('3 段の切り出し位置は中心から取ってあります。顔の帯はクロップでつまんで合わせてください。');
  } else if (media.width > 0 && media.height > 0) {
    // 横長をそのまま縦へ入れると小さくなるので、画角を覆うところまで寄せておく。
    const crop = coverSource({ width: media.width, height: media.height }, sequence.width / sequence.height);
    sequence = {
      ...sequence,
      clips: sequence.clips.map((c) => (c.id === base.id ? { ...c, crop: { ...c.crop, ...crop, enabled: true } } : c)),
    };
    notes.push('画は中心から切り出してあります。人が端に寄っているなら、クロップで動かしてください。');
  }

  // 3) テロップ。素材の中の時刻を、タイムライン上の時刻へ移してから置く。
  const moved = clipTimeline(cues, { start: 0, sourceIn: from, duration: to - from, speed: 1 });
  const tidy = tidyCues(moved, { maxChars: options.maxChars, extendShort: options.extendShort });
  if (tidy.cues.length === 0) {
    notes.push('この範囲には書き起こしの行がありませんでした。テロップは空です。');
  }
  sequence = buildCaptionClips(sequence, tidy.cues, SPEAKERS, {
    style: options.captionStyle,
    speakerColors: options.speakerColors,
    trackName: '字幕',
  });
  if (tidy.stillShort > 0) {
    notes.push(`${tidy.stillShort} 行は次の行が近く、読める長さに届いていません。間引くか言い回しを縮めてください。`);
  }

  // 4) 見出し。字幕なしで書き出しても残るよう、役割は「飾り」にする。
  if (options.title && options.titleStyle) {
    const track = tracksOf(sequence, 'text')[0] ?? null;
    const trackId = track ? track.id : (sequence = addTrack(sequence, 'text', '見出し'), tracksOf(sequence, 'text')[0].id);
    const clip: Clip = {
      ...textClip(trackId, 0, Math.min(3.5, to - from), {
        ...options.titleStyle,
        content: options.title,
        role: 'design',
      }),
      id: uid('cl'),
      y: -0.32,
    };
    sequence = placeClip(sequence, clip);
  }

  const captions = sequence.clips.filter(
    (c) => c.kind === 'text' && (c.text?.role ?? 'caption') === 'caption',
  ).length;

  return { project: { ...project, sequence }, captions, span: { from, to }, notes };
}

/** そのまま `.vivid.json` として書ける形に畳む。中身はアプリの `project-file.ts` と同じ。 */
export function toProjectFile(result: AutoEditResult, media: SourceMedia, version = 1) {
  return {
    app: 'vivid-edit' as const,
    version,
    savedAt: Date.now(),
    project: result.project,
    assets: [
      {
        id: media.id,
        name: media.name,
        kind: media.kind,
        src: media.src,
        width: media.width,
        height: media.height,
        duration: media.duration,
        // 一覧の見た目のためのもの。無くても開ける。
        thumbnail: '',
        size: 0,
      },
    ],
    localOnly: [] as string[],
  };
}
