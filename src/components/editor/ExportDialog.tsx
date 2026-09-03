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
  pickMimeType,
  saveBlob,
  type ExportResult,
} from '../../engine/exporter';
import { formatBytes } from '../../engine/media';
import { player } from '../../engine/player';
import { sequenceDuration } from '../../model/ops';
import { ASPECT_PRESETS, type AspectKey } from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { Field, Segmented } from '../ui';

const QUALITIES = [
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
  { value: 480, label: '480p' },
];

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
  const { project, sequence } = useEditor();
  const { settings, updateSettings } = useApp();
  const [aspect, setAspect] = useState<AspectKey>(settings.exportAspect ?? sequence.aspect);
  const [quality, setQuality] = useState(settings.exportQuality);
  // カメラロールは WebM を受け付けないので、iOS アプリ版では MP4 を既定にする。
  const [format, setFormat] = useState(isNativeHost() ? 'mp4' : settings.exportFormat);
  const [bitrate, setBitrate] = useState(8);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [errorCode, setErrorCode] = useState<SaveErrorCode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const duration = sequenceDuration(sequence);
  const supported = isExportSupported();
  const frameAccurate = isFrameAccurate();
  const embedded = isEmbeddedHost();
  const native = isNativeHost();
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
        project.name,
        sequence,
        player,
        { aspect, quality: effectiveQuality, fps: sequence.fps, bitrate: effectiveBitrate, format },
        setProgress,
      );
      setResult(output);
      await save(output);
    } catch (e) {
      setErrorCode('unknown');
      setErrorMessage(e instanceof Error ? e.message : '書き出しに失敗しました');
    } finally {
      setProgress(null);
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

        <Field label="アスペクト比">
          <div className="chip-row wrap">
            {ASPECT_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={aspect === preset.key ? 'chip active' : 'chip'}
                disabled={running}
                onClick={() => setAspect(preset.key)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="画質">
          <Segmented
            value={String(quality)}
            options={QUALITIES.map((q) => ({ value: String(q.value), label: q.label }))}
            onChange={(value) => !running && setQuality(Number(value))}
          />
        </Field>

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

        <Field label="ビットレート" hint={`${bitrate} Mbps`}>
          <input type="range" min={2} max={20} step={1} value={bitrate} disabled={running} onChange={(e) => setBitrate(Number(e.target.value))} />
        </Field>

        <p className="muted">
          {size.width} × {size.height} ・ {sequence.fps}fps ・ {mime?.ext.toUpperCase() ?? '—'} ・ 尺 {duration.toFixed(1)} 秒 ・ 予想サイズ 約{' '}
          {formatBytes(estimatedBytes)}
        </p>

        {native && format !== 'mp4' && !running && (
          <p className="muted small">
            カメラロールに保存するなら MP4 を選んでください。WebM は写真アプリが受け付けないため、
            保存先を選ぶ画面（ファイルなど）に切り替わります。
          </p>
        )}

        {likelyTooLarge && !running && (
          <p className="error-note">
            この見積もりだと、このページの埋め込み表示で保存できる上限（{formatBytes(EMBEDDED_SAVE_LIMIT_BYTES)}）を超える可能性があります。
            画質かビットレートを下げることをおすすめします。
          </p>
        )}

        {running ? (
          <>
            <div className="progress">
              <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
            <p className="muted">
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
          <button type="button" className="wide primary" disabled={!supported || duration <= 0} onClick={() => void run()}>
            ⬇ 書き出す
          </button>
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
          <p className="success-note">
            {result.filename}（{formatBytes(result.blob.size)}）を保存しました。
            <button type="button" className="link" onClick={() => void save(result)}>
              もう一度ダウンロード
            </button>
            {/* どのコーデックで書き出したかは、再生できない・音が出ないときの手がかりになる。 */}
            <br />
            <span className="muted small">{codecSummary(result.mimeType)}</span>
          </p>
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
