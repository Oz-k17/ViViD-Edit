import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { label: string; hint?: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | 'separator';

/**
 * 右クリック（タッチでは長押し）で出すメニュー。
 * 押した場所に出し、画面からはみ出すときは内側へ寄せる。外を押す・Esc・スクロールで閉じる。
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - box.offsetWidth - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - box.offsetHeight - margin)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    // 開いたときの押下そのもので閉じないよう、次のコマから聞く。
    const timer = window.setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={pos}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={index} className="context-menu-sep" role="separator" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : ''}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
