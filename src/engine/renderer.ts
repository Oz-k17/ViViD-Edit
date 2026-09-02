/**
 * マルチトラックのフレーム合成器。
 * プレビューと書き出しで同じ関数を使うので、見た目がズレない。
 * 描画は常に「シーケンス座標（例 1080x1920）」で計算し、出力解像度の差は ctx のスケールで吸収する。
 */

import { clipAtTime, previousAdjacent } from '../model/ops';
import {
  clipEnd,
  contentAtomCount,
  sourceTimeAt,
  splitTextContent,
  truncateAtoms,
  type Clip,
  type ContentSegment,
  type Effect,
  type Sequence,
  type TextProps,
  type Track,
} from '../model/types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderSources {
  frameFor(clip: Clip): CanvasImageSource | null;
  sizeFor(clip: Clip): { width: number; height: number } | null;
  /** テロップ内の絵文字（アップロードした画像）を mediaId から解決する。 */
  emojiFor(mediaId: string): HTMLImageElement | null;
}

export interface RenderOptions {
  guides: boolean;
  /** 選択中のクリップに枠を出す（プレビューのみ）。 */
  selectedIds?: string[];
}

const supportsLetterSpacing = (() => {
  if (typeof document === 'undefined') return false;
  const ctx = document.createElement('canvas').getContext('2d');
  return ctx !== null && 'letterSpacing' in ctx;
})();

/** フェードイン / フェードアウトの係数（0〜1）。 */
export function fadeEnvelope(local: number, duration: number, fadeIn: number, fadeOut: number): number {
  let v = 1;
  if (fadeIn > 0) v = Math.min(v, local / fadeIn);
  if (fadeOut > 0) v = Math.min(v, (duration - local) / fadeOut);
  return Math.max(0, Math.min(1, v));
}

export function effectFilter(effects: Effect[], pixelScale: number): string {
  if (effects.length === 0) return 'none';
  const parts: string[] = [];
  for (const effect of effects) {
    const i = Math.max(0, Math.min(1, effect.intensity));
    switch (effect.type) {
      case 'brightness':
        parts.push(`brightness(${(0.4 + i * 1.2).toFixed(3)})`);
        break;
      case 'contrast':
        parts.push(`contrast(${(0.4 + i * 1.2).toFixed(3)})`);
        break;
      case 'saturate':
        parts.push(`saturate(${(i * 2).toFixed(3)})`);
        break;
      case 'grayscale':
        parts.push(`grayscale(${i.toFixed(3)})`);
        break;
      case 'sepia':
        parts.push(`sepia(${i.toFixed(3)})`);
        break;
      case 'hueRotate':
        parts.push(`hue-rotate(${Math.round(i * 360)}deg)`);
        break;
      case 'blur':
        parts.push(`blur(${(i * 30 * pixelScale).toFixed(2)}px)`);
        break;
      case 'invert':
        parts.push(`invert(${i.toFixed(3)})`);
        break;
    }
  }
  return parts.join(' ');
}

/** 素材を画角に収めたうえで、スケールと位置を適用した矩形。 */
export function fitRect(
  sequence: Sequence,
  clip: Clip,
  media: { width: number; height: number },
  mode: 'cover' | 'contain',
  applyTransform = true,
): Rect {
  const { width: W, height: H } = sequence;
  const mw = media.width || W;
  const mh = media.height || H;
  const base = mode === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
  const scale = base * (applyTransform ? clip.scale || 1 : 1);
  const w = mw * scale;
  const h = mh * scale;
  return {
    x: (W - w) / 2 + (applyTransform ? clip.x * W : 0),
    y: (H - h) / 2 + (applyTransform ? clip.y * H : 0),
    w,
    h,
  };
}

