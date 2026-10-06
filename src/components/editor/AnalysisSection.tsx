/**
 * 映像クリップの自動解析（**試験的**）。
 *
 * ラボで「実用ラインに乗った」と判断した 3 つ — シーン検出・自動リフレーム・表紙候補 — を、
 * 本体で試せるようにしたもの。数字はすべて**合成した試し素材**で測った値で、
 * 本物の配信アーカイブでは測っていない。だから、押した結果は
 * **いつでも元へ戻せる（Undo 1 回）**ようにしてあり、画面でも試験的と断っている。
 *
 * 判断は `src/analysis/` にあり、ここは押す・待つ・結果を言う、だけ。
 */

import { useEffect, useRef, useState } from 'react';
import { frameToImage, exportName, decodeFramesAt } from '../../analysis/cover-export';
import { AnalysisError, detectScenes, pickCovers, planClipReframe, type CoverCandidate } from '../../engine/analyze';
import { saveBlob } from '../../engine/exporter';
import { formatTime, mediaRegistry } from '../../engine/media';
import { assetBlob } from '../../engine/offline-export';
import { player } from '../../engine/player';
import { applyReframeSegments, sourceToTimeline, splitAtSceneBoundaries } from '../../model/analysisEdits';
import type { Clip } from '../../model/types';
import { useEditor } from '../../store/editor';
import { Field } from '../ui';

type Job = 'scene' | 'reframe' | 'cover';

const JOB_LABEL: Record<Job, string> = {
  scene: 'カットの切り替わりを探しています',
  reframe: '被写体の位置を探しています',
  cover: '表紙に使えるコマを探しています',
};

export function AnalysisSection({ clip }: { clip: Clip }) {
  const { sequence, apply } = useEditor();
  const [job, setJob] = useState<Job | null>(null);
  const [ratio, setRatio] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [covers, setCovers] = useState<CoverCandidate[]>([]);
  const asset = mediaRegistry.get(clip.mediaId);

  /** 解析の共通の枠。待ち・失敗・後始末を 1 か所に置く。 */
  const run = async (kind: Job, body: () => Promise<string>) => {
    if (job) return;
    setJob(kind);
    setRatio(0);
    setNote(null);
    try {
      setNote(await body());
    } catch (error) {
      setNote(
        error instanceof AnalysisError
          ? error.message
          : `解析できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setJob(null);
    }
  };

  const splitScenes = () =>
    run('scene', async () => {
      const found = await detectScenes(clip, setRatio);
      if (found.times.length === 0) return '切り替わりは見つかりませんでした。';
      // 数を言うための下見は、押した時点のシーケンスで。適用は**いまの**シーケンスに対して
      // 計算し直す（解析は数秒かかるので、待っているあいだの編集を上書きしない）。
      const result = splitAtSceneBoundaries(sequence, clip.id, found.times);
      const cuts = result.pieceIds.length - 1;
      if (cuts <= 0) return '切り替わりは見つかりましたが、端に近すぎて割れませんでした。';
      apply((seq) => splitAtSceneBoundaries(seq, clip.id, found.times).sequence);
      return `${cuts} か所で割りました（${result.pieceIds.length} 本）。${
        found.truncated ? '長いので、頭のほうだけを調べています。' : ''
      }`;
    });

  const reframe = () =>
    run('reframe', async () => {
      const media = { width: asset?.width || 0, height: asset?.height || 0 };
      const found = await planClipReframe(clip, sequence, media, setRatio);
      if (!found) return '素材とシーケンスの縦横比がほぼ同じなので、切り出す余りがありません。';
      const result = applyReframeSegments(sequence, clip.id, found.segments, found.window);
      if (result.segments === 0) return '枠を決められませんでした。';
      apply((seq) => applyReframeSegments(seq, clip.id, found.segments, found.window).sequence);
      const moved = found.travelPerSecond > 0.15;
      return (
        `${result.segments} 区間に分けて、区間ごとに枠を置きました。` +
        (moved ? ' 枠がよく動いています。被写体が居ない素材だと、枠が泳ぐことがあります。' : '') +
        (found.truncated ? ' 長いので、頭のほうだけを調べています。' : '')
      );
    });

  const pickCover = () =>
    run('cover', async () => {
      const found = await pickCovers(clip, 3, setRatio);
      setCovers(found.picks);
      if (found.picks.length === 0) return '表紙に使えるコマが見つかりませんでした。';
      return `${found.picks.length} 枚選びました。${found.truncated ? '長いので、頭のほうだけから選んでいます。' : ''}`;
    });

  const saveCover = async (pick: CoverCandidate) => {
    if (!clip.mediaId) return;
    try {
      const blob = await assetBlob(clip.mediaId);
      if (!blob) throw new Error('素材を読み出せませんでした');
      const [frame] = await decodeFramesAt(blob, [pick.time]);
      if (!frame) throw new Error('そのコマを取り出せませんでした');
      await saveBlob(await frameToImage(frame, { format: 'png' }), exportName(asset?.name ?? 'cover', pick.time));
    } catch (error) {
      setNote(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <>
      <Field label="自動解析（試験的）" hint="押したあとは Undo で戻せます">
        <div className="chip-row wrap">
          <button type="button" className="chip" disabled={!!job} onClick={() => void splitScenes()}>
            シーンで分割
          </button>
          <button type="button" className="chip" disabled={!!job} onClick={() => void reframe()}>
            被写体を追って切り出す
          </button>
          <button type="button" className="chip" disabled={!!job} onClick={() => void pickCover()}>
            表紙の候補
          </button>
        </div>
      </Field>

      {job && (
        <p className="muted small">
          {JOB_LABEL[job]}… {Math.round(ratio * 100)}%
        </p>
      )}
      {note && !job && <p className="muted small">{note}</p>}

      {covers.length > 0 && (
        <ul className="cover-list">
          {covers.map((pick) => (
            <li key={pick.index}>
              <CoverThumb frame={pick.frame} />
              <div className="cover-meta">
                <strong>{formatTime(pick.time)}</strong>
                {pick.relaxed && <span className="muted small">条件を緩めて選んだ 1 枚</span>}
                <div className="chip-row">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => player.seek(Math.max(0, sourceToTimeline(clip, pick.time)))}
                  >
                    ここへ移動
                  </button>
                  <button type="button" className="chip" onClick={() => void saveCover(pick)}>
                    画像で保存
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small">
        数字はすべて合成した試し素材で測ったものです。本物の素材では、結果を見て直してください。
      </p>
    </>
  );
}

/** 解析に使った小さな絵を、そのまま候補の見た目に出す。 */
function CoverThumb({ frame }: { frame: CoverCandidate['frame'] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  }, [frame]);
  return <canvas ref={ref} className="cover-thumb" />;
}
