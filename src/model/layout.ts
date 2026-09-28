/**
 * 画面を横に分ける寸法の計算。
 *
 * 切り抜き動画でよく使う「上に見出し・中に本編・下に顔」の 3 分割は、
 * 高さの比を **黄金比（1 : φ² : φ）** で取ると落ち着く。1080×1920 なら
 * 366 : 960 : 594 になり、いちばん見たい本編がちょうど真ん中の半分を占める。
 *
 * 型以外を import していないので、Node がこのファイルをそのまま読める。
 * ＝寸法の計算だけをブラウザ抜きで確かめられる。
 */

import type { Crop } from './types';

const PHI = (1 + Math.sqrt(5)) / 2;

export interface Band {
  /** 出力の中での位置と高さ（px）。 */
  y: number;
  h: number;
  /** 同じものを 0〜1 で表したもの（Crop はこちらを使う）。 */
  dy: number;
  dh: number;
}

export interface Bands {
  top: Band;
  middle: Band;
  bottom: Band;
}

/** 動画の高さは偶数でないと扱えない書き出しがある（x264 など）。 */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * 高さを黄金比で 3 つに分ける。
 * 端数は下の帯に寄せて、3 つの合計が必ず元の高さと一致するようにする
 *（1px でも足りないと、帯のあいだに背景の黒が筋になって出る）。
 */
export function goldenBands(height: number): Bands {
  const unit = height / (1 + PHI * PHI + PHI);
  const top = even(unit);
  const middle = even(unit * PHI * PHI);
  const bottom = height - top - middle;
  const band = (y: number, h: number): Band => ({ y, h, dy: y / height, dh: h / height });
  return {
    top: band(0, top),
    middle: band(top, middle),
    bottom: band(top + middle, bottom),
  };
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 元映像から「その縦横比の、いちばん大きい枠」を中心に取る。
 *
 * 帯と同じ比で切り出さないと、絵が縦横につぶれる。
 * `zoom` を上げると枠が小さくなる＝その分だけ寄った絵になる
 *（顔のアップは、これを 4 倍あたりから始めて人が合わせる）。
 */
export function coverSource(
  media: { width: number; height: number },
  aspect: number,
  zoom = 1,
): SourceRect {
  const safeZoom = Math.max(1, zoom);
  const mediaAspect = media.width / media.height;
  // 横長すぎる枠なら高さで頭打ち、縦長すぎる枠なら幅で頭打ちになる。
  let w = mediaAspect > aspect ? media.height * aspect : media.width;
  let h = mediaAspect > aspect ? media.height : media.width / aspect;
  w /= safeZoom;
  h /= safeZoom;
  return {
    sx: (media.width - w) / 2 / media.width,
    sy: (media.height - h) / 2 / media.height,
    sw: w / media.width,
    sh: h / media.height,
  };
}

/** 切り出した絵を、その帯いっぱいに置く切り抜き設定。 */
export function bandCrop(source: SourceRect, band: Band): Crop {
  return {
    enabled: true,
    ...source,
    dx: 0,
    dy: band.dy,
    dw: 1,
    dh: band.dh,
  };
}
