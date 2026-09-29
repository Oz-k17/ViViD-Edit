/**
 * 台本。プロジェクトの中身を**読み物の形**で並べる。
 *
 * 自動で組んだものを直すとき、タイムラインの上で 1 本ずつ選ぶのは目が疲れる。
 * 「どの言葉が、いつ、どの順で出るか」を上から下へ並べて、
 * **その場で文字を書き換えられる**ようにしたのがここ。
 *
 * テロップ・音・映像で分けてある。直すのはたいていテロップなので、それを先頭に置く。
 * 行を押すと、そのクリップを選んで頭出しする（プレビューで形を確かめながら直せる）。
 */

import { useMemo } from 'react';
import { formatTime, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import { readableDuration } from '../../model/transcript';
import { removeClips } from '../../model/ops';
import type { Clip } from '../../model/types';
import { useEditor } from '../../store/editor';
import { EmptyHint, Panel } from '../ui';
import { Icon } from '../Icon';

/** 話者ごとの印。色そのものは体裁側にあるので、ここは目印だけ。 */
const SPEAKER_DOT: Record<string, string> = { '1': '#5cd6ff', '2': '#c084fc' };

export function ScriptPanel() {
  const { sequence, selection, setSelection, apply } = useEditor();

  const { texts, audios, visuals } = useMemo(() => {
    const sorted = [...sequence.clips].sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
    return {
      texts: sorted.filter((c) => c.kind === 'text'),
      audios: sorted.filter((c) => c.kind === 'audio'),
      visuals: sorted.filter((c) => c.kind === 'video' || c.kind === 'image'),
    };
  }, [sequence.clips]);

  const pick = (clip: Clip) => {
    setSelection([clip.id]);
    player.seek(clip.start + 0.05);
  };

  const write = (clip: Clip, content: string) => {
    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => (c.id === clip.id && c.text ? { ...c, text: { ...c.text, content } } : c)),
      }),
      // 打つたびに履歴が積まれないよう、同じクリップの書き換えはまとめる。
      `script:${clip.id}`,
    );
  };

  const drop = (clip: Clip) => apply((seq) => removeClips(seq, [clip.id], false));

  const total = texts.length + audios.length + visuals.length;

  return (
    <Panel title="台本">
      {total === 0 ? (
        <EmptyHint>
          まだ何もありません。素材を置くか、「字幕」から書き起こしを取り込むと、ここに並びます。
        </EmptyHint>
      ) : (
        <>
          <Section label="テロップ" count={texts.length}>
            {texts.map((clip) => {
              const content = clip.text?.content ?? '';
              const short = clip.duration < readableDuration(content);
              return (
                <li
                  key={clip.id}
                  className={selection.includes(clip.id) ? 'script-row selected' : 'script-row'}
                  onPointerDown={() => pick(clip)}
                >
                  <div className="script-meta">
                    {clip.text?.speaker && (
                      <span
                        className="script-dot"
                        style={{ background: SPEAKER_DOT[clip.text.speaker] ?? '#8a8a8a' }}
                        title={`話者${clip.text.speaker}`}
                      />
                    )}
                    <button type="button" className="script-at" onClick={() => pick(clip)}>
                      {formatTime(clip.start)}
                    </button>
                    <span className={short ? 'script-span short' : 'script-span'} title={short ? '読むには短すぎます' : ''}>
                      {clip.duration.toFixed(1)}s{short ? ' ⚠' : ''}
                    </span>
                    <button type="button" className="script-drop danger" onClick={() => drop(clip)} aria-label="この行を消す">
                      <Icon name="xmark" size={13} />
                    </button>
                  </div>
                  <textarea
                    className="script-text"
                    value={content}
                    rows={Math.min(4, content.split('\n').length)}
                    onChange={(e) => write(clip, e.target.value)}
                    onFocus={() => pick(clip)}
                  />
                </li>
              );
            })}
          </Section>

          <Section label="音" count={audios.length}>
            {audios.map((clip) => (
              <MediaRow key={clip.id} clip={clip} selected={selection.includes(clip.id)} onPick={pick} onDrop={drop} />
            ))}
          </Section>

          <Section label="映像" count={visuals.length}>
            {visuals.map((clip) => (
              <MediaRow key={clip.id} clip={clip} selected={selection.includes(clip.id)} onPick={pick} onDrop={drop} />
            ))}
          </Section>
        </>
      )}
    </Panel>
  );
}

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <>
      <p className="muted small script-head">
        {label} <span>{count}</span>
      </p>
      <ul className="script-list">{children}</ul>
    </>
  );
}

/** 音と映像の行。文字は持たないので、名前と時刻だけ出す。 */
function MediaRow({
  clip,
  selected,
  onPick,
  onDrop,
}: {
  clip: Clip;
  selected: boolean;
  onPick: (clip: Clip) => void;
  onDrop: (clip: Clip) => void;
}) {
  const name = clip.mediaId ? (mediaRegistry.get(clip.mediaId)?.name ?? clip.mediaId) : '（素材なし）';
  return (
    <li className={selected ? 'script-row selected' : 'script-row'} onPointerDown={() => onPick(clip)}>
      <div className="script-meta">
        <button type="button" className="script-at" onClick={() => onPick(clip)}>
          {formatTime(clip.start)}
        </button>
        <span className="script-span">{clip.duration.toFixed(1)}s</span>
        <button type="button" className="script-drop danger" onClick={() => onDrop(clip)} aria-label="このクリップを消す">
          <Icon name="xmark" size={13} />
        </button>
      </div>
      <p className="script-name">{name}</p>
    </li>
  );
}
