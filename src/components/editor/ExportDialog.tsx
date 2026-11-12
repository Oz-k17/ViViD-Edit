import { useMemo, useState } from 'react';
import {
  EMBEDDED_SAVE_LIMIT_BYTES,
  estimateExportBytes,
  exporter,
  exportSize,
  isEmbeddedHost,
  isExportSupported,
  isFrameAccurate,
  isNativeHost,
  exportFilename,
  pickMimeType,
  saveBlob,
  type ExportResult,
} from '../../engine/exporter';
import { formatBytes } from '../../engine/media';
import { player } from '../../engine/player';
import { FPS_OPTIONS, sequenceDuration } from '../../model/ops';
import { captionCount, withoutCaptions } from '../../model/captions';
import { flattenNests } from '../../model/nest';
import { ASPECT_PRESETS, type AspectKey } from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { Field, Segmented, Toggle } from '../ui';
import { Icon } from '../Icon';
import { CheckList } from './CheckList';
import { EXPORT_VARIANTS, captionScript, normalizeTags, postNote, titleOf, variantSequence, type VariantKey } from '../../model/batchExport';
import { useEasy } from '../UiModeToggle';
import { batchId, isResumable, markDone, remainingSteps, startBatch, type BatchRecord } from '../../model/exportProgress';
import { loadBatchRecord, outputsStore, saveBatchRecord } from '../../store/outputs';
import { uid } from '../../model/factory';
import { navigate } from '../../router';

const QUALITIES = [
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
  { value: 480, label: '480p' },
];

/** 「かんたん」での言い方。数字だけ見せても、どれを選べばよいか分からない人向け。 */
const EASY_QUALITY_LABELS: Record<number, string> = { 1080: 'きれい', 720: 'ふつう', 480: '軽い' };
const EASY_ASPECT_LABELS: Record<string, string> = {
  '9:16': '縦長（TikTok・Shorts・Reels）',
  '1:1': '正方形',
  '4:5': '縦（Instagram 投稿）',
  '16:9': '横長（YouTube）',
};

const BITRATE_FLOOR = 2;

/** `video/mp4; codecs="avc1.42E01E, mp4a.40.2"` → `MP4・映像 H.264・音声 AAC` のように読める形へ。 */
function codecSummary(mimeType: string): string {
  const container = /mp4/.test(mimeType) ? 'MP4' : /webm/.test(mimeType) ? 'WebM' : mimeType.split(';')[0];
  const codecs = /codecs="([^"]+)"/.exec(mimeType)?.[1] ?? '';
  const label = (c: string) => {
    if (c.startsWith('avc1')) return '映像 H.264';
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return '映像 H.265';
    if (c.startsWith('vp09') || c === 'vp9') return '映像 VP9';
    if (c.startsWith('vp8')) return '映像 VP8';
    if (c.startsWith('av01')) return '映像 AV1';
    if (c.startsWith('mp4a')) return '音声 AAC';
    if (c.startsWith('opus')) return '音声 Opus';
    return c;
  };
  const parts = codecs
    .split(',')
    .map((c) => label(c.trim()))
    .filter(Boolean);
  if (!parts.some((p) => p.startsWith('音声'))) parts.push('音声なし');
  return [container, ...parts].join('・');
}

type SaveErrorCode =
  | 'rejected_extension'
  | 'extension_not_enabled'
  | 'too_large'
  | 'declined'
  | 'rate_limited'
  | 'bad_request'
  | 'unavailable'
  | 'not_granted'
  | 'capability_disabled'
  | 'capability_removed'
  | 'transform_error'
  | 'unknown';

