/**
 * 台紙の見出しに置く印を、canvas に直に引く。
 *
 * 画面の部品としてのアイコンは `components/Icon.tsx`（React の SVG）だが、
 * 動画の中に焼き込むほうは canvas なので、同じ SVG は使えない。
 * そこで **lucide が持っている形のデータ**（path / circle / line …）を読んで、
 * canvas の命令に置き換えている。絵は 1 か所（lucide）から来るので、
 * 画面のアイコンと動画のアイコンで形がずれることはない。
 *
 * lucide-react が公に出しているのは React 部品だけなので、ここだけ内部の
 * 名前（`__iconData`）に触れている。名前が変わればビルドで落ちるので、
 * 黙ってアイコンが消えることはない。
 */

import { __iconData as messageCircle } from 'lucide-react/dist/esm/icons/message-circle.mjs';
import { __iconData as languages } from 'lucide-react/dist/esm/icons/languages.mjs';
import { __iconData as star } from 'lucide-react/dist/esm/icons/star.mjs';
import { __iconData as heart } from 'lucide-react/dist/esm/icons/heart.mjs';
import { __iconData as info } from 'lucide-react/dist/esm/icons/info.mjs';
import { __iconData as triangleAlert } from 'lucide-react/dist/esm/icons/triangle-alert.mjs';
import { __iconData as quote } from 'lucide-react/dist/esm/icons/quote.mjs';
import { __iconData as megaphone } from 'lucide-react/dist/esm/icons/megaphone.mjs';
import { __iconData as sparkles } from 'lucide-react/dist/esm/icons/sparkles.mjs';

export type CardIconName =
  | 'message-circle'
  | 'languages'
  | 'star'
  | 'heart'
  | 'info'
  | 'triangle-alert'
  | 'quote'
  | 'megaphone'
  | 'sparkles';

type IconNode = [string, Record<string, string | number>][];

const NODES: Record<CardIconName, IconNode> = {
  'message-circle': messageCircle.node,
  languages: languages.node,
  star: star.node,
  heart: heart.node,
  info: info.node,
  'triangle-alert': triangleAlert.node,
  quote: quote.node,
  megaphone: megaphone.node,
  sparkles: sparkles.node,
};

export const CARD_ICON_LABELS: Record<CardIconName, string> = {
  'message-circle': 'コメント',
  languages: 'ことば',
  star: '星',
  heart: 'ハート',
  info: 'お知らせ',
  'triangle-alert': '注意',
  quote: '引用',
  megaphone: '告知',
  sparkles: 'きらめき',
};

export const CARD_ICON_NAMES = Object.keys(NODES) as CardIconName[];

const num = (value: string | number | undefined, fallback = 0): number =>
  value === undefined ? fallback : typeof value === 'number' ? value : Number.parseFloat(value);

/**
 * 印を 1 つ引く。`size` は 1 辺の大きさ（元の絵は 24 の枠に入っている）。
 * 中心が (cx, cy) に来るように置く。
 */
export function drawCardIcon(
  ctx: CanvasRenderingContext2D,
  /** 名前は保存ファイル由来の文字列。知らない名前なら何も引かない。 */
  name: string,
  cx: number,
  cy: number,
  size: number,
  color: string,
  strokeWidth = 2,
): void {
  const node = NODES[name as CardIconName];
  if (!node) return;
  const scale = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = 'none';
  // 線の太さは 24 の枠での値。拡大しても見た目の太さが比例するので、書体と同じ振る舞いになる。
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  for (const [tag, attrs] of node) {
    ctx.beginPath();
    switch (tag) {
      case 'path':
        // Path2D はブラウザにしか無い。ここは canvas 専用の道なので前提にしてよい。
        ctx.stroke(new Path2D(String(attrs.d)));
        continue;
      case 'circle':
        ctx.arc(num(attrs.cx), num(attrs.cy), num(attrs.r), 0, Math.PI * 2);
        break;
      case 'ellipse':
        ctx.ellipse(num(attrs.cx), num(attrs.cy), num(attrs.rx), num(attrs.ry), 0, 0, Math.PI * 2);
        break;
      case 'rect': {
        const r = num(attrs.rx, 0);
        const x = num(attrs.x);
        const y = num(attrs.y);
        const w = num(attrs.width);
        const h = num(attrs.height);
        if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
        else ctx.rect(x, y, w, h);
        break;
      }
      case 'line':
        ctx.moveTo(num(attrs.x1), num(attrs.y1));
        ctx.lineTo(num(attrs.x2), num(attrs.y2));
        break;
      case 'polyline':
      case 'polygon': {
        const points = String(attrs.points)
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        for (let i = 0; i + 1 < points.length; i += 2) {
          if (i === 0) ctx.moveTo(points[0], points[1]);
          else ctx.lineTo(points[i], points[i + 1]);
        }
        if (tag === 'polygon') ctx.closePath();
        break;
      }
      default:
        continue;
    }
    ctx.stroke();
  }
  ctx.restore();
}
