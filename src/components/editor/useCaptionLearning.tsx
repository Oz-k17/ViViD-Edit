import { useRef, useState } from 'react';
import { learnCorrection } from '../../model/dictionary';
import type { Clip } from '../../model/types';
import { useApp } from '../../store/app';

/**
 * わたし辞書に覚えさせる。字幕の入力欄に入ったときの文を控え、離れたときに比べて、直しがあれば覚える。
 * 打つたびに比べると、打ちかけの言葉まで覚えてしまうので、離れたときだけにする。
 */
export function useCaptionLearning() {
  const { learnWord, removeWord } = useApp();
  const startRef = useRef<{ id: string; content: string } | null>(null);
  const [learned, setLearned] = useState<{ from: string; to: string } | null>(null);

  const begin = (clip: Clip) => {
    if (startRef.current?.id === clip.id) return;
    startRef.current = { id: clip.id, content: clip.text?.content ?? '' };
  };

  const finish = (clip: Clip, content: string) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start || start.id !== clip.id) return;
    // 見出しや飾りの文字は、毎回書き換えるものなので覚えない。
    if (clip.kind !== 'text' || (clip.text?.role ?? 'caption') !== 'caption') return;
    const correction = learnCorrection(start.content, content);
    if (!correction) return;
    learnWord(correction.from, correction.to);
    setLearned(correction);
  };

  const forget = () => {
    if (learned) removeWord(learned.from);
    setLearned(null);
  };

  return { begin, finish, learned, forget };
}

/** 覚えたことを知らせ、その場で取り消せるようにする。 */
export function LearnedNote({ learned, forget }: { learned: { from: string; to: string } | null; forget: () => void }) {
  if (!learned) return null;
  return (
    <p className="muted small learned-note">
      「{learned.from}」→「{learned.to || '（消す）'}」をわたし辞書に覚えました。次に字幕を起こすとき、自動で直します。
      <button type="button" className="link" onClick={forget}>
        覚えない
      </button>
    </p>
  );
}