function saveErrorMessage(code: SaveErrorCode, blobSize: number): string {
  switch (code) {
    case 'too_large':
      return `書き出したファイル（${formatBytes(blobSize)}）が大きすぎて保存できませんでした。このページの埋め込み表示では ${formatBytes(EMBEDDED_SAVE_LIMIT_BYTES)} までしか保存できません。画質かビットレートを下げてもう一度お試しください。`;
    case 'declined':
      return '保存はキャンセルされました。';
    case 'rate_limited':
      return '保存の確認が続けて出すぎています。少し待ってからもう一度お試しください。';
    case 'rejected_extension':
    case 'extension_not_enabled':
      return 'この形式のファイルはこの環境では保存できません。書き出し形式を変えてお試しください。';
    default:
      return `保存できませんでした（${code}）`;
  }
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  // 書き出すのは、いちばん外のシーケンス（まとめたクリップの中に入っていても、全体を書き出す）。
  // まとめたクリップは展開してから渡す（中身はふつうのクリップとして合成される）。
  const { project, rootSequence } = useEditor();
  const sequence = useMemo(() => flattenNests(rootSequence), [rootSequence]);
  const { settings, updateSettings } = useApp();
  const easy = useEasy();
  const [aspect, setAspect] = useState<AspectKey>(settings.exportAspect ?? sequence.aspect);
  const [quality, setQuality] = useState(settings.exportQuality);
  // カメラロールは WebM を受け付けないので、iOS アプリ版では MP4 を既定にする。
  const [format, setFormat] = useState(isNativeHost() ? 'mp4' : settings.exportFormat);
  const [bitrate, setBitrate] = useState(8);
  const [fps, setFps] = useState(sequence.fps || 30);
  const [finishAudio, setFinishAudio] = useState(false);
  const [fast, setFast] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [errorCode, setErrorCode] = useState<SaveErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // まとめて書き出す（字幕あり・なし・投稿メモ）。何を作るかとタグは、次も同じだろうから覚えておく。
  const [batchPicks, setBatchPicks] = useState<('captions' | 'clean' | 'note')[]>(settings.batchVariants ?? ['captions', 'clean', 'note']);
  const [tagInput, setTagInput] = useState(settings.postTags ?? '');
  const [batchStep, setBatchStep] = useState<{ index: number; total: number; label: string } | null>(null);
  const [batchSaved, setBatchSaved] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const duration = sequenceDuration(sequence);
  // 字幕あり / なしの 2 種類を作るための切り替え。消えるのは「種類＝字幕」だけで、
  // タイトルや飾りは残る（どちらの版でも同じ見出しが乗っている状態にしたいため）。
  const [withoutCaption, setWithoutCaption] = useState(false);
  const captions = useMemo(() => captionCount(sequence), [sequence]);
  const supported = isExportSupported();
  const frameAccurate = isFrameAccurate();
  const embedded = isEmbeddedHost();
  const mime = pickMimeType(format);
  const size = exportSize(aspect, quality);
  const running = progress !== null;

  const estimatedBytes = useMemo(() => estimateExportBytes(duration, bitrate * 1_000_000), [duration, bitrate]);
  const likelyTooLarge = embedded && estimatedBytes > EMBEDDED_SAVE_LIMIT_BYTES;

  /** 保存は viewer 側で断られることがあるので、結果をそのまま伝える。 */
  const save = async (output: ExportResult) => {
    try {
      await saveBlob(output.blob, output.filename);
      setSaved(true);
      setErrorCode(null);
      setErrorMessage(null);
    } catch (e) {
      const code = ((e as { code?: string }).code ?? 'unknown') as SaveErrorCode;
      setSaved(false);
      setErrorCode(code);
      setErrorMessage(saveErrorMessage(code, output.blob.size));
    }
  };

  /**
   * quality/bitrate を直接読まず引数で受け取る。retrySmaller から呼ぶとき、
   * setState 直後の値をこの関数のクロージャ越しに読むと 1 テンポ古い値を掴んでしまうため。
   */
  const run = async (overrides?: { quality?: number; bitrate?: number }) => {
    const effectiveQuality = overrides?.quality ?? quality;
    const effectiveBitrate = overrides?.bitrate ?? bitrate;
    setErrorCode(null);
    setErrorMessage(null);
    setResult(null);
    setSaved(false);
    setProgress(0);
    updateSettings({ exportAspect: aspect, exportQuality: effectiveQuality, exportFormat: format });
    try {
      const output = await exporter.run(
        withoutCaption ? `${project.name}_字幕なし` : project.name,
        withoutCaption ? withoutCaptions(sequence) : sequence,
        player,
        {
          aspect,
          quality: effectiveQuality,
          fps,
          bitrate: effectiveBitrate,
          format,
          finishAudio: frameAccurate && finishAudio,
          fast,
          tag: withoutCaption ? 'nosub' : undefined,
        },
        setProgress,
      );
      setResult(output);
      await save(output);
      shelve(output, withoutCaption ? '字幕なし' : captions > 0 ? '字幕あり' : '', effectiveQuality);
    } catch (e) {
      setErrorCode('unknown');
      setErrorMessage(e instanceof Error ? e.message : '書き出しに失敗しました');
    } finally {
      setProgress(null);
    }
  };

  /** 完成品の置き場へ 1 行足す（確認待ちとして）。足した行の id を返す。 */
  const shelve = (output: ExportResult, variant: string, shelfQuality = quality): string => {
    const id = uid('out');
    outputsStore.add({
      id,
      project: project.name,
      filename: output.filename,
      variant,
      aspect,
      quality: shelfQuality,
      duration,
      bytes: output.blob.size,
      at: Date.now(),
      status: 'check',
      memo: '',
    });
    return id;
  };

  /** 字幕が無ければ「字幕なし」は「字幕あり」と同じものになるので、作らない。 */
  const batchVariants = EXPORT_VARIANTS.filter((v) => batchPicks.includes(v.key) && (v.key === 'captions' || captions > 0));
  const wantNote = batchPicks.includes('note');
  const togglePick = (key: VariantKey | 'note', on: boolean) =>
    setBatchPicks((picks) => (on ? [...picks.filter((k) => k !== key), key] : picks.filter((k) => k !== key)));

  // ---- 途中で止まったまとめ書き出しの続き ----
  // 作品の中身か設定が変われば別の書き出しなので、印（batchKey）が同じときだけ「続きから」を出す。
  const batchSteps = [...batchVariants.map((v) => ({ key: v.key as string, label: v.label })), ...(wantNote ? [{ key: 'note', label: '投稿メモ' }] : [])];
  const batchKey = useMemo(
    () => batchId(sequence, { aspect, quality, fps, bitrate, format, finishAudio, fast, tags: tagInput, steps: batchSteps.map((s) => s.key) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sequence, aspect, quality, fps, bitrate, format, finishAudio, fast, tagInput, batchSteps.map((s) => s.key).join(',')],
  );
  const [batchRecord, setBatchRecord] = useState<BatchRecord | null>(loadBatchRecord);
  const resumable = isResumable(batchRecord, batchKey) ? batchRecord : null;
  const remember = (record: BatchRecord | null) => {
    setBatchRecord(record);
    saveBatchRecord(record);
  };

  /**
   * 選んだ版を順に書き出して保存し、最後に投稿メモを作る。
   * `resume` なら、前回終わった本は飛ばして残りだけ作る。1 本終わるたびに記録するので、途中で落ちても続きから始められる。
   */
  const runBatch = async (resume = false) => {
    setErrorCode(null);
    setErrorMessage(null);
    setResult(null);
    setSaved(false);
    setBatchSaved([]);
    setNote(null);
    setCopied(false);
    updateSettings({ exportAspect: aspect, exportQuality: quality, exportFormat: format, postTags: tagInput, batchVariants: batchPicks });
    const total = batchVariants.length;
    const savedNames: string[] = [];
    let record = resume && resumable ? resumable : startBatch(batchKey, project.name, batchSteps, Date.now());
    remember(record);
    const finished = new Set(record.steps.filter((step) => step.done).map((step) => step.key));
    for (const step of record.steps) if (step.done && step.filename) savedNames.push(`${step.label}: ${step.filename}（前回保存済み）`);
    setBatchSaved([...savedNames]);
    const shelved: string[] = [];
    try {
      for (const [index, variant] of batchVariants.entries()) {
        if (finished.has(variant.key)) continue;
        setBatchStep({ index, total, label: variant.label });
        setProgress(0);
        const output = await exporter.run(
          project.name,
          variantSequence(sequence, variant.key),
          player,
          { aspect, quality, fps, bitrate, format, finishAudio: frameAccurate && finishAudio, fast, tag: variant.tag },
          setProgress,
        );
        await saveBlob(output.blob, output.filename);
        savedNames.push(`${variant.label}: ${output.filename}（${formatBytes(output.blob.size)}）`);
        setBatchSaved([...savedNames]);
        shelved.push(shelve(output, variant.label));
        record = markDone(record, variant.key, output.filename);
        remember(record);
      }
      if (wantNote) {
        const text = postNote({
          projectName: project.name,
          title: titleOf(sequence),
          tags: normalizeTags(tagInput),
          script: captionScript(sequence),
          duration,
        });
        setNote(text);
        // iPad アプリの保存先はカメラロールなので、文字のファイルは送らない（画面のメモをコピーしてもらう）。
        if (!isNativeHost()) {
          const filename = exportFilename(project.name, aspect, 'txt', new Date(), 'post');
          await saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
          savedNames.push(`投稿メモ: ${filename}`);
          setBatchSaved([...savedNames]);
        }
        // 完成品の置き場からも、投稿メモをコピーできるようにしておく。
        // 前回の分（続きから再開したとき）にも付ける。ファイル名で見分ける。
        const names = new Set(record.steps.map((step) => step.filename).filter(Boolean));
        for (const item of outputsStore.all()) {
          if (shelved.includes(item.id) || names.has(item.filename)) outputsStore.update(item.id, { postNote: text });
        }
        record = markDone(record, 'note');
      }
      // 全部終わったので、途中の記録は要らない。
      if (remainingSteps(record).length === 0) remember(null);
      else remember(record);
    } catch (e) {
      const code = ((e as { code?: string }).code ?? 'unknown') as SaveErrorCode;
      setErrorCode(code);
      setErrorMessage(
        code !== 'unknown' ? saveErrorMessage(code, 0) : e instanceof Error ? e.message : '書き出しに失敗しました',
      );
    } finally {
      setProgress(null);
      setBatchStep(null);
    }
  };

  const copyNote = async () => {
    if (!note) return;
    try {
      await navigator.clipboard.writeText(note);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  /** 画質・ビットレートともに下限まで下げきっていて、これ以上自動では縮められない状態。 */
  const atSmallestSettings = quality <= 480 && bitrate <= BITRATE_FLOOR;

  /** too_large のときだけ表示: 画質とビットレートを一段下げて、丸ごと書き出し直す。 */
  const retrySmaller = () => {
    const nextQuality = quality > 480 ? (quality === 1080 ? 720 : 480) : quality;
    const nextBitrate = Math.max(BITRATE_FLOOR, Math.round(bitrate / 2));
    setQuality(nextQuality);
    setBitrate(nextBitrate);
    void run({ quality: nextQuality, bitrate: nextBitrate });
  };

  return (
    <div className="modal-backdrop" onClick={() => !running && onClose()}>
      <div className="modal wide-modal" onClick={(e) => e.stopPropagation()}>
        <h2>書き出し</h2>

        {!supported && <p className="error-note">このブラウザは書き出しに対応していません。Chrome / Edge をお試しください。</p>}

        {!running && !result && <CheckList sequence={sequence} onJump={onClose} />}

        <Field label={easy ? 'どこに投稿しますか？' : 'アスペクト比'}>
          <div className="chip-row wrap">
            {ASPECT_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={aspect === preset.key ? 'chip active' : 'chip'}
                disabled={running}
                onClick={() => setAspect(preset.key)}
              >
                {easy ? (EASY_ASPECT_LABELS[preset.key] ?? preset.label) : preset.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="画質">
          <Segmented
            value={String(quality)}
            options={QUALITIES.map((q) => ({ value: String(q.value), label: easy ? `${EASY_QUALITY_LABELS[q.value]}（${q.label}）` : q.label }))}
            onChange={(value) => !running && setQuality(Number(value))}
          />
        </Field>

        {easy ? (
          <details className="more-settings">
            <summary>くわしい設定（形式・フレームレート・音量・ビットレート）</summary>
        <Field label="形式">
          <Segmented
            value={format}
            options={[
              { value: 'auto', label: 'おまかせ' },
              { value: 'mp4', label: 'MP4' },
              { value: 'webm', label: 'WebM' },
            ]}
            onChange={(value) => !running && setFormat(value as typeof format)}
          />
        </Field>

        <Field label="フレームレート">
          <Segmented
            value={String(fps)}
            options={FPS_OPTIONS.map((value) => ({ value: String(value), label: `${value}` }))}
            onChange={(value) => !running && setFps(Number(value))}
          />
        </Field>

        <Field label="音量（試験的）" hint={frameAccurate ? '-14 LUFS・ピーク -1 dBTP' : 'この環境では使えません'}>
          <Toggle
            checked={finishAudio && frameAccurate}
            disabled={running || !frameAccurate}
            onChange={setFinishAudio}
            label="音量を整えて書き出す"
          />
        </Field>

        <Field label="エンコード" hint={frameAccurate ? 'WebM のとき、動きの激しい映像で速くなることがあります（画質は同じ）' : 'この環境では使えません'}>
          <Toggle
            checked={fast && frameAccurate}
            disabled={running || !frameAccurate}
            onChange={setFast}
            label="高速エンコード（WebM 向け）"
          />
        </Field>

        <Field label="ビットレート" hint={`${bitrate} Mbps`}>
          <input type="range" min={2} max={20} step={1} value={bitrate} disabled={running} onChange={(e) => setBitrate(Number(e.target.value))} />
        </Field>

          </details>
        ) : (
          <>
        <Field label="形式">
          <Segmented
            value={format}
            options={[
              { value: 'auto', label: 'おまかせ' },
              { value: 'mp4', label: 'MP4' },
              { value: 'webm', label: 'WebM' },
            ]}
            onChange={(value) => !running && setFormat(value as typeof format)}
          />
        </Field>

        <Field label="フレームレート">
          <Segmented
            value={String(fps)}
            options={FPS_OPTIONS.map((value) => ({ value: String(value), label: `${value}` }))}
            onChange={(value) => !running && setFps(Number(value))}
          />
        </Field>

        <Field label="音量（試験的）" hint={frameAccurate ? '-14 LUFS・ピーク -1 dBTP' : 'この環境では使えません'}>
          <Toggle
            checked={finishAudio && frameAccurate}
            disabled={running || !frameAccurate}
            onChange={setFinishAudio}
            label="音量を整えて書き出す"
          />
        </Field>

        <Field label="エンコード" hint={frameAccurate ? 'WebM のとき、動きの激しい映像で速くなることがあります（画質は同じ）' : 'この環境では使えません'}>
          <Toggle
            checked={fast && frameAccurate}
            disabled={running || !frameAccurate}
            onChange={setFast}
            label="高速エンコード（WebM 向け）"
          />
        </Field>

        <Field label="ビットレート" hint={`${bitrate} Mbps`}>
          <input type="range" min={2} max={20} step={1} value={bitrate} disabled={running} onChange={(e) => setBitrate(Number(e.target.value))} />
        </Field>

          </>
        )}
        {(!easy || captions > 0) && (
        <Field label="テロップ" hint={captions > 0 ? `字幕は ${captions} 本` : '字幕はまだ無い'}>
          <Toggle
            checked={withoutCaption}
            disabled={running}
            onChange={setWithoutCaption}
            label="字幕を入れずに書き出す"
          />
        </Field>
        )}
        {easy && (
          <p className="muted">
            {Math.floor(duration / 60) > 0 ? `${Math.floor(duration / 60)} 分 ` : ''}
            {Math.round(duration % 60)} 秒の動画 ・ 約 {formatBytes(estimatedBytes)}
          </p>
        )}
        {!easy && <p className="muted">
          {size.width} × {size.height} ・ {fps}fps ・ {mime?.ext.toUpperCase() ?? '—'} ・ 尺 {duration.toFixed(1)} 秒 ・ 予想サイズ 約{' '}
          {formatBytes(estimatedBytes)}
        </p>}

        {likelyTooLarge && !running && (
          <p className="error-note">
            この見積もりだと、このページの埋め込み表示で保存できる上限（{formatBytes(EMBEDDED_SAVE_LIMIT_BYTES)}）を超える可能性があります。
            画質かビットレートを下げることをおすすめします。
          </p>
        )}

        {running ? (
          <>
            <div className="progress running">
              <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
            <p className="muted">
              {batchStep && `${batchStep.index + 1} / ${batchStep.total} 本目（${batchStep.label}）・`}
              {frameAccurate ? '書き出し中' : '収録中'}… {Math.round((progress ?? 0) * 100)}%
              {frameAccurate
                ? '（1 コマずつ書き出しています。素材が重いと動画の長さより時間がかかりますが、そのぶんコマ落ちしません）'
                : '（実時間で録画するため、動画の長さと同じだけかかります）'}
            </p>
            <button type="button" className="wide danger" onClick={() => exporter.cancel()}>
              中止
            </button>
          </>
        ) : (
          <>
            <button type="button" className="wide primary" disabled={!supported || duration <= 0} onClick={() => void run()}>
              <Icon name="export" />書き出す
            </button>
            <section className="batch-export">
              <span className="field-label">まとめて書き出す</span>
              {resumable && (
                <div className="resume-note" role="status">
                  <strong>前回のまとめ書き出しが、途中で止まっています。</strong>
                  <span>
                    保存済み: {resumable.steps.filter((step) => step.done).map((step) => step.label).join('・')}／残り:{' '}
                    {remainingSteps(resumable).map((step) => step.label).join('・')}
                  </span>
                  <div className="chip-row wrap">
                    <button type="button" className="primary" disabled={!supported} onClick={() => void runBatch(true)}>
                      続きから書き出す（残り {remainingSteps(resumable).length} つ）
                    </button>
                    <button type="button" className="ghost" onClick={() => remember(null)}>
                      記録を消す（最初からやり直す）
                    </button>
                  </div>
                </div>
              )}
              <div className="chip-row wrap">
                {EXPORT_VARIANTS.filter((v) => v.key === 'captions' || captions > 0).map((v) => (
                  <Toggle key={v.key} label={v.label} checked={batchPicks.includes(v.key)} onChange={(on) => togglePick(v.key, on)} />
                ))}
                <Toggle label="投稿メモ（タイトル・タグ・字幕の全文）" checked={wantNote} onChange={(on) => togglePick('note', on)} />
              </div>
              {wantNote && (
                <label className="field">
                  <span className="field-label">
                    タグ<span className="field-hint">空白で区切る。# は付けなくてよい（次も同じタグが入っています）</span>
                  </span>
                  <input type="text" value={tagInput} placeholder="例: ゲーム実況 切り抜き shorts" onChange={(e) => setTagInput(e.target.value)} />
                </label>
              )}
              <button
                type="button"
                className="wide"
                disabled={!supported || duration <= 0 || batchVariants.length + (wantNote ? 1 : 0) === 0}
                onClick={() => void runBatch()}
              >
                <Icon name="export" />
                まとめて書き出す（{[...batchVariants.map((v) => v.label), ...(wantNote ? ['投稿メモ'] : [])].join('・') || 'なし'}）
              </button>
            </section>
          </>
        )}
        {batchSaved.length > 0 && !running && (
          <div className="success-note">
            保存しました:
            <ul className="batch-saved">
              {batchSaved.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        {(batchSaved.length > 0 || saved) && !running && (
          <p className="muted small">
            書き出したものは「完成品」に「確認待ち」で並べました。
            <button
              type="button"
              className="link-button"
              onClick={() => {
                onClose();
                navigate('/outputs');
              }}
            >
              完成品を開く
            </button>
          </p>
        )}
        {note && !running && (
          <div className="batch-note">
            <textarea readOnly value={note} rows={8} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => void copyNote()}>
              {copied ? 'コピーしました' : '投稿メモをコピー'}
            </button>
          </div>
        )}

        {errorMessage && (
          <p className="error-note">
            {errorMessage}
            {errorCode === 'too_large' && atSmallestSettings && (
              <> これ以上は画質を下げても縮まりません。タイムラインを短くするか、クリップを減らしてお試しください。</>
            )}
            {errorCode === 'too_large' && !atSmallestSettings && (
              <>
                {' '}
                <button type="button" className="link" onClick={retrySmaller}>
                  画質を下げてもう一度書き出す
                </button>
              </>
            )}
            {result && errorCode !== 'too_large' && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => void save(result)}>
                  もう一度保存
                </button>
              </>
            )}
          </p>
        )}
        {saved && result && (
          <p className="success-note done-note">
            <span className="done-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 12 5 5 9-10" />
              </svg>
            </span>
            {result.filename}（{formatBytes(result.blob.size)}）を保存しました。
            <button type="button" className="link" onClick={() => void save(result)}>
              もう一度ダウンロード
            </button>
            {/* どのコーデックで書き出したかは、再生できない・音が出ないときの手がかりになる。 */}
            <br />
            {!easy && <span className="muted small">{codecSummary(result.mimeType)}</span>}
          </p>
        )}
        {result?.note && <p className="muted small">{result.note}</p>}
        {result?.warning && (
          <p className="error-note">{result.warning}</p>
        )}

        <p className="muted small">書き出し中はこのタブを開いたままにしてください。裏に回すと描画が止まることがあります。</p>

        {!running && (
          <button type="button" className="wide" onClick={onClose}>
            閉じる
          </button>
        )}
      </div>
    </div>
  );
}
