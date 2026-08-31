/**
 * フレーム合成器。プレビューと書き出しで同じ関数を使う（見た目のズレを防ぐため）。
 * 描画座標は常に「プロジェクト座標（例: 1080x1920）」で計算し、
 * 出力解像度の違いは ctx のスケールだけで吸収する。
 */

import { clipAt, clipDuration, type Clip, type Project, type TextOverlay } from '../types';
import { fadeEnvelope } from './audio';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderContext {
  /** クリップに対応する描画ソース（<video> か <img>）。まだ準備できていなければ null。 */
  frameFor(clip: Clip): CanvasImageSource | null;
  /** ソースの実寸。 */
  sizeFor(clip: Clip): { width: number; height: number } | null;
}

export interface RenderOptions {
  guides: boolean;
  /** 選択中のテキストに枠を出す（プレビューのみ）。 */
  highlightTextId?: string | null;
}

const supportsLetterSpacing = (() => {
  if (typeof document === 'undefined') return false;
  const ctx = document.createElement('canvas').getContext('2d');
  return ctx !== null && 'letterSpacing' in ctx;
})();

export function filterString(clip: Clip, pixelScale: number): string {
  const f = clip.filters;
  const parts: string[] = [];
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`);
  if (f.grayscale > 0) parts.push(`grayscale(${f.grayscale})`);
  if (f.sepia > 0) parts.push(`sepia(${f.sepia})`);
  if (f.hueRotate !== 0) parts.push(`hue-rotate(${f.hueRotate}deg)`);
  if (f.blur > 0) parts.push(`blur(${(f.blur * pixelScale).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

/** 素材を画角に収めたうえで、ユーザーのズーム / 位置を適用した矩形。 */
export function fitRect(
  project: Project,
  clip: Clip,
  media: { width: number; height: number },
  mode: 'cover' | 'contain',
  applyTransform = true,
): Rect {
  const { width: W, height: H } = project;
  const mw = media.width || W;
  const mh = media.height || H;
  const base = mode === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
  const scale = base * (applyTransform ? clip.transform.scale || 1 : 1);
  const w = mw * scale;
  const h = mh * scale;
  const offsetX = applyTransform ? clip.transform.x * W : 0;
  const offsetY = applyTransform ? clip.transform.y * H : 0;
  return { x: (W - w) / 2 + offsetX, y: (H - h) / 2 + offsetY, w, h };
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

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    let line = '';
    // 日本語は単語区切りが無いので、まず空白で試し、溢れる塊は文字単位で折る。
    const tokens = paragraph.match(/\S+\s*|\s+/g) ?? [paragraph];
    const pushToken = (token: string) => {
      if (ctx.measureText(line + token).width <= maxWidth || line === '') {
        if (ctx.measureText(line + token).width <= maxWidth) {
          line += token;
          return;
        }
        // 1 トークンだけで溢れる → 文字単位
        for (const ch of token) {
          if (line !== '' && ctx.measureText(line + ch).width > maxWidth) {
            out.push(line);
            line = '';
          }
          line += ch;
        }
        return;
      }
      out.push(line.trimEnd());
      line = '';
      pushToken(token.trimStart());
    };
    tokens.forEach(pushToken);
    out.push(line.trimEnd());
  }
  return out;
}

interface TextAnim {
  alpha: number;
  scale: number;
  offsetY: number;
  visibleChars: number | null;
}

function textAnimation(overlay: TextOverlay, local: number): TextAnim {
  const base: TextAnim = { alpha: 1, scale: 1, offsetY: 0, visibleChars: null };
  const d = Math.max(0.01, overlay.duration);
  const inDur = Math.min(0.35, d / 2);
  const outDur = Math.min(0.25, d / 2);
  const tIn = Math.max(0, Math.min(1, local / inDur));
  const tOut = Math.max(0, Math.min(1, (d - local) / outDur));

  switch (overlay.animation) {
    case 'fade':
      base.alpha = Math.min(tIn, tOut);
      break;
    case 'pop': {
      const e = 1 - Math.pow(1 - tIn, 3);
      base.scale = 0.6 + 0.4 * e + Math.sin(tIn * Math.PI) * 0.08;
      base.alpha = Math.min(1, tIn * 2, tOut * 2);
      break;
    }
    case 'slideUp': {
      const e = 1 - Math.pow(1 - tIn, 3);
      base.offsetY = (1 - e) * 90;
      base.alpha = Math.min(1, tIn * 1.6, tOut * 2);
      break;
    }
    case 'typewriter': {
      const chars = overlay.text.length;
      const speed = Math.min(d * 0.6, chars * 0.045);
      base.visibleChars = speed <= 0 ? chars : Math.ceil((local / speed) * chars);
      base.alpha = Math.min(1, tOut * 2);
      break;
    }
    default:
      break;
  }
  return base;
}

function drawText(
  ctx: CanvasRenderingContext2D,
  project: Project,
  overlay: TextOverlay,
  time: number,
  bounds: Map<string, Rect>,
  highlight: boolean,
) {
  const local = time - overlay.start;
  if (local < 0 || local > overlay.duration) return;

  const s = overlay.style;
  const anim = textAnimation(overlay, local);
  if (anim.alpha <= 0.001) return;

  const text = anim.visibleChars === null ? overlay.text : overlay.text.slice(0, Math.max(0, anim.visibleChars));

  ctx.save();
  ctx.font = `${s.weight} ${s.fontSize}px ${s.fontFamily}`;
  if (supportsLetterSpacing) ctx.letterSpacing = `${s.letterSpacing}px`;
  ctx.textBaseline = 'middle';

  const maxWidth = project.width * overlay.maxWidth;
  const lines = wrapLines(ctx, text || ' ', maxWidth);
  const lineHeight = s.fontSize * s.lineHeight;
  const blockHeight = lineHeight * lines.length;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockWidth = Math.max(1, ...widths);

  const cx = overlay.x * project.width;
  const cy = overlay.y * project.height + anim.offsetY;

  ctx.translate(cx, cy);
  ctx.rotate((overlay.rotate * Math.PI) / 180);
  ctx.scale(anim.scale, anim.scale);
  ctx.globalAlpha = anim.alpha;

  const padX = s.fontSize * 0.34;
  const padY = s.fontSize * 0.2;

  if (s.bgOpacity > 0) {
    ctx.save();
    ctx.globalAlpha = anim.alpha * s.bgOpacity;
    ctx.fillStyle = s.bgColor;
    lines.forEach((line, i) => {
      if (!line) return;
      const w = widths[i] + padX * 2;
      const y = -blockHeight / 2 + i * lineHeight;
      const x = s.align === 'left' ? -blockWidth / 2 - padX : s.align === 'right' ? blockWidth / 2 - w + padX : -w / 2;
      roundRect(ctx, x, y, w, lineHeight, s.fontSize * 0.18);
      ctx.fill();
    });
    ctx.restore();
  }

  if (s.shadow > 0) {
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = s.shadow;
    ctx.shadowOffsetY = s.shadow * 0.25;
  }

  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.textAlign = s.align === 'center' ? 'center' : s.align;

  lines.forEach((line, i) => {
    const y = -blockHeight / 2 + i * lineHeight + lineHeight / 2;
    const x = s.align === 'left' ? -blockWidth / 2 : s.align === 'right' ? blockWidth / 2 : 0;
    if (s.strokeWidth > 0) {
      ctx.strokeStyle = s.strokeColor;
      ctx.lineWidth = s.strokeWidth * 2;
      ctx.strokeText(line, x, y);
    }
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
    if (s.shadow > 0) {
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = s.shadow;
    }
  });

  ctx.restore();

  const w = blockWidth + padX * 2;
  const h = blockHeight + padY;
  bounds.set(overlay.id, { x: cx - w / 2, y: cy - h / 2, w, h });

  if (highlight) {
    ctx.save();
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = Math.max(2, project.width / 360);
    ctx.setLineDash([project.width / 90, project.width / 120]);
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
  }
}

function drawGuides(ctx: CanvasRenderingContext2D, project: Project) {
  const { width: W, height: H } = project;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = Math.max(1, W / 540);
  ctx.setLineDash([W / 60, W / 60]);
  // SNS の UI（上部ヘッダ / 下部キャプション / 右のボタン列）に隠れやすい範囲
  const top = H * 0.08;
  const bottom = H * 0.82;
  const right = W * 0.82;
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.lineTo(W, top);
  ctx.moveTo(0, bottom);
  ctx.lineTo(W, bottom);
  ctx.moveTo(right, 0);
  ctx.lineTo(right, H);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * 1 フレーム描画する。返り値はテキストの当たり判定用矩形（プロジェクト座標）。
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  time: number,
  sources: RenderContext,
  options: RenderOptions,
): Map<string, Rect> {
  const canvas = ctx.canvas;
  const pixelScale = canvas.width / project.width;

  ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, project.width, project.height);

  const clip = clipAt(project, time);
  if (clip) {
    const frame = sources.frameFor(clip);
    const size = sources.sizeFor(clip);
    if (frame && size) {
      const fit = clip.fit ?? 'cover';
      const rect = fitRect(project, clip, size, fit === 'cover' ? 'cover' : 'contain');
      ctx.save();
      if (clip.transform.rotate) {
        ctx.translate(project.width / 2, project.height / 2);
        ctx.rotate((clip.transform.rotate * Math.PI) / 180);
        ctx.translate(-project.width / 2, -project.height / 2);
      }
      try {
        if (fit === 'blur') {
          // 余白を同じ映像のぼかしで埋める（横型素材を縦型に転用するときの定番）
          const backdrop = fitRect(project, clip, size, 'cover', false);
          ctx.filter = `blur(${(project.width * 0.05 * pixelScale).toFixed(1)}px) brightness(0.55) saturate(1.2)`;
          ctx.drawImage(frame, backdrop.x, backdrop.y, backdrop.w, backdrop.h);
        }
        ctx.filter = filterString(clip, pixelScale);
        ctx.drawImage(frame, rect.x, rect.y, rect.w, rect.h);
      } catch {
        /* デコード待ちなど。次フレームで描ければよい。 */
      }
      ctx.restore();
      ctx.filter = 'none';
    }

    const dur = clipDuration(clip);
    const env = fadeEnvelope(time - clip.start, dur, clip.fadeIn, clip.fadeOut);
    if (env < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - env;
      ctx.fillStyle = project.background;
      ctx.fillRect(0, 0, project.width, project.height);
      ctx.restore();
    }
  }

  const bounds = new Map<string, Rect>();
  for (const overlay of project.texts) {
    drawText(ctx, project, overlay, time, bounds, options.highlightTextId === overlay.id);
  }

  if (options.guides) drawGuides(ctx, project);
  return bounds;
}
