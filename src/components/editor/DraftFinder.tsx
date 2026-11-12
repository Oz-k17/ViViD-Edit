import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeLoudness } from '../../analysis/audio/loudness';
import { planJetCut } from '../../analysis/audio/silence';
import { ScanCancelled, cachedScan, scanAudio, type ScanResult } from '../../engine/highlightScan';
import { formatTime, type MediaAsset } from '../../engine/media';
import { decodeAssetAudioRange } from '../../engine/offline-export';
import { player } from '../../engine/player';
import { uid } from '../../model/factory';
import { buildDraft, findHighlights, type Highlight } from '../../model/highlights';
import {
  RATINGS_TO_LEARN,
  applyRatings,
  chatSignal,
  findCandidates,
  loudSignal,
  parseChatTimes,
  rate,
  ratingAssetKey,
  voiceSignal,
  wordsSignal,
  type RatedCandidate,
  type Rating,
  type Signal,
} from '../../model/candidates';
import { parseTranscript } from '../../model/transcript';
import { scopedKey } from '../../store/profile';
import { WHISPER_MODELS, checkWhisper, toMono16k, transcribe, type WhisperSupport } from '../../engine/transcribe';
import { saveBlob } from '../../engine/exporter';
import { tempoOptions, type TimeRange } from '../../model/tempo';
import { TEXT_PRESETS } from '../../presets';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { Toggle } from '../ui';

const LENGTHS = [30, 45, 60];

/** おまかせ下書きを出す長さ（秒）。これより短い素材は、そのまま使えばよい。 */
export const DRAFT_MIN_SECONDS = 90;

/**
 * 全編を軽いモデルで起こすときの、1 回に渡す長さ（秒）。
 * 長い録画を丸ごと渡すとメモリが足りなくなるので、区切って渡す。短くしすぎると、区切りのたびにモデルを組み立て直して遅い。
 */
const ROUGH_CHUNK_SECONDS = 20 * 60;
/** 候補探し用の軽いモデル（いちばん軽いもの）。字幕にするときは、選んだ場面だけを良いモデルで起こし直す。 */
const ROUGH_MODEL = WHISPER_MODELS[WHISPER_MODELS.length - 1].id;

/** 候補への「良い / 違う」の評価の置き場（この端末の中だけ）。 */
const RATINGS_KEY = scopedKey('vivid.candidateRatings');

function loadRatings(): Rating[] {
  try {
    const data = JSON.parse(localStorage.getItem(RATINGS_KEY) ?? '[]') as unknown;
    return Array.isArray(data) ? (data as Rating[]).filter((r) => r && typeof r.asset === 'string' && Array.isArray(r.signals)) : [];
  } catch {
    return [];
  }
}

function saveRatings(ratings: Rating[]) {
  try {
    // 古いものから捨てる（好みを見るのに、何百件も要らない）。
    localStorage.setItem(RATINGS_KEY, JSON.stringify(ratings.slice(-300)));
  } catch {
    /* 容量が足りなければ、覚えないだけ */
  }
}

/**
 * おまかせ下書き。長い録画から見どころの候補を出し、選んだものを下書きにする（model/highlights.ts）。
 * 見どころは音だけで探すので、文字起こしが無くても（iPad でも）使える。
 */
