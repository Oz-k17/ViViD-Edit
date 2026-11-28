import { useEffect, useRef, useState } from 'react';
import { openStream, recordSupport, startRecording, type RecordSource, type Recording } from '../../engine/recorder';
import { Field, Segmented, Toggle } from '../ui';

/**
 * カメラ・画面を録って、素材に入れる（engine/recorder.ts）。
 * 録る前に映りを見せ（カメラの向き・マイクを選べる）、止めたら素材の一覧へ入れて閉じる。
 */
export function RecordDialog({ onClose, onRecorded }: { onClose: () => void; onRecorded: (file: File) => Promise<void> }) {
  const support = recordSupport();
  const [source, setSource] = useState<RecordSource>(support.camera ? 'camera' : 'screen');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [mic, setMic] = useState(true);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  streamRef.current = stream;

  // 閉じるときは、カメラ・マイクを必ず手放す（つけっぱなしにしない）。
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(id);
  }, [recording]);

  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
  };

  /** 映りを見る（カメラは向きとマイクを選び直すたびに開き直す）。 */
  const preview = async () => {
    setError(null);
    release();
    try {
      setStream(await openStream(source, { facing, mic }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const start = async () => {
    setError(null);
    try {
      const s = stream ?? (await openStream(source, { facing, mic }));
      setStream(s);
      setRecording(startRecording(s, source));
      setStartedAt(performance.now());
      setNow(performance.now());
      // 画面の録画は、ブラウザ側の「共有を停止」で止められたら、そこまでを入れる。
      s.getVideoTracks()[0]?.addEventListener('ended', () => document.querySelector<HTMLButtonElement>('.record-stop')?.click());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    if (!recording) return;
    setBusy(true);
    try {
      const file = await recording.stop();
      setRecording(null);
      setStream(null);
      await onRecorded(file);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRecording(null);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    recording?.cancel();
    release();
    onClose();
  };

  const seconds = recording ? Math.max(0, (now - startedAt) / 1000) : 0;
  const clock = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  return (
    <div className="modal-backdrop" onClick={() => !recording && !busy && cancel()}>
      <div className="modal record-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>録画</h2>
        {!support.recorder ? (
          <p className="error-note">この環境では録画できません。</p>
        ) : (
          <>
            <Field label="録るもの" hint={support.screen ? undefined : '画面の録画は、パソコンのブラウザだけです（iPad には無い）'}>
              <Segmented<RecordSource>
                value={source}
                options={[
                  { value: 'camera', label: support.camera ? 'カメラ' : 'カメラ（不可）' },
                  { value: 'screen', label: support.screen ? '画面' : '画面（この端末では不可）' },
                ]}
                onChange={(v) => {
                  if (recording) return;
                  if ((v === 'camera' && !support.camera) || (v === 'screen' && !support.screen)) return;
                  release();
                  setSource(v);
                }}
              />
            </Field>
            {source === 'camera' && (
              <Field label="カメラの向き">
                <Segmented<'user' | 'environment'>
                  value={facing}
                  options={[
                    { value: 'user', label: '前（自分）' },
                    { value: 'environment', label: '後ろ' },
                  ]}
                  onChange={(v) => {
                    if (recording) return;
                    release();
                    setFacing(v);
                  }}
                />
              </Field>
            )}
            <Toggle
              label={source === 'camera' ? 'マイクの音も録る' : 'マイクの声も録る（ナレーション）'}
              checked={mic}
              onChange={(v) => {
                if (recording) return;
                release();
                setMic(v);
              }}
            />
            <div className="record-view">
              {stream ? (
                <video ref={videoRef} autoPlay muted playsInline className={source === 'camera' && facing === 'user' ? 'mirror' : ''} />
              ) : (
                <button type="button" className="ghost" onClick={() => void preview()}>
                  映りを見る
                </button>
              )}
              {recording && <span className="record-badge">● 録画中 {clock}</span>}
            </div>
            {recording ? (
              <button type="button" className="wide danger record-stop" disabled={busy} onClick={() => void stop()}>
                {busy ? '素材に入れています…' : '止めて素材に入れる'}
              </button>
            ) : (
              <button type="button" className="wide primary" onClick={() => void start()}>
                ● 録画を始める
              </button>
            )}
            <p className="muted small">
              止めると、録ったものが素材の一覧に入ります（そこからタイムラインへ）。
              {source === 'camera' && ' 前のカメラは、見るときだけ鏡のように左右を反転しています（録ったものは反転しません）。'}
            </p>
          </>
        )}
        {error && <p className="error-note">{error}</p>}
        <button type="button" className="wide ghost" disabled={busy} onClick={cancel}>
          {recording ? '録画をやめる（入れない）' : '閉じる'}
        </button>
      </div>
    </div>
  );
}
