/**
 * 打点から出た値を、**絵のどこに効かせるか**。本体の `src/engine/renderer.ts` の写し。
 *
 * ## なぜ写しを置くのか（画面に直接書かなかった理由）
 *
 * この試作の出口は「値」なので、9/27 の測定は値が合っているかだけを見ていた。
 * ところが**本体へ差す形（`clip.opacity` → `sampleClipValue(...)`）が正しいかは、
 * 値だけ見ていても分からない**——差す場所を 1 つ間違えても値は正しいままで、
 * 出る絵だけが違う（表紙の画面が 2026-09-23 に踏んだ「書き出した絵がすり替わっても分布は変わらない」と同じ形）。
 *
 * そこで、**絵を作る式をここに 1 本だけ置いて、画面と Node の両方から同じ関数を呼ぶ。**
 * こうしておくと `uitest.mjs` が「画面に出ている矩形」と「Node が計算した矩形」を突き合わせられる。
 * DOM も canvas も要らない形（矩形と透明度を返すだけ）なので、`npm run lab:test` でも回る。
 *
 * ## フェードは打点と掛け算で重なる
 *
 * 本体は `alpha = clip.opacity * fadeEnvelope(...) * extraAlpha` としている。
 * 打点で `opacity` を動かしても**フェードは別に残る**ので、打点 0.5 × フェード 0.5 = 0.25 になる。
 * これは 9/27 の積み残し「打点と、いまあるフェード / テロップの出の関係」の片側で、
 * **どちらを打点で置き換えるかを決める前に、重なったときの見え方を測れるようにしてある。**
 */

import { sampleClipValue, type AnimatedTrack, type ClipTiming } from './track.ts';

/** 動かせる値。**1 本だけ打点を持ち、残りは素の数**という形をそのまま表している。 */
export interface ValueTracks {
  scale: AnimatedTrack;
  x: AnimatedTrack;
  y: AnimatedTrack;
  opacity: AnimatedTrack;
}

export type ValueName = keyof ValueTracks;

/** 値ごとの「無いときの既定」。`sampleAnimated()` の `fallback` に渡すもの。 */
export const VALUE_FALLBACK: Record<ValueName, number> = { scale: 1, x: 0, y: 0, opacity: 1 };

/** 値ごとの、画面のつまみで動かせる幅（`x`・`y` は画角に対する割合）。 */
export const VALUE_RANGE: Record<ValueName, { min: number; max: number }> = {
  scale: { min: 0.2, max: 3 },
  x: { min: -0.5, max: 0.5 },
  y: { min: -0.5, max: 0.5 },
  opacity: { min: 0, max: 1 },
};

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** フェードの係数（0〜1）。本体の `fadeEnvelope()` と同じ式。 */
export function fadeEnvelope(local: number, duration: number, fadeIn: number, fadeOut: number): number {
  let v = 1;
  if (fadeIn > 0) v = Math.min(v, local / fadeIn);
  if (fadeOut > 0) v = Math.min(v, (duration - local) / fadeOut);
  return Math.max(0, Math.min(1, v));
}

/**
 * 素材を画角に収めたうえで、拡大と位置を当てた矩形。本体の `fitRect()` と同じ式。
 *
 * `cover`（余りを出さずに埋める）だけを写してある。`contain` は式の `max` が `min` になるだけで、
 * **打点の効き方は変わらない**ので、写す意味が無い。
 */
export function fitRect(canvas: Size, media: Size, scale: number, x: number, y: number): Rect {
  const mw = media.width || canvas.width;
  const mh = media.height || canvas.height;
  const base = Math.max(canvas.width / mw, canvas.height / mh);
  const w = mw * base * scale;
  const h = mh * base * scale;
  return {
    x: (canvas.width - w) / 2 + x * canvas.width,
    y: (canvas.height - h) / 2 + y * canvas.height,
    w,
    h,
  };
}

/** フェードの秒（本体の `Clip` が持っているもの）。 */
export interface FadeTiming {
  fadeIn: number;
  fadeOut: number;
}

export interface Composed {
  /** その時刻の 4 値。**打点を持たない値はここで素の数がそのまま出る。** */
  values: Record<ValueName, number>;
  /** 絵を置く矩形（拡大と位置を当てたあと）。 */
  rect: Rect;
  /** フェードの係数だけ。打点との掛け算を画面に出すために分けてある。 */
  fade: number;
  /** 実際に描くときの透明度（打点 × フェード）。 */
  alpha: number;
  /** 出ている素材の秒（合成の絵に焼いて、`source` の打点が本当に絵に付くかを目で見るため）。 */
  sourceTime: number;
}

/**
 * その時刻の絵を決める。**本体の `drawVisualClip()` が 1 コマぶんにやっていることと同じ順序。**
 *
 * `applyFade` を切れるようにしてあるのは、**打点だけの効きと、重なったあとを見比べるため。**
 */
export function composeAt(
  clip: ClipTiming & FadeTiming,
  tracks: ValueTracks,
  time: number,
  canvas: Size,
  media: Size,
  applyFade = true,
): Composed {
  const values = {
    scale: sampleClipValue(clip, tracks.scale, time, VALUE_FALLBACK.scale),
    x: sampleClipValue(clip, tracks.x, time, VALUE_FALLBACK.x),
    y: sampleClipValue(clip, tracks.y, time, VALUE_FALLBACK.y),
    opacity: sampleClipValue(clip, tracks.opacity, time, VALUE_FALLBACK.opacity),
  };
  const fade = applyFade
    ? fadeEnvelope(time - clip.start, clip.duration, clip.fadeIn, clip.fadeOut)
    : 1;
  return {
    values,
    rect: fitRect(canvas, media, values.scale, values.x, values.y),
    fade,
    alpha: values.opacity * fade,
    sourceTime: clip.sourceIn + Math.max(0, time - clip.start) * (clip.speed || 1),
  };
}
