import { useState } from 'react';
import { downloadBlob, exporter, isExportSupported, pickMimeType, type ExportResult } from '../engine/exporter';
import { formatBytes } from '../engine/media';
import { player } from '../engine/player';
import { useEditor } from '../store/editor';
import { projectDuration } from '../types';
import { Field, Panel } from './ui';

const SCALE_OPTIONS = [
  { value: 1, label: '高画質' },
  { value: 0.667, label: '標準' },
  { value: 0.5, label: '軽量' },
];

export function ExportPanel() {
  const { project } = useEditor();
  const [scale, setScale] = useState(1);
  const [bitrate, setBitrate] = useState(8);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const duration = projectDuration(project);
  const supported = isExportSupported();
  const mime = pickMimeType();
  const outHeight = Math.round(project.height * scale);
  const running = progress !== null;

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress(0);
    try {
      const output = await exporter.run(project, player, { fps: project.fps, scale, bitrate }, setProgress);
      setResult(output);
      downloadBlob(output.blob, output.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : '書き出しに失敗しました');
    } finally {
      setProgress(null);
    }
  };

  return (
    <Panel title="書き出し">
      {!supported && <p className="error-note">このブラウザは書き出しに対応していません。Chrome / Edge をお試しください。</p>}

      <Field label="画質">
        <div className="chip-row">
          {SCALE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={scale === option.value ? 'chip active' : 'chip'}
              onClick={() => setScale(option.value)}
              disabled={running}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="ビットレート" hint={`${bitrate} Mbps`}>
        <input
          type="range"
          min={2}
          max={20}
          step={1}
          value={bitrate}
          disabled={running}
          onChange={(e) => setBitrate(Number(e.target.value))}
        />
      </Field>

      <p className="muted">
        {Math.round(project.width * scale)} × {outHeight} ・ {project.fps}fps ・{' '}
        {mime?.ext.toUpperCase() ?? '—'} ・ 尺 {duration.toFixed(1)} 秒
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
          ⬇ 動画を書き出す
        </button>
      )}

      {error && <p className="error-note">{error}</p>}
      {result && (
        <p className="success-note">
          {result.filename}（{formatBytes(result.blob.size)}）を保存しました。
          <button type="button" className="link" onClick={() => downloadBlob(result.blob, result.filename)}>
            もう一度ダウンロード
          </button>
        </p>
      )}

      <p className="muted small">
        書き出しはこのタブを開いたまま行われます。タブを裏に回すと描画が止まることがあるので、そのままお待ちください。
      </p>
    </Panel>
  );
}