/** クロップ有効時に、切り抜きを置く出力側の矩形。 */
export function cropDestRect(sequence: Sequence, clip: Clip): Rect {
  const { width: W, height: H } = sequence;
  const w = clip.crop.dw * W * (clip.scale || 1);
  const h = clip.crop.dh * H * (clip.scale || 1);
  const cx = (clip.crop.dx + clip.crop.dw / 2) * W + clip.x * W;
  const cy = (clip.crop.dy + clip.crop.dh / 2) * H + clip.y * H;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ---------- 背景ぼかし ----------

/**
 * 背景のぼかしを作る。
 *
 * 全解像度のまま ctx.filter = blur(...) をかけると、毎フレームその計算が走って
 * プレビューのコマ落ちの原因になる。ぼかした絵はもともと細部が無いので、
 * 小さく描いてからぼかし、拡大して使っても見た目はほとんど変わらない。
 * ぼかし半径も同じ比率で縮めるので結果は一致する。
 */
const BACKDROP_MAX_EDGE = 160;
let backdropCanvas: HTMLCanvasElement | null = null;

function blurredBackdrop(
  frame: CanvasImageSource,
  targetWidth: number,
  targetHeight: number,
  blurPx: number,
): HTMLCanvasElement | null {
  if (targetWidth <= 0 || targetHeight <= 0) return null;
  const scale = Math.min(1, BACKDROP_MAX_EDGE / Math.max(targetWidth, targetHeight));
  const w = Math.max(1, Math.round(targetWidth * scale));
  const h = Math.max(1, Math.round(targetHeight * scale));

  if (!backdropCanvas) backdropCanvas = document.createElement('canvas');
  const canvas = backdropCanvas;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.filter = `blur(${Math.max(1, blurPx * scale).toFixed(2)}px) brightness(0.6) saturate(1.15)`;
  try {
    // ぼかしで端が透けないよう、少しはみ出させて描く。
    const bleed = Math.max(2, blurPx * scale * 2);
    ctx.drawImage(frame, -bleed, -bleed, w + bleed * 2, h + bleed * 2);
  } catch {
    return null;
  }
  ctx.filter = 'none';
  return canvas;
}

// ---------- 映像 ----------

interface DrawContext {
  sequence: Sequence;
  sources: RenderSources;
  pixelScale: number;
}

function drawVisualClip(
  ctx: CanvasRenderingContext2D,
  dc: DrawContext,
  clip: Clip,
  time: number,
  extraAlpha: number,
  offsetX = 0,
) {
  const frame = dc.sources.frameFor(clip);
  const size = dc.sources.sizeFor(clip);
  if (!frame || !size) return;

  const local = time - clip.start;
  const env = fadeEnvelope(local, clip.duration, clip.fadeIn, clip.fadeOut);
  const alpha = clip.opacity * env * extraAlpha;
  if (alpha <= 0.002) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  if (offsetX) ctx.translate(offsetX, 0);
  if (clip.rotate) {
    ctx.translate(dc.sequence.width / 2, dc.sequence.height / 2);
    ctx.rotate((clip.rotate * Math.PI) / 180);
    ctx.translate(-dc.sequence.width / 2, -dc.sequence.height / 2);
  }

  try {
    // 余白を同じ映像のぼかしで埋める（ショート動画の定番）
    if (clip.bgBlur.enabled) {
      const backdrop = fitRect(dc.sequence, clip, size, 'cover', false);
      const zoom = clip.bgBlur.zoom || 1;
      const bw = backdrop.w * zoom;
      const bh = backdrop.h * zoom;
      const blurred = blurredBackdrop(frame, bw, bh, dc.sequence.width * clip.bgBlur.strength);
      if (blurred) {
        ctx.drawImage(blurred, backdrop.x - (bw - backdrop.w) / 2, backdrop.y - (bh - backdrop.h) / 2, bw, bh);
      }
    }

    ctx.filter = effectFilter(clip.effects, dc.pixelScale);

    if (clip.crop.enabled) {
      const dest = cropDestRect(dc.sequence, clip);
      ctx.drawImage(
        frame,
        clip.crop.sx * size.width,
        clip.crop.sy * size.height,
        Math.max(1, clip.crop.sw * size.width),
        Math.max(1, clip.crop.sh * size.height),
        dest.x,
        dest.y,
        dest.w,
        dest.h,
      );
    } else {
      const mode = clip.bgBlur.enabled ? 'contain' : clip.fit;
      const rect = fitRect(dc.sequence, clip, size, mode);
      ctx.drawImage(frame, rect.x, rect.y, rect.w, rect.h);
    }
  } catch {
    /* デコード待ちなど。次のフレームで描ければよい。 */
  }
  ctx.restore();
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
}

function renderVideoTrack(ctx: CanvasRenderingContext2D, dc: DrawContext, track: Track, time: number) {
  const current = clipAtTime(dc.sequence, track.id, time);
  if (!current) return;

  const transition = current.transitionIn;
  const inTransition =
    transition.type !== 'none' && transition.duration > 0 && time < current.start + transition.duration;
  const previous = inTransition ? previousAdjacent(dc.sequence, current) : null;

  if (!previous) {
    drawVisualClip(ctx, dc, current, time, 1);
    return;
  }

  const p = Math.max(0, Math.min(1, (time - current.start) / transition.duration));
  const W = dc.sequence.width;

  switch (transition.type) {
    case 'fade':
      // 一度背景（黒）を通ってから次のカットへ
      if (p < 0.5) drawVisualClip(ctx, dc, previous, time, 1 - p * 2);
      else drawVisualClip(ctx, dc, current, time, (p - 0.5) * 2);
      break;
    case 'slide':
      drawVisualClip(ctx, dc, previous, time, 1, -p * W);
      drawVisualClip(ctx, dc, current, time, 1, (1 - p) * W);
      break;
    case 'wipe':
      drawVisualClip(ctx, dc, previous, time, 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, p * W, dc.sequence.height);
      ctx.clip();
      drawVisualClip(ctx, dc, current, time, 1);
      ctx.restore();
      break;
    case 'flash':
      drawVisualClip(ctx, dc, previous, time, 1 - p);
      drawVisualClip(ctx, dc, current, time, p);
      ctx.save();
      ctx.globalAlpha = Math.sin(p * Math.PI) * 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, dc.sequence.height);
      ctx.restore();
      break;
    case 'dissolve':
    default:
      drawVisualClip(ctx, dc, previous, time, 1);
      drawVisualClip(ctx, dc, current, time, p);
      break;
  }
}

