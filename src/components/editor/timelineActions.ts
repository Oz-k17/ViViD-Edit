import { useMemo } from 'react';
import { player } from '../../engine/player';
import { sourceLengthOf } from '../../engine/sourceLength';
import {
  closeGapsAt,
  extractRange,
  liftRange,
  nextEditPoint,
  prevEditPoint,
  unlockedTrackIds,
} from '../../model/editOps';
import { nudgeByMode } from '../../model/editModes';
import { copyClips, duplicateClips, pasteClips, type ClipBundle } from '../../model/clipboard';
import { removeClips, splitAt } from '../../model/ops';
import { useApp } from '../../store/app';
import { toast } from '../Toast';
import { useEditor } from '../../store/editor';

/**
 * コピーしたクリップの束。画面を切り替えても（スマホのシート・まとめたクリップの出入り）残るよう、部品の外に持つ。
 * 端末のクリップボードは使わない（文字のコピーと混ざらないように）。
 */
let clipboard: ClipBundle | null = null;
/** 貼り付けられるものがあるか。 */
export function hasClipboard(): boolean {
  return clipboard !== null;
}

/** 範囲（In/Out）が使える形か。 */
function validRange(markIn: number | null, markOut: number | null): [number, number] | null {
  return markIn !== null && markOut !== null && markOut - markIn > 0.01 ? [markIn, markOut] : null;
}

/**
 * タイムラインの操作をまとめたもの。キーボード（EditorPage）とツールバー（MultiTimeline）の
 * 両方から同じものを呼ぶ。どれも再生ヘッドや選択を「呼んだ時点で」読む。
 */
export function useTimelineActions() {
  const { sequence, apply, selection, setSelection, editMode, insertMode, markIn, markOut, setMarks } = useEditor();
  const easy = useApp().settings.uiMode === 'easy';

  return useMemo(() => {
    const range = validRange(markIn, markOut);
    return {
      hasRange: range !== null,
      /** 全トラックの再生ヘッド位置で分割（選択に関係なく編集点を追加）。 */
      addEditAll: () => apply((seq) => splitAt(seq, player.time)),
      prevEdit: () => {
        const t = prevEditPoint(sequence, player.time);
        player.seek(t ?? 0);
      },
      nextEdit: () => {
        const t = nextEditPoint(sequence, player.time);
        if (t !== null) player.seek(t);
      },
      /** direction: -1 で左、+1 で右。frames は 1 か 5。 */
      nudge: (direction: -1 | 1, frames: number) =>
        apply(
          (seq) => nudgeByMode(seq, selection, (direction * frames) / (seq.fps || 30), editMode, sourceLengthOf),
          `nudge:${selection.join(',')}`,
        ),
      markIn: () => {
        const t = player.time;
        setMarks(t, markOut !== null && markOut > t ? markOut : null);
      },
      markOut: () => {
        const t = player.time;
        setMarks(markIn !== null && markIn < t ? markIn : null, t);
      },
      clearMarks: () => setMarks(null, null),
      lift: () => {
        if (range) apply((seq) => liftRange(seq, unlockedTrackIds(seq), range[0], range[1]));
      },
      extract: () => {
        if (!range) return;
        apply((seq) => extractRange(seq, unlockedTrackIds(seq), range[0], range[1]));
        setMarks(null, null);
        player.seek(Math.min(player.time, range[0]));
      },
      closeGap: () => apply((seq) => closeGapsAt(seq, player.time, unlockedTrackIds(seq))),
      selectAll: () => setSelection(sequence.clips.map((c) => c.id)),
      /** 再生ヘッドの位置で分割（選んでいれば、選んだものだけ）。 */
      split: () => apply((seq) => splitAt(seq, player.time, selection)),
      /** 削除。「かんたん」では後ろを詰める（穴を残さない）。 */
      remove: () => apply((seq) => removeClips(seq, selection, easy)),
      rippleRemove: () => apply((seq) => removeClips(seq, selection, true)),
      copy: () => {
        const bundle = copyClips(sequence, selection);
        if (!bundle) return;
        clipboard = bundle;
        toast(`${selection.length} 個をコピーしました`);
      },
      cut: () => {
        const bundle = copyClips(sequence, selection);
        if (!bundle) return;
        clipboard = bundle;
        apply((seq) => removeClips(seq, selection, easy));
      },
      /** 再生ヘッドの位置へ貼る。「かんたん」と挿入配置のときは、上書きせず後ろを送る。 */
      paste: () => {
        const bundle = clipboard;
        if (!bundle) {
          toast('貼り付けるものがありません（先にクリップをコピーしてください）');
          return;
        }
        const at = player.time;
        const result = pasteClips(sequence, bundle, at, easy || insertMode);
        if (result.ids.length === 0) {
          toast('ここには貼り付けられません（同じ種類のトラックがありません）');
          return;
        }
        apply(() => result.sequence);
        setSelection(result.ids);
        // 続けて貼ると、後ろへ順に並ぶ。
        player.seek(at + bundle.duration);
      },
      duplicate: () => {
        const result = duplicateClips(sequence, selection);
        if (result.ids.length === 0) return;
        apply(() => result.sequence);
        setSelection(result.ids);
      },
    };
  }, [sequence, apply, selection, setSelection, editMode, insertMode, easy, markIn, markOut, setMarks]);
}