export function DraftFinder({ asset }: { asset: MediaAsset }) {
  const { sequence, apply, setSelection, nestPath } = useEditor();
  const { templates } = useApp();
  const [length, setLength] = useState(45);
  const [scanned, setScanned] = useState<ScanResult | null>(() => cachedScan(asset.id));
  const levels = scanned?.levels ?? null;
  /** チャットの発言の時刻・文字起こし（どちらも、ファイルを足したときだけ）。 */
  const [chat, setChat] = useState<number[] | null>(null);
  const [cues, setCues] = useState<{ start: number; end?: number; text: string }[] | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  /** 重なりが見つからないとき、音の大きさだけで探すか。 */
  const [loudOnly, setLoudOnly] = useState(false);
  const [ratings, setRatings] = useState<Rating[]>(loadRatings);
  // ---- 2 段構えの 1 段目: 全編を軽いモデルで起こして、盛り上がる言葉の信号にする ----
  const [whisper, setWhisper] = useState<WhisperSupport | null>(null);
  const [rough, setRough] = useState<{ done: number; total: number } | null>(null);
  const [roughNote, setRoughNote] = useState<string | null>(null);
  const roughCancel = useRef(false);
  useEffect(() => {
    void checkWhisper().then(setWhisper);
  }, []);

  const transcribeRough = async () => {
    if (!whisper?.installed || rough) return;
    roughCancel.current = false;
    const total = Math.max(1, Math.ceil(asset.duration / ROUGH_CHUNK_SECONDS));
    const collected: { start: number; end: number; text: string }[] = [];
    setRoughNote(null);
    try {
      for (let i = 0; i < total; i++) {
        if (roughCancel.current) break;
        setRough({ done: i, total });
        const from = i * ROUGH_CHUNK_SECONDS;
        const decoded = await decodeAssetAudioRange(asset.id, from, Math.min(asset.duration, from + ROUGH_CHUNK_SECONDS));
        if (!decoded) continue;
        const audio = await toMono16k(decoded.buffer);
        const result = await transcribe(audio, {
          modelId: ROUGH_MODEL,
          device: whisper.webgpu ? 'webgpu' : 'wasm',
          beams: 1,
          localLibrary: whisper.localLibrary,
        });
        for (const cue of result.cues) collected.push({ start: cue.start + decoded.start, end: cue.end + decoded.start, text: cue.text });
        // 区切りごとに信号へ足す（全部終わるのを待たずに、候補が良くなっていく）。
        setCues([...collected]);
      }
      setRoughNote(
        collected.length > 0
          ? `${roughCancel.current ? '途中まで' : '全編を'}起こしました（${collected.length} 行）。盛り上がる言葉を、信号に足しています。`
          : '言葉を起こせませんでした。',
      );
    } catch (e) {
      setRoughNote(`文字起こしが止まりました: ${e instanceof Error ? e.message : String(e)}${collected.length > 0 ? `（${collected.length} 行までは使います）` : ''}`);
    } finally {
      setRough(null);
    }
  };

  /** 起こした文字を、ファイルに取っておく。次は「文字起こしのファイルを足す」で読めば、起こし直さなくて済む。 */
  const saveRough = async () => {
    if (!cues) return;
    const body = JSON.stringify({ segments: cues.map((c) => ({ start: c.start, end: (c as { end?: number }).end ?? c.start + 2, text: c.text })) });
    const base = asset.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'recording';
    await saveBlob(new Blob([body], { type: 'application/json' }), `${base}_rough.json`);
  };
  const assetKey = ratingAssetKey(asset);
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
  const signalCount = 2 + (chat ? 1 : 0) + (cues ? 1 : 0);
  const candidates = useMemo<RatedCandidate[] | null>(() => {
    if (!scanned) return null;
    const signals: Signal[] = [loudSignal(scanned.levels), voiceSignal(scanned.bright, scanned.levels)];
    if (chat) signals.push(chatSignal(chat, scanned.levels.length));
    if (cues) signals.push(wordsSignal(cues, scanned.levels.length));
    return applyRatings(findCandidates(scanned.levels, signals, { length, count: 5 }), ratings, assetKey);
  }, [scanned, chat, cues, length, ratings, assetKey]);
  /** 音の大きさだけで探した候補（重なりが無いとき、頼まれたら出す）。理由は「音が大きくなった」だけ。 */
  const loudCandidates = useMemo<RatedCandidate[] | null>(
    () =>
      levels && loudOnly
        ? applyRatings(
            findHighlights(levels, { length, count: 5 }).map((h) => ({ ...h, signals: ['loud' as const], reason: '音が大きくなった（1 つだけ）' })),
            ratings,
            assetKey,
          )
        : null,
    [levels, loudOnly, length, ratings, assetKey],
  );
  const highlights = candidates && candidates.length > 0 ? candidates : (loudCandidates ?? candidates);

  const setRating = (h: RatedCandidate, good: boolean) => {
    const next = rate(ratings, { asset: assetKey, start: h.start, end: h.end, good, signals: h.signals, at: Date.now() });
    setRatings(next);
    saveRatings(next);
  };

  const addFile = async (file: File, kind: 'chat' | 'words') => {
    const text = await file.text();
    if (kind === 'chat') {
      const times = parseChatTimes(text);
      setChat(times.length > 0 ? times : null);
      setFileNote(times.length > 0 ? `チャット ${times.length} 件を読みました。` : 'チャットのファイルを読めませんでした（発言の時刻が見つかりません）。');
    } else {
      const parsed = parseTranscript(text).map((c) => ({ start: c.start, end: c.end, text: c.text }));
      setCues(parsed.length > 0 ? parsed : null);
      setFileNote(parsed.length > 0 ? `文字起こし ${parsed.length} 行を読みました。` : '文字起こしのファイルを読めませんでした。');
    }
  };
  const timelineEmpty = sequence.clips.length === 0;

  const scan = async () => {
    cancelRef.current = false;
    setFailed(false);
    setProgress(0);
    try {
      setScanned(await scanAudio(asset.id, asset.duration, setProgress, () => cancelRef.current));
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
        長い録画から、見どころの候補を探します。音が大きくなる・声が高まる・チャットが流れる・盛り上がる言葉が出る、のうち
        <strong> 2 つ以上が重なった所だけ</strong>を候補にします。選ぶと、切り出し・間を詰める・3 分割まで組みます。
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
      {levels && (
        <div className="draft-signals">
          <span className="muted small">
            使っている信号 {signalCount} つ: 音の大きさ・声の高まり{chat ? '・チャット' : ''}{cues ? '・盛り上がる言葉' : ''}
          </span>
          <div className="chip-row wrap">
            <label className="chip file-chip">
              {chat ? 'チャットを入れ替える' : 'チャットのファイルを足す'}
              <input
                type="file"
                accept=".json,.jsonl,.txt,.log,application/json,text/plain"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void addFile(file, 'chat');
                  e.target.value = '';
                }}
              />
            </label>
            <label className="chip file-chip">
              {cues ? '文字起こしを入れ替える' : '文字起こしのファイルを足す'}
              <input
                type="file"
                accept=".json,.srt,.vtt,.txt,application/json,text/plain"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void addFile(file, 'words');
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {fileNote && <span className="muted small">{fileNote}</span>}
          {whisper?.installed && (
            <div className="draft-rough">
              {rough ? (
                <>
                  <div className="progress running">
                    <span style={{ width: `${Math.round((rough.done / rough.total) * 100)}%` }} />
                  </div>
                  <span className="muted small">
                    軽いモデルで全編を起こしています… {rough.done + 1} / {rough.total} 区切り（1 区切り 20 分ぶん。終わった所から候補に効きます）
                  </span>
                  <button type="button" className="ghost" onClick={() => (roughCancel.current = true)}>
                    この区切りで止める
                  </button>
                </>
              ) : (
                <button type="button" className="ghost" onClick={() => void transcribeRough()}>
                  軽いモデルで全編を起こして、言葉の信号を足す
                </button>
              )}
              {roughNote && <span className="muted small">{roughNote}</span>}
              {cues && !rough && (
                <button type="button" className="ghost" onClick={() => void saveRough()}>
                  起こした文字をファイルに取っておく
                </button>
              )}
              <span className="muted small">
                2 段構え: 候補探しには軽いモデル（速いが粗い）を使い、字幕にするときは、選んだ場面だけを「字幕」の欄で良いモデルで起こし直します。
                長い録画では時間がかかります（3 時間で、GPU があれば数十分、無ければ数時間）。
              </span>
            </div>
          )}
          {!chat && !cues && (
            <span className="muted small">
              チャットや文字起こしが無くても、音の 2 つの信号で探します。あれば足すと、選び方が確かになります。
            </span>
          )}
        </div>
      )}
      {candidates && candidates.length === 0 && !loudOnly && (
        <div className="draft-empty">
          <p className="muted small">
            2 つ以上の信号が重なる所は見つかりませんでした。弱い所で数を埋めることはしません。
          </p>
          <button type="button" className="ghost" onClick={() => setLoudOnly(true)}>
            音の大きさだけで探す（信号 1 つ）
          </button>
        </div>
      )}
      {highlights && highlights.length === 0 && loudOnly && (
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
                <div className="draft-reason">
                  <span className="draft-why">理由: {h.reason}</span>
                  <span className="draft-rate" role="group" aria-label="この候補の評価">
                    <button
                      type="button"
                      className={h.rated === 'good' ? 'chip active' : 'chip'}
                      aria-pressed={h.rated === 'good'}
                      title="良い候補。こういう場面を、次から上に出します"
                      onClick={() => setRating(h, true)}
                    >
                      良い
                    </button>
                    <button
                      type="button"
                      className={h.rated === 'bad' ? 'chip active bad' : 'chip'}
                      aria-pressed={h.rated === 'bad'}
                      title="違う。こういう場面を、次から下げます"
                      onClick={() => setRating(h, false)}
                    >
                      違う
                    </button>
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
            評価 {ratings.length} 件。
            {ratings.length >= RATINGS_TO_LEARN
              ? '良いと言った候補に多かった信号を、重く見て並べています。'
              : `${RATINGS_TO_LEARN} 件たまると、良いと言った候補に多かった信号を重く見て並べます。`}
          </p>
          <p className="muted small">
            見出しは「見出しを入れる」のまま入ります。書き出しの確かめリストで知らせるので、書き換えてください。
          </p>
        </>
      )}
    </section>
  );
}