// ---------- テキスト ----------

/** 折り返し後の1行ぶん。絵文字はテキストと地続きに並ぶ1つのトークンとして扱う。 */
type LineToken = { text: string } | { emoji: string };

/** 絵文字は正方形の枠に収める分、ここでは常にこの幅として折り返し計算する。 */
function lineWidth(ctx: CanvasRenderingContext2D, tokens: LineToken[], emojiSize: number): number {
  let w = 0;
  for (const t of tokens) w += 'emoji' in t ? emojiSize : ctx.measureText(t.text).width;
  return w;
}

function wrapContent(
  ctx: CanvasRenderingContext2D,
  segments: ContentSegment[],
  maxWidth: number,
  emojiSize: number,
): LineToken[][] {
  const lines: LineToken[][] = [];
  let line: LineToken[] = [];
  let width = 0;

  const breakLine = () => {
    // 折り返した行の末尾に空白だけが残っていると、幅の計算や中央寄せがずれる。
    while (line.length > 0) {
      const last = line[line.length - 1];
      if (!('text' in last) || !/^\s+$/.test(last.text)) break;
      width -= ctx.measureText(last.text).width;
      line.pop();
    }
    lines.push(line);
    line = [];
    width = 0;
  };

  const place = (token: LineToken, w: number) => {
    line.push(token);
    width += w;
  };

  const placeWord = (raw: string) => {
    let word = raw;
    let w = ctx.measureText(word).width;
    if (width > 0 && width + w > maxWidth) {
      breakLine();
      word = word.trimStart();
      if (word === '') return;
      w = ctx.measureText(word).width;
    }
    if (width === 0 && w > maxWidth) {
      // 単語1つで折り返し幅を超える → 文字単位で折る（日本語など単語区切りが無い場合）。
      let chunk = '';
      for (const ch of word) {
        if (chunk !== '' && ctx.measureText(chunk + ch).width > maxWidth) {
          place({ text: chunk }, ctx.measureText(chunk).width);
          breakLine();
          chunk = '';
        }
        chunk += ch;
      }
      if (chunk) place({ text: chunk }, ctx.measureText(chunk).width);
      return;
    }
    place({ text: word }, w);
  };

  const placeEmoji = (id: string) => {
    if (width > 0 && width + emojiSize > maxWidth) breakLine();
    place({ emoji: id }, emojiSize);
  };

  for (const seg of segments) {
    if ('emoji' in seg) {
      placeEmoji(seg.emoji);
      continue;
    }
    seg.text.split('\n').forEach((paragraph, i) => {
      if (i > 0) breakLine();
      if (paragraph === '') return;
      const words = paragraph.match(/\S+\s*|\s+/g) ?? [paragraph];
      words.forEach(placeWord);
    });
  }
  lines.push(line);
  return lines;
}

