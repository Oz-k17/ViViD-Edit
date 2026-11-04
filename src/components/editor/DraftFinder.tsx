import { useMemo, useRef, useState } from 'react';
import { analyzeLoudness } from '../../analysis/audio/loudness';
import { planJetCut } from '../../analysis/audio/silence';
import { ScanCancelled, cachedLevels, scanLevels } from '../../engine/highlightScan';
import { formatTime, type MediaAsset } from '../../engine/media';
import { decodeAssetAudioRange } from '../../engine/offline-export';
import { player } from '../../engine/player';
import { uid } from '../../model/factory';
import { buildDraft, findHighlights, type Highlight } from '../../model/highlights';
import { tempoOptions, type TimeRange } from '../../model/tempo';
import { TEXT_PRESETS } from '../../presets';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { Toggle } from '../ui';

const LENGTHS = [30, 45, 60];

/** おまかせ下書きを出す長さ（秒）。これより短い素材は、そのまま使えばよい。 */
export const DRAFT_MIN_SECONDS = 90;

/**
 * おまかせ下書き。長い録画から見どころの候補を出し、選んだものを下書きにする（model/highlights.ts）。
 * 見どころは音だけで探すので、文字起こしが無くても（iPad でも）使える。
 */
export function DraftFinder({ asset }: { asset: MediaAsset }) {
  const { sequence, apply, setSelection, nestPath } = useEditor();
  const { templates } = useApp();
  const [length, setLength] = useState(45);
  const [levels, setLevels] = useState<Float32Array | null>(() => cachedLevels(asset.id));
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [tempo, setTempo] = useState(true);
  const [threeBand, setThreeBand] = useState(asset.kind === 'video');
  const [confirming, setConfirming] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [previewAt, setPreviewAt] = useState<Highlight | null>(null);
  const cancelRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const kits = templates.filter((t) => t.kind === 'kit');
  const kitTemplate = kits[kits.length - 1];
  const kit = kitTemplate?.kind === 'kit' ? kitTemplate.kit : null;
  const highlights = useMemo(() => (levels ? findHighlights(levels, { length, count: 5 }) : null), [levels, length]);
  const timelineEmpty = sequence.clips.length === 0;

  const scan = async () => {
    cancelRef.current = false;
    setFailed(false);
    setProgress(0);
    try {
      setLevels(await scanLevels(asset.id, asset.duration, setProgress, () => cancelRef.current));
    } catch (e) {
      if (!(e instanceof ScanCancelled)) setFailed(true);
    } finally {
      setProgress(null);
    }
  };

  const preview = (h: Highlight) => {
    setPreviewAt(h);
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = h.start;
    void el.play().catch(() => undefined);
  };

  const makeDraft = async (h: Highlight) => {
    if (asset.kind !== 'video' && asset.kind !== 'audio') return;
    setBuilding(true);
    setConfirming(null);
    videoRef.current?.pause();
    try {
      // 間を詰めるなら、候補の範囲だけを細かく（20ms ごとに）測る。
      let keep: TimeRange[] | null = null;
      if (tempo) {
        const decoded = await decodeAssetAudioRange(asset.id, h.start, h.end);
        if (decoded) {
          const plan = planJetCut(analyzeLoudness(decoded.buffer), { mode: 'level', ...tempoOptions(0.5) });
          keep = plan.keep.map((r) => ({ start: r.start + decoded.start, end: r.end + decoded.start }));
        }
      }
      const nestId = uid('cl');
      const titleStyle = TEXT_PRESETS.find((preset) => preset.key === 'title')?.text ?? null;
      const kind = asset.kind;
      apply((seq) =>
        buildDraft(seq, { ...asset, kind }, { start: h.start, end: h.end }, { keep, threeBand, kit, titleStyle, nestId }),
      );
      setSelection([nestId]);
      player.seek(0);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <section className="draft-finder">
      <span className="field-label">おまかせ下書き</span>
      <p className="muted small">
        長い録画から、声や音が盛り上がった所を探して候補にします。選ぶと、切り出し・間を詰める・3 分割まで組みます。
      </p>
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
        !levels && (
          <button type="button" className="wide" onClick={() => void scan()}>
            見どころを探す
          </button>
        )
      )}
      {failed && <p className="muted small">音を読めませんでした。</p>}
      {highlights && highlights.length === 0 && (
        <p className="muted small">はっきり盛り上がる所が見つかりませんでした（ずっと同じ調子の録画です）。</p>
      )}
      {highlights && highlights.length > 0 && (
        <>
          <Toggle label="間を詰める（ふつう）" checked={tempo} onChange={setTempo} />
          {asset.kind === 'video' && (
            <Toggle
              label={kit ? `3 分割に組む（自分の型「${kitTemplate?.name}」）` : '3 分割に組む'}
              checked={threeBand}
              onChange={setThreeBand}
            />
          )}
          {asset.kind === 'video' && (
            <video
              ref={videoRef}
              className="draft-preview"
              src={asset.url}
              playsInline
              controls
              hidden={!previewAt}
              onTimeUpdate={(e) => {
                if (previewAt && e.currentTarget.currentTime >= previewAt.end) e.currentTarget.pause();
              }}
            />
          )}
          <ol className="draft-list">
            {highlights.map((h, i) => (
              <li key={`${h.start}-${h.end}`} className={previewAt === h ? 'active' : ''}>
                <div className="draft-head">
                  <span className="draft-time">
                    {formatTime(h.start)} 〜 {formatTime(h.end)}
                  </span>
                  <span className="muted small">
                    盛り上がり +{h.lift.toFixed(0)}dB・しゃべり {Math.round(h.talk * 100)}%
                  </span>
                </div>
                {confirming === i ? (
                  <div className="draft-actions">
                    <span className="muted small">いまのタイムラインを、この下書きに置き換えます（「戻す」で戻せます）。</span>
                    <button type="button" className="primary" disabled={building} onClick={() => void makeDraft(h)}>
                      置き換える
                    </button>
                    <button type="button" className="ghost" onClick={() => setConfirming(null)}>
                      やめる
                    </button>
                  </div>
                ) : (
                  <div className="draft-actions">
                    {asset.kind === 'video' && (
                      <button type="button" className="ghost" onClick={() => preview(h)}>
                        見る
                      </button>
                    )}
                    <button
                      type="button"
                      className="primary"
                      disabled={building || nestPath.length > 0}
                      onClick={() => (timelineEmpty ? void makeDraft(h) : setConfirming(i))}
                    >
                      {building ? '組んでいます…' : '下書きにする'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {nestPath.length > 0 && <p className="muted small">まとめたクリップの中では作れません。タイムラインの「外へ戻る」で戻ってください。</p>}
          <p className="muted small">
            見出しは「見出しを入れる」のまま入ります。書き出しの確かめリストで知らせるので、書き換えてください。
          </p>
        </>
      )}
    </section>
  );
}
