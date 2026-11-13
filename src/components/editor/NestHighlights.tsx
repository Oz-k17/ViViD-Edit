import { useMemo, useRef, useState } from 'react';
import { ScanCancelled, cachedScan, scanAudio } from '../../engine/highlightScan';
import { formatTime, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import { findCandidates, loudSignal, voiceSignal, type Candidate } from '../../model/candidates';
import { uid } from '../../model/factory';
import { appendNestRange, findHighlights, keepNestRange, nestAudibleMedia, nestScan } from '../../model/highlights';
import type { Clip } from '../../model/types';
import { useEditor } from '../../store/editor';
import { ButtonField } from '../ui';

const LENGTHS = [30, 45, 60];

/**
 * まとめたクリップ（3 分割など）の中から、見どころを探す。素材の一覧の「おまかせ下書き」と同じ探し方
 * （音の大きさ・声の高まりの重なり）を、まとめたクリップの中身の音で行う。
 * 見つけた範囲は「ここだけ残す」（このまとめを、その範囲だけにする）か、「後ろに足す」（写しを後ろに並べる。何本も作れる）。
 */
export function NestHighlights({ clip }: { clip: Clip }) {
  const { apply, setSelection } = useEditor();
  const media = useMemo(() => nestAudibleMedia(clip), [clip]);
  const [length, setLength] = useState(45);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [scannedTick, setScannedTick] = useState(0);
  const cancelRef = useRef(false);
  const ready = media.length > 0 && media.every((id) => cachedScan(id));

  const candidates = useMemo<Candidate[] | null>(() => {
    if (!ready) return null;
    const { levels, bright } = nestScan(clip, (id) => cachedScan(id));
    const found = findCandidates(levels, [loudSignal(levels), voiceSignal(bright, levels)], { length, count: 5 });
    if (found.length > 0) return found;
    // 2 つの信号が重なる所が無いときは、音の大きさだけで探す（理由にそう書く）。
    return findHighlights(levels, { length, count: 5 }).map((h) => ({ ...h, signals: ['loud' as const], reason: '音が大きくなった（1 つだけ）' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, clip, length, scannedTick]);

  if (media.length === 0) return null;

  const scan = async () => {
    cancelRef.current = false;
    setFailed(null);
    setProgress(0);
    try {
      for (const [i, id] of media.entries()) {
        const asset = mediaRegistry.get(id);
        if (!asset) continue;
        await scanAudio(id, asset.duration, (r) => setProgress((i + r) / media.length), () => cancelRef.current);
      }
      setScannedTick((n) => n + 1);
    } catch (e) {
      if (!(e instanceof ScanCancelled)) setFailed('音を読めませんでした。');
    } finally {
      setProgress(null);
    }
  };

  const watch = (h: Candidate) => {
    player.seek(clip.start + h.start);
    player.play();
  };
  const keep = (h: Candidate) => {
    const id = clip.id;
    apply((seq) => keepNestRange(seq, id, h));
    player.seek(clip.start);
  };
  const append = (h: Candidate) => {
    const id = clip.id;
    const newId = uid('cl');
    apply((seq) => appendNestRange(seq, id, h, newId));
    setSelection([newId]);
  };

  return (
    <>
      <hr />
      <ButtonField label="見どころを探す" hint="この中の音から、盛り上がった所を探します">
        <div className="chip-row">
          {LENGTHS.map((l) => (
            <button key={l} type="button" className={l === length ? 'chip active' : 'chip'} onClick={() => setLength(l)}>
              {l} 秒
            </button>
          ))}
        </div>
        {progress !== null ? (
          <div className="draft-progress">
            <div className="progress running">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="muted small">音を調べています… {Math.round(progress * 100)}%</span>
            <button type="button" className="ghost" onClick={() => (cancelRef.current = true)}>
              中止
            </button>
          </div>
        ) : (
          !ready && (
            <button type="button" className="wide" onClick={() => void scan()}>
              見どころを探す
            </button>
          )
        )}
      </ButtonField>
      {failed && <p className="muted small">{failed}</p>}
      {candidates && candidates.length === 0 && (
        <p className="muted small">
          {clip.duration < length + 5
            ? `このまとめは ${length} 秒の候補を探すには短すぎます（${Math.round(clip.duration)} 秒）。短い長さを選ぶか、長いまとめで探してください。`
            : 'はっきり盛り上がる所が見つかりませんでした。'}
        </p>
      )}
      {candidates && candidates.length > 0 && (
        <ol className="draft-list nest-highlights">
          {candidates.map((h) => (
            <li key={`${h.start}-${h.end}`}>
              <div className="draft-head">
                <span className="draft-time">
                  {formatTime(clip.start + h.start)} 〜 {formatTime(clip.start + h.end)}
                </span>
                <span className="muted small">{h.reason}</span>
              </div>
              <div className="draft-actions">
                <button type="button" className="ghost" onClick={() => watch(h)}>
                  見る
                </button>
                <button type="button" onClick={() => keep(h)}>
                  ここだけ残す
                </button>
                <button type="button" className="primary" onClick={() => append(h)}>
                  後ろに足す
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {candidates && candidates.length > 0 && (
        <p className="muted small">
          「ここだけ残す」はこのまとめをその範囲だけにします。「後ろに足す」は写しをタイムラインの後ろに並べるので、何本でも作れます（どちらも「戻す」で戻せます）。
        </p>
      )}
    </>
  );
}