interface TextAnim {
  alpha: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  visibleChars: number | null;
}

function textAnimation(text: TextProps, local: number, duration: number): TextAnim {
  const anim: TextAnim = { alpha: 1, scale: 1, offsetX: 0, offsetY: 0, visibleChars: null };
  const inDur = Math.max(0.05, Math.min(text.animationDuration, duration / 2));
  const outDur = Math.min(0.25, duration / 2);
  const tIn = Math.max(0, Math.min(1, local / inDur));
  const tOut = Math.max(0, Math.min(1, (duration - local) / outDur));
  const ease = 1 - Math.pow(1 - tIn, 3);

  switch (text.animation) {
    case 'fade':
      anim.alpha = Math.min(tIn, tOut);
      break;
    case 'pop':
      anim.scale = 0.6 + 0.4 * ease + Math.sin(tIn * Math.PI) * 0.09;
      anim.alpha = Math.min(1, tIn * 2, tOut * 2);
      break;
    case 'zoom':
      anim.scale = 1.6 - 0.6 * ease;
      anim.alpha = Math.min(1, tIn * 1.6, tOut * 2);
      break;
    case 'bounce': {
      const bounce = tIn >= 1 ? 1 : 1 - Math.pow(2, -9 * tIn) * Math.abs(Math.cos(tIn * Math.PI * 2.4));
      anim.offsetY = (1 - bounce) * -140;
      anim.alpha = Math.min(1, tIn * 3, tOut * 2);
      break;
    }
    case 'slideUp':
      anim.offsetY = (1 - ease) * 110;
      anim.alpha = Math.min(1, tIn * 1.6, tOut * 2);
      break;
    case 'slideDown':
      anim.offsetY = (1 - ease) * -110;
      anim.alpha = Math.min(1, tIn * 1.6, tOut * 2);
      break;
    case 'slideLeft':
      anim.offsetX = (1 - ease) * 220;
      anim.alpha = Math.min(1, tIn * 1.6, tOut * 2);
      break;
    case 'slideRight':
      anim.offsetX = (1 - ease) * -220;
      anim.alpha = Math.min(1, tIn * 1.6, tOut * 2);
      break;
    case 'typewriter': {
      // 絵文字は1文字ぶんとして数える（トークン文字列の途中半端な位置で切れないように）。
      const chars = contentAtomCount(splitTextContent(text.content));
      const speed = Math.min(duration * 0.6, chars * 0.045);
      anim.visibleChars = speed <= 0 ? chars : Math.ceil((local / speed) * chars);
      anim.alpha = Math.min(1, tOut * 2);
      break;
    }
    default:
      break;
  }
  return anim;
}

