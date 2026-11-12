import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** 載せてから出すまでの待ち。通りすがりでは出さない。 */
const SHOW_MS = 380;

/**
 * やさしい名前と、元の専門用語を並べて書く。
 * 専門用語は小さく添えるだけにして、Premiere などに慣れた人が迷わないようにする。
 */
export function Dual({ plain, alias }: { plain: string; alias?: string }) {
  return (
    <>
      {plain}
      {alias && <small className="alias">（{alias}）</small>}
    </>
  );
}

interface HintProps {
  /** 見出し（機能の名前）。 */
  title: string;
  /** 元の専門用語。見出しの横に小さく出す。 */
  alias?: string;
  /** 何が起きるかを、ひとことで。 */
  desc?: ReactNode;
  /** ショートカットキー（表示用の文字列）。 */
  keys?: string;
  /** 動く見本。出ているあいだだけ作る（載せていないボタンの分は動かさない）。 */
  demo?: () => ReactNode;
  children: ReactNode;
}

/**
 * カーソルを合わせると、機能の説明と動く見本を出す。
 *
 * ボタンの見た目や並びを変えないよう、包む側は場所を取らない（display: contents）。
 * 指で触る端末にはカーソルが無いので出さない（タップは、そのままボタンを押す）。
 */
export function Hint({ title, alias, desc, keys, demo, children }: HintProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const hide = () => {
    window.clearTimeout(timer.current);
    setAnchor(null);
    setPos(null);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 出ているあいだにスクロール・押下・キー入力があったら引っ込める（下のものを隠し続けない）。
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [anchor]);

  // 大きさを測ってから置く。上に出し、入らなければ下へ。左右は画面の内側へ寄せる。
  useLayoutEffect(() => {
    const box = card.current;
    if (!anchor || !box) return;
    const margin = 8;
    const gap = 10;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - margin));
    const above = anchor.top - gap - height;
    const top = above >= margin ? above : Math.min(anchor.bottom + gap, window.innerHeight - height - margin);
    setPos({ left, top });
  }, [anchor]);

  return (
    <span
      ref={wrap}
      className="hint-wrap"
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          const target = wrap.current?.firstElementChild;
          if (target) setAnchor(target.getBoundingClientRect());
        }, SHOW_MS);
      }}
      onPointerLeave={hide}
    >
      {children}
      {anchor &&
        createPortal(
          <div
            ref={card}
            className="hint-card"
            role="tooltip"
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
          >
            {demo && <div className="hint-demo">{demo()}</div>}
            <div className="hint-text">
              <div className="hint-title">
                <strong>{title}</strong>
                {alias && <span className="hint-alias">{alias}</span>}
                {keys && <kbd>{keys}</kbd>}
              </div>
              {desc && <p>{desc}</p>}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
