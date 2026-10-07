import type { Clip } from '../model/types';
import { mediaRegistry } from './media';

/**
 * クリップの元素材の長さ（秒）。トリム・ロール・スリップの「素材が足りるか」の判定に使う。
 * 画像・テロップ・素材が見つからないものは undefined（＝いくらでも伸ばせる）。
 */
export function sourceLengthOf(clip: Clip): number | undefined {
  const asset = mediaRegistry.get(clip.mediaId);
  return asset && asset.kind !== 'image' && asset.duration > 0 ? asset.duration : undefined;
}