/** 絵文字画像を、縦横比を保ったまま size 四方の枠へ収めて描く（実際の文字の1文字ぶんの見た目に合わせる）。 */
function drawEmojiGlyph(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, yMid: number, size: number) {
  const iw = img.naturalWidth || size;
  const ih = img.naturalHeight || size;
  if (!iw || !ih) return;
  const scale = Math.min(size / iw, size / ih);
  const w = iw * scale;
  const h = ih * scale;
  try {
    ctx.drawImage(img, x + (size - w) / 2, yMid - h / 2, w, h);
  } catch {
    /* デコード待ちなど。次のフレームで描ければよい。 */
  }
}

function drawTextClip(
  ctx: CanvasRenderingContext2D,
  sequence: Sequence,
  clip: Clip,
  time: number,
  bounds: Map<string, Rect>,
  sources: RenderSources,
) {
  const text = clip.text;
  if (!text) return;
  const local = time - clip.start;
  const anim = textAnimation(text, local, clip.duration);
  const env = fadeEnvelope(local, clip.duration, clip.fadeIn, clip.fadeOut);
  const alpha = anim.alpha * clip.opacity * env;
  if (alpha <= 0.002) return;

  const allSegments = splitTextContent(text.content);
  const segments = anim.visibleChars === null ? allSegments : truncateAtoms(allSegments, anim.visibleChars);
  const fontSize = text.fontSize * (clip.scale || 1);
  // 絵文字は正方形の枠として、だいたい大文字1文字ぶんの見た目の大きさに合わせる。
  const emojiSize = fontSize * 1.05;

  ctx.save();
  ctx.font = `${text.weight} ${fontSize}px ${text.fontFamily}`;
  if (supportsLetterSpacing) ctx.letterSpacing = `${text.letterSpacing}px`;
  ctx.textBaseline = 'middle';

  const lines = wrapContent(ctx, segments.length ? segments : [{ text: ' ' }], sequence.width * text.maxWidth, emojiSize);
  const lineHeight = fontSize * text.lineHeight;
  const blockHeight = lineHeight * lines.length;
  const widths = lines.map((line) => lineWidth(ctx, line, emojiSize));
  const blockWidth = Math.max(1, ...widths);

  const cx = (0.5 + clip.x) * sequence.width + anim.offsetX;
  const cy = (0.5 + clip.y) * sequence.height + anim.offsetY;

  ctx.translate(cx, cy);
  ctx.rotate((clip.rotate * Math.PI) / 180);
  ctx.scale(anim.scale, anim.scale);
  ctx.globalAlpha = alpha;

  const padX = fontSize * 0.34;
  const padY = fontSize * 0.2;

  if (text.bgOpacity > 0) {
    ctx.save();
    ctx.globalAlpha = alpha * text.bgOpacity;
    ctx.fillStyle = text.bgColor;
    lines.forEach((line, i) => {
      if (line.length === 0) return;
      const w = widths[i] + padX * 2;
      const y = -blockHeight / 2 + i * lineHeight;
      const x =
        text.align === 'left' ? -blockWidth / 2 - padX : text.align === 'right' ? blockWidth / 2 - w + padX : -w / 2;
      roundRect(ctx, x, y, w, lineHeight, fontSize * 0.18);
      ctx.fill();
    });
    ctx.restore();
  }

  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // 絵文字とテキストをトークンごとに手で並べていくため、canvas 側の揃えは使わず常に left 基準で描く。
  ctx.textAlign = 'left';

  lines.forEach((line, i) => {
    const y = -blockHeight / 2 + i * lineHeight + lineHeight / 2;
    const w = widths[i];
    let x = text.align === 'left' ? -blockWidth / 2 : text.align === 'right' ? blockWidth / 2 - w : -w / 2;

    for (const token of line) {
      if ('emoji' in token) {
        const img = sources.emojiFor(token.emoji);
        if (img) drawEmojiGlyph(ctx, img, x, y, emojiSize);
        x += emojiSize;
        continue;
      }
      if (text.shadow > 0) {
        ctx.shadowColor = 'rgba(0,0,0,0.65)';
        ctx.shadowBlur = text.shadow;
        ctx.shadowOffsetY = text.shadow * 0.25;
      }
      if (text.strokeWidth > 0) {
        ctx.strokeStyle = text.strokeColor;
        ctx.lineWidth = text.strokeWidth * 2;
        ctx.strokeText(token.text, x, y);
      }
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.fillStyle = text.color;
      ctx.fillText(token.text, x, y);
      x += ctx.measureText(token.text).width;
    }
  });

  ctx.restore();

  bounds.set(clip.id, {
    x: cx - (blockWidth + padX * 2) / 2,
    y: cy - (blockHeight + padY) / 2,
    w: blockWidth + padX * 2,
    h: blockHeight + padY,
  });
}

