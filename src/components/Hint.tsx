import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** 載せてから出すまでの待ち。通りすがりでは出さない。 */
const SHOW_MS = 380;
/** 指で長押しして出すまでの時間と、その間に許す指のぶれ。 */
const LONG_PRESS_MS = 480;
const SLOP_PX = 10;

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
 * 指で触る端末にはカーソルが無いので、**長押し**で出す（タップは、そのままボタンを押す）。
 * 長押しで出したときは、指を離してもボタンは押されず、カードは次に画面を触るまで残る。
 */
export function Hint({ title, alias, desc, keys, demo, children }: HintProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /** 指の長押しの途中か・長押しで出したか。 */
  const press = useRef<{ x: number; y: number } | null>(null);
  const shownByTouch = useRef(false);
  /** 長押しのあと、指を離したときの「押した」を 1 回だけ捨てる。 */
  const swallowClick = useRef(false);

  const show = () => {
    const target = wrap.current?.firstElementChild;
    if (target) setAnchor(target.getBoundingClientRect());
  };

  const hide = () => {
    window.clearTimeout(timer.current);
    press.current = null;
    shownByTouch.current = false;
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
        timer.current = window.setTimeout(show, SHOW_MS);
      }}
      onPointerLeave={(event) => {
        // 指を離しただけでは消さない（長押しで出したカードを読めるように）。
        if (event.pointerType === 'touch') return;
        hide();
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch') return;
        swallowClick.current = false;
        press.current = { x: event.clientX, y: event.clientY };
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          if (!press.current) return;
          shownByTouch.current = true;
          swallowClick.current = true;
          show();
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(event) => {
        const from = press.current;
        if (!from || shownByTouch.current) return;
        // 指が動いたら、押し続けではなくスクロールやドラッグ。出さない。
        if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > SLOP_PX) {
          press.current = null;
          window.clearTimeout(timer.current);
        }
      }}
      onPointerUp={() => {
        press.current = null;
        if (!shownByTouch.current) window.clearTimeout(timer.current);
      }}
      onPointerCancel={() => {
        press.current = null;
        if (!shownByTouch.current) window.clearTimeout(timer.current);
      }}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      // 長押しで端末のメニュー（コピーなど）が出ると、カードが読めない。
      onContextMenu={(event) => {
        if (shownByTouch.current || press.current) event.preventDefault();
      }}
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
