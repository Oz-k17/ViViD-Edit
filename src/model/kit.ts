/**
 * 「自分の型」— いつもの 3 分割の切り抜き位置と見出しの体裁を、1 つにまとめて取っておくもの。
 *
 * 配信の録画は、カメラの位置も画面の並びも毎回ほぼ同じ。それなのに 3 分割を組むたびに、
 * 顔の帯・本編の帯の切り抜き位置を合わせ直していた。一度合わせた 3 分割から型を作れば、
 * 次からは組むときに型を選ぶだけで、同じ位置に切り抜かれる（毎回同じ見た目にもなる）。
 *
 * 切り抜き位置は素材の大きさに対する割合（0〜1）で持つ。違う解像度の録画に当てても、
 * 帯の形（縦横比）に合わせて範囲を直すので、絵は伸びない（`fitSourceToAspect`）。
 */

import { goldenBands, type SourceRect } from './layout';
import type { Clip, Sequence, TextProps } from './types';

export interface KitBands {
  top: SourceRect;
  middle: SourceRect;
  bottom: SourceRect;
}

export interface Kit {
  bands: KitBands;
  /** 見出しの体裁（文言は持たない）。null なら見出しを作らない。 */
  title: Omit<TextProps, 'content'> | null;
}

const EPS = 0.002;

function sourceOf(clip: Clip): SourceRect {
  return { sx: clip.crop.sx, sy: clip.crop.sy, sw: clip.crop.sw, sh: clip.crop.sh };
}

/**
 * 組んである 3 分割（帯の 3 本と、あれば見出し）から型を取り出す。
 * 帯は、置き場所（dy・dh）が黄金比の上・中・下の帯と同じ映像クリップで見分ける。3 本そろわなければ null。
 */
export function captureKit(sequence: Pick<Sequence, 'height'>, clips: Clip[]): Kit | null {
  const bands = goldenBands(sequence.height);
  const find = (band: { dy: number; dh: number }) =>
    clips.find(
      (c) =>
        c.kind === 'video' &&
        c.crop.enabled &&
        Math.abs(c.crop.dy - band.dy) < EPS &&
        Math.abs(c.crop.dh - band.dh) < EPS &&
        Math.abs(c.crop.dw - 1) < EPS,
    );
  const top = find(bands.top);
  const middle = find(bands.middle);
  const bottom = find(bands.bottom);
  if (!top || !middle || !bottom) return null;
  const title = clips.find((c) => c.kind === 'text' && c.text);
  let titleStyle: Kit['title'] = null;
  if (title?.text) {
    const { content: _content, ...rest } = title.text;
    titleStyle = rest;
  }
  return { bands: { top: sourceOf(top), middle: sourceOf(middle), bottom: sourceOf(bottom) }, title: titleStyle };
}

/**
 * 型の切り抜き範囲を、別の素材と帯の形に合わせる。
 * 幅（の割合）を保ち、高さを帯の縦横比から決め直して、素材からはみ出さないよう収める。
 * 置き場所は、端に付けてあればその端に付けたまま、そうでなければ中心を保つ。
 * 同じ解像度の素材なら、型のまま返る。
 */
export function fitSourceToAspect(source: SourceRect, media: { width: number; height: number }, aspect: number): SourceRect {
  const mw = media.width || 1;
  const mh = media.height || 1;
  // 画素で考える（割合のままだと、縦と横で 1 の長さが違う）。
  let w = source.sw * mw;
  let h = w / aspect;
  if (h > mh) {
    h = mh;
    w = h * aspect;
  }
  if (w > mw) {
    w = mw;
    h = w / aspect;
  }
  // 端に付けてあった範囲は、その端に付けたまま（顔のカメラは画面の隅にあることが多い）。
  // そうでなければ中心を保つ。
  const edge = 0.01;
  const place = (start: number, size: number, newSize: number, full: number) => {
    if (start <= edge) return 0;
    if (start + size >= 1 - edge) return full - newSize;
    return (start + size / 2) * full - newSize / 2;
  };
  const x = Math.min(Math.max(0, place(source.sx, source.sw, w, mw)), mw - w);
  const y = Math.min(Math.max(0, place(source.sy, source.sh, h, mh)), mh - h);
  return { sx: x / mw, sy: y / mh, sw: w / mw, sh: h / mh };
}

/** 録画の中で、顔（カメラ）が映っている所。人によって違う。 */
export type FacePosition = 'bottomRight' | 'bottomLeft' | 'topRight' | 'topLeft' | 'center';

export const FACE_POSITIONS: { key: FacePosition; label: string }[] = [
  { key: 'bottomRight', label: '顔は右下' },
  { key: 'bottomLeft', label: '顔は左下' },
  { key: 'topRight', label: '顔は右上' },
  { key: 'topLeft', label: '顔は左上' },
  { key: 'center', label: '顔は真ん中' },
];

/**
 * 顔の帯の切り抜き範囲を、録画の隅（または真ん中）に置く。幅は録画の 1/`zoom`。
 * 隅のものは端に付けてあるので、帯の形に合わせて直しても隅のまま（fitSourceToAspect）。
 */
export function faceSource(position: FacePosition, zoom = 4): SourceRect {
  const w = 1 / Math.max(1, zoom);
  const right = position === 'bottomRight' || position === 'topRight';
  const bottom = position === 'bottomRight' || position === 'bottomLeft';
  if (position === 'center') return { sx: 0.5 - w / 2, sy: 0.5 - w / 2, sw: w, sh: w };
  return { sx: right ? 1 - w : 0, sy: bottom ? 1 - w : 0, sw: w, sh: w };
}

