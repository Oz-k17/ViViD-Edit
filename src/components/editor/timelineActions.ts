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
import { splitAt } from '../../model/ops';
import { useEditor } from '../../store/editor';

/** 範囲（In/Out）が使える形か。 */
function validRange(markIn: number | null, markOut: number | null): [number, number] | null {
  return markIn !== null && markOut !== null && markOut - markIn > 0.01 ? [markIn, markOut] : null;
}

/**
 * タイムラインの操作をまとめたもの。キーボード（EditorPage）とツールバー（MultiTimeline）の
 * 両方から同じものを呼ぶ。どれも再生ヘッドや選択を「呼んだ時点で」読む。
 */
export function useTimelineActions() {
  const { sequence, apply, selection, setSelection, editMode, markIn, markOut, setMarks } = useEditor();

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
    };
  }, [sequence, apply, selection, setSelection, editMode, markIn, markOut, setMarks]);
}
