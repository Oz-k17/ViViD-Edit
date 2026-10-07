import type { DragEvent } from 'react';
import { MEDIA_DND_TYPE, MEDIA_LIST_DND_TYPE } from './MultiTimeline';

/**
 * 素材をドラッグし始めるときの共通処理。
 * 選択中の素材をつかんだら選択ぜんぶ、選択外をつかんだらそれ 1 つだけを運ぶ。
 * 運ぶ id は単体用（`MEDIA_DND_TYPE`）と複数用（`MEDIA_LIST_DND_TYPE`）の両方に入れてあるので、
 * 単体しか知らない受け手（古い経路）でもつかんだ 1 つは受け取れる。
 */
export function startAssetDrag(event: DragEvent, assetId: string, selectedIds: string[]) {
  const ids = selectedIds.includes(assetId) ? selectedIds : [assetId];
  event.dataTransfer.setData(MEDIA_DND_TYPE, assetId);
  event.dataTransfer.setData(MEDIA_LIST_DND_TYPE, JSON.stringify(ids));
  event.dataTransfer.effectAllowed = 'copyMove';
}
