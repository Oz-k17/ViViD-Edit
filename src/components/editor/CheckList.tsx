import { useMemo, useState } from 'react';
import { textMeasurer } from '../../engine/checkMeasure';
import { formatTime } from '../../engine/media';
import { renderAudioMix } from '../../engine/offline-export';
import { player } from '../../engine/player';
import { audioChecks, timelineChecks, type CheckItem } from '../../model/checks';
import { sequenceDuration } from '../../model/ops';
import type { Sequence } from '../../model/types';
import { useEditor } from '../../store/editor';

/** 音を調べるのは、これより短い作品だけ（全体の音を作るので、長いと時間とメモリを食う）。 */
const AUDIO_CHECK_LIMIT_SECONDS = 10 * 60;

/**
 * 確かめリスト。書き出す前に、仕上がりの穴を時刻つきで並べる。押せばその場所へ飛ぶ。
 * `sequence` はまとめを展開したもの（書き出すものと同じ）。
 */
export function CheckList({ sequence, onJump }: { sequence: Sequence; onJump: () => void }) {
  const { nestPath, setSelection } = useEditor();
  const timeline = useMemo(() => timelineChecks(sequence, textMeasurer(sequence, player.renderSources())), [sequence]);
  const [audio, setAudio] = useState<CheckItem[] | null>(null);
  const [audioState, setAudioState] = useState<'idle' | 'running' | 'failed'>('idle');
  const [open, setOpen] = useState(true);
  const duration = sequenceDuration(sequence);

  const items = useMemo(() => [...timeline, ...(audio ?? [])].sort((a, b) => a.time - b.time), [timeline, audio]);
  const warns = items.filter((i) => i.level === 'warn').length;
  const infos = items.length - warns;

  const checkAudio = async () => {
    setAudioState('running');
    try {
      const mix = await renderAudioMix(sequence, duration);
      if (!mix) throw new Error('no audio');
      const channels = Array.from({ length: mix.numberOfChannels }, (_, i) => mix.getChannelData(i));
      setAudio(audioChecks(channels, mix.sampleRate));
      setAudioState('idle');
    } catch {
      setAudioState('failed');
    }
  };

  const jump = (item: CheckItem) => {
    onJump();
    player.seek(item.time);
    // いちばん外を見ているときだけ選ぶ（まとめの中身は、外から見るとまとめたクリップ）。
    if (item.clipId && nestPath.length === 0) setSelection([item.clipId.split('/')[0]]);
  };

  const summary =
    items.length === 0
      ? audio
        ? '気になる所はありません'
        : '映像と文字に気になる所はありません'
      : [warns > 0 ? `直したほうがよい所 ${warns}` : '', infos > 0 ? `好みで ${infos}` : ''].filter(Boolean).join('・');

  return (
    <section className={`check-list${warns > 0 ? ' has-warn' : ''}`}>
      <button type="button" className="check-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="check-title">確かめリスト</span>
        <span className="check-summary">{summary}</span>
      </button>
      {open && (
        <>
          {items.length > 0 && (
            <ul className="check-items">
              {items.map((item, i) => (
                <li key={`${item.kind}-${item.time}-${i}`}>
                  <button type="button" className={`check-item ${item.level}`} onClick={() => jump(item)}>
                    <span className="check-time">{formatTime(item.time)}</span>
                    <span className="check-text">
                      <span className="check-message">{item.message}</span>
                      <span className="check-hint">{item.hint}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {audio === null && duration > 0 && (
            <div className="check-audio">
              {duration <= AUDIO_CHECK_LIMIT_SECONDS ? (
                <button type="button" onClick={checkAudio} disabled={audioState === 'running'}>
                  {audioState === 'running' ? '音を調べています…' : '音も調べる（無音・音割れ）'}
                </button>
              ) : (
                <span className="muted small">10 分を超える作品は、音は調べません。</span>
              )}
              {audioState === 'failed' && <span className="muted small">音を調べられませんでした。</span>}
            </div>
          )}
          <p className="muted small">押すと、その場所へ飛びます。直さなくても書き出せます。</p>
        </>
      )}
    </section>
  );
}
