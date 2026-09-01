import { useState } from 'react';
import { exporter, exportSize, isExportSupported, pickMimeType, saveBlob, type ExportResult } from '../../engine/exporter';
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

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { project, sequence } = useEditor();
  const { settings, updateSettings } = useApp();
  const [aspect, setAspect] = useState<AspectKey>(settings.exportAspect ?? sequence.aspect);
  const [quality, setQuality] = useState(settings.exportQuality);
  const [format, setFormat] = useState(settings.exportFormat);
  const [bitrate, setBitrate] = useState(8);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const duration = sequenceDuration(sequence);
  const supported = isExportSupported();
  const mime = pickMimeType(format);
  const size = exportSize(aspect, quality);
  const running = progress !== null;

  /** 保存は viewer 側で断られることがあるので、結果をそのまま伝える。 */
  const save = async (output: ExportResult) => {
    try {
      await saveBlob(output.blob, output.filename);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === 'declined' ? '保存はキャンセルされました。' : `保存できませんでした（${code ?? 'エラー'}）`);
    }
  };

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress(0);
    updateSettings({ exportAspect: aspect, exportQuality: quality, exportFormat: format });
    try {
      const output = await exporter.run(project.name, sequence, player, { aspect, quality, fps: sequence.fps, bitrate, format }, setProgress);
      setResult(output);
      await save(output);
    } catch (e) {
      setError(e instanceof Error ? e.message : '書き出しに失敗しました');
    } finally {
      setProgress(null);
    }
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
          {size.width} × {size.height} ・ {sequence.fps}fps ・ {mime?.ext.toUpperCase() ?? '—'} ・ 尺 {duration.toFixed(1)} 秒
        </p>

        {running ? (
          <>
            <div className="progress">
              <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
            <p className="muted">
              収録中… {Math.round((progress ?? 0) * 100)}%（実時間で録画するため、動画の長さと同じだけかかります）
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

        {error && <p className="error-note">{error}</p>}
        {result && (
          <p className="success-note">
            {result.filename}（{formatBytes(result.blob.size)}）を保存しました。
            <button type="button" className="link" onClick={() => void save(result)}>
              もう一度ダウンロード
            </button>
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
