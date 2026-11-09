import { useState } from 'react';
import { AnalysisError, detectScenes } from '../../engine/analyze';
import { nestSceneClips, nestSceneTimes, splitClipAtTimes } from '../../model/analysisEdits';
import type { Clip } from '../../model/types';
import { useEditor } from '../../store/editor';
import { ButtonField } from '../ui';

/**
 * まとめたクリップ（3 分割など）を、シーンの切り替わりで分割する。
 * 中でいちばん大きく映っている映像（3 分割なら本編の帯）で切り替わりを探し、外のまとめたクリップを割る。
 * 割ったまとめたクリップの中身は、それぞれ自分の範囲だけになる（store の bakeNests）。
 */
export function NestSceneSplit({ clip }: { clip: Clip }) {
  const { sequence, apply } = useEditor();
  const [busy, setBusy] = useState(false);
  const [ratio, setRatio] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const sources = nestSceneClips(clip);
  if (sources.length === 0) return null;

  const run = async () => {
    setBusy(true);
    setNote(null);
    setRatio(0);
    try {
      const times: number[] = [];
      let truncated = false;
      for (const [i, inner] of sources.entries()) {
        const found = await detectScenes(inner, (r) => setRatio((i + r) / sources.length));
        truncated ||= found.truncated;
        times.push(...nestSceneTimes(clip, inner, found.times));
      }
      if (times.length === 0) {
        setNote('切り替わりは見つかりませんでした。');
        return;
      }
      // 数を言うための下見は、押した時点のシーケンスで。適用は「いまの」シーケンスに対して計算し直す。
      const id = clip.id;
      const cuts = splitClipAtTimes(sequence, id, times).pieceIds.length - 1;
      if (cuts > 0) apply((seq) => splitClipAtTimes(seq, id, times).sequence);
      setNote(
        cuts > 0
          ? `${cuts} か所で割りました（${cuts + 1} 本）。それぞれの中身も、その範囲だけになります。${truncated ? '長いので、頭のほうだけを調べています。' : ''}`
          : '切り替わりは見つかりましたが、端に近すぎて割れませんでした。',
      );
    } catch (error) {
      setNote(error instanceof AnalysisError ? error.message : `解析できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ButtonField label="自動解析（試験的）" hint="押したあとは「戻す」で戻せます">
        <button type="button" className="wide" disabled={busy} onClick={() => void run()}>
          {busy ? `カットの切り替わりを探しています… ${Math.round(ratio * 100)}%` : 'シーンで分割'}
        </button>
      </ButtonField>
      {note && <p className="muted small">{note}</p>}
    </>
  );
}
