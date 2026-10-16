import { useEffect, useState } from 'react';

/**
 * 画面の下に短く出して消える知らせ（トースト）。
 * 分割・削除のように、押しても見た目の変化が小さい操作で「効いた」ことを伝える。
 * どこからでも toast('…') で呼べるよう、状態は部品の外に 1 つだけ持つ。
 */
type Listener = (message: Message | null) => void;
interface Message {
  id: number;
  text: string;
}

const SHOW_MS = 1800;
let seq = 0;
let listener: Listener | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string): void {
  seq += 1;
  listener?.({ id: seq, text });
  clearTimeout(timer);
  timer = setTimeout(() => listener?.(null), SHOW_MS);
}

/** アプリに 1 つだけ置く。 */
export function ToastHost() {
  const [message, setMessage] = useState<Message | null>(null);
  useEffect(() => {
    listener = setMessage;
    return () => {
      listener = null;
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {/* key を変えると、同じ文言が続いても出直す動きをもう一度見せられる */}
      {message && (
        <div key={message.id} className="toast">
          {message.text}
        </div>
      )}
    </div>
  );
}