// ---------- ガイド ----------

function drawGuides(ctx: CanvasRenderingContext2D, sequence: Sequence) {
  const { width: W, height: H } = sequence;
  ctx.save();
  ctx.strokeStyle = 'rgba(231,229,223,0.3)';
  ctx.lineWidth = Math.max(1, W / 540);
  ctx.setLineDash([W / 60, W / 60]);
  // SNS の UI（上部ヘッダ / 下部キャプション / 右のボタン列）に隠れやすい範囲
  ctx.beginPath();
  ctx.moveTo(0, H * 0.08);
  ctx.lineTo(W, H * 0.08);
  ctx.moveTo(0, H * 0.82);
  ctx.lineTo(W, H * 0.82);
  ctx.moveTo(W * 0.82, 0);
  ctx.lineTo(W * 0.82, H);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(231,229,223,0.14)';
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.restore();
}

function outline(ctx: CanvasRenderingContext2D, sequence: Sequence, rect: Rect, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, sequence.width / 360);
  ctx.setLineDash([sequence.width / 90, sequence.width / 120]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/**
 * 1 フレーム描画する。返り値は当たり判定用の矩形（シーケンス座標）。
 * テキストは clip.id、クロップ枠は `crop:<clip.id>` をキーにしている。
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  sequence: Sequence,
  time: number,
  sources: RenderSources,
  options: RenderOptions,
): Map<string, Rect> {
  const pixelScale = ctx.canvas.width / sequence.width;
  ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.fillStyle = sequence.background;
  ctx.fillRect(0, 0, sequence.width, sequence.height);

  const dc: DrawContext = { sequence, sources, pixelScale };
  const bounds = new Map<string, Rect>();
  const selected = options.selectedIds ?? [];

  for (const track of sequence.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    renderVideoTrack(ctx, dc, track, time);
  }

  for (const track of sequence.tracks) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const clip of sequence.clips) {
      if (clip.trackId !== track.id) continue;
      if (time < clip.start || time >= clipEnd(clip)) continue;
      drawTextClip(ctx, sequence, clip, time, bounds, sources);
    }
  }

  // 選択中クリップの枠（クロップ中は切り抜きの配置枠を出す）
  for (const id of selected) {
    const clip = sequence.clips.find((c) => c.id === id);
    if (!clip) continue;
    if (time < clip.start || time >= clipEnd(clip)) continue;
    if (clip.crop.enabled && clip.kind !== 'text') {
      const rect = cropDestRect(sequence, clip);
      bounds.set(`crop:${clip.id}`, rect);
      outline(ctx, sequence, rect, '#e0b184');
    } else {
      const rect = bounds.get(clip.id);
      if (rect) outline(ctx, sequence, rect, '#cfe0cb');
    }
  }

  if (options.guides) drawGuides(ctx, sequence);
  return bounds;
}

export { sourceTimeAt };
