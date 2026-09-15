import type { ReactNode } from 'react';

/**
 * UI のアイコン。
 *
 * 絵文字（✂ 🗑 ▶ …）をやめてここに集約した。絵文字は端末ごとに字形も色も
 * 違って出るので、同じ画面が人によって別物に見える。線幅も揃わない。
 *
 * SF Symbols そのものは使っていない。Apple のライセンスが Apple プラットフォーム
 * 向けアプリに限定しているため、Web アプリには持ち込めない。
 * 代わりに同じ作法で引いている:
 *   - 24 の枠、線で描く（塗りは原則使わない）
 *   - 線幅 1.7、端と角は丸める
 *   - currentColor を使い、文字色に追従させる
 *   - 中身は枠から 2 以上あけて、隣の文字とぶつからないようにする
 */

export type IconName =
  // 再生まわり
  | 'skip-back' | 'step-back' | 'play' | 'pause' | 'step-forward' | 'skip-forward'
  // 編集
  | 'scissors' | 'trash' | 'undo' | 'redo' | 'ripple-delete' | 'magnet' | 'link'
  // 素材
  | 'photo' | 'film' | 'music-note' | 'warning'
  // 画面まわり
  | 'iphone' | 'display' | 'export' | 'grid' | 'folder' | 'chevron-right' | 'plus' | 'minus' | 'check'
  | 'panels' | 'loop' | 'bookmark' | 'eye' | 'eye-off' | 'sound' | 'mute'
  | 'xmark' | 'chevron-left' | 'question'
  // トランジション
  | 'tr-none' | 'tr-dissolve' | 'tr-fade' | 'tr-slide' | 'tr-wipe' | 'tr-flash';

/** 枠は 24。線で描くものは stroke、面で見せたいものだけ fill を使う。 */
const PATHS: Record<IconName, ReactNode> = {
  // ---- 再生まわり ----
  'skip-back': (
    <>
      <path d="M18.5 5.5v13L9 12l9.5-6.5Z" />
      <path d="M5.5 5.5v13" />
    </>
  ),
  'step-back': <path d="M16.5 5.5v13L7 12l9.5-6.5Z" />,
  play: <path d="M7.5 5.2v13.6L19 12 7.5 5.2Z" />,
  pause: (
    <>
      <path d="M9 5.5v13" />
      <path d="M15 5.5v13" />
    </>
  ),
  'step-forward': <path d="M7.5 5.5v13L17 12 7.5 5.5Z" />,
  'skip-forward': (
    <>
      <path d="M5.5 5.5v13L15 12 5.5 5.5Z" />
      <path d="M18.5 5.5v13" />
    </>
  ),

  // ---- 編集 ----
  scissors: (
    <>
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <path d="M8.7 8.2 19 18.5" />
      <path d="M8.7 15.8 19 5.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5" />
      <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5" />
      <path d="M10.5 10v6.5" />
      <path d="M13.5 10v6.5" />
    </>
  ),
  undo: (
    <>
      <path d="M4.5 9.5h9a5.5 5.5 0 0 1 0 11H8" />
      <path d="M8 5 3.5 9.5 8 14" />
    </>
  ),
  redo: (
    <>
      <path d="M19.5 9.5h-9a5.5 5.5 0 0 0 0 11H16" />
      <path d="M16 5l4.5 4.5L16 14" />
    </>
  ),
  /** リップル削除。左へ詰める向きを、線に当てた矢印で表す。 */
  'ripple-delete': (
    <>
      <path d="M4 5v14" />
      <path d="M20 12H8" />
      <path d="M12 8l-4 4 4 4" />
    </>
  ),
  /** スナップ。磁石は「吸い付く」ことがそのまま読める。 */
  magnet: (
    <>
      <path d="M6 20v-9a6 6 0 0 1 12 0v9" />
      <path d="M6 15.5h4.5" />
      <path d="M13.5 15.5H18" />
      <path d="M6 20h4.5" />
      <path d="M13.5 20H18" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.8a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
      <path d="M14 10.2a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </>
  ),

  // ---- 素材 ----
  photo: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="3" />
      <circle cx="8.8" cy="10" r="1.4" />
      <path d="M4.5 16.5 9 12.6l3.2 2.7 3.3-3.4 3.9 3.6" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="3" />
      <path d="M8.5 5v14" />
      <path d="M15.5 5v14" />
      <path d="M3.5 12h17" />
    </>
  ),
  'music-note': (
    <>
      <path d="M9.5 18V6.2l9-1.7v11" />
      <circle cx="7" cy="18" r="2.5" />
      <circle cx="16" cy="15.5" r="2.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.2 21 19.3a1.4 1.4 0 0 1-1.2 2.1H4.2A1.4 1.4 0 0 1 3 19.3L12 4.2Z" />
      <path d="M12 10v4.5" />
      <path d="M12 18h.01" />
    </>
  ),

  // ---- 画面まわり ----
  iphone: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.8" />
      <path d="M10.5 5.2h3" />
    </>
  ),
  display: (
    <>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2.5" />
      <path d="M9 20.5h6" />
      <path d="M12 16.5v4" />
    </>
  ),
  export: (
    <>
      <path d="M12 3.5v11" />
      <path d="M8 10.5l4 4 4-4" />
      <path d="M4.5 16v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V16" />
    </>
  ),
  /** セーフエリアのガイド。画面の内側にもう一枠、が読めればよい。 */
  grid: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <rect x="7.5" y="7.5" width="9" height="9" rx="1.6" strokeDasharray="2.6 2.4" />
    </>
  ),
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1 1.2a2 2 0 0 0 1.5.6h5.7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z" />,
  'chevron-right': <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  plus: (
    <>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </>
  ),
  minus: <path d="M5.5 12h13" />,
  xmark: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  'chevron-left': <path d="M14.5 5.5 8 12l6.5 6.5" />,
  question: (
    <>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M9.6 9.5a2.5 2.5 0 0 1 4.9.6c0 1.7-2.5 2-2.5 3.6" />
      <path d="M12 17h.01" />
    </>
  ),
  check: <path d="M5 12.8 9.8 17.5 19 6.5" />,
  /** パネルの表示切り替え。窓が分かれている様子。 */
  panels: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
      <path d="M10 4.5v15" />
      <path d="M10 12h10.5" />
    </>
  ),
  loop: (
    <>
      <path d="M4.5 11.2a7 7 0 0 1 7-6.7h2.8" />
      <path d="M11.8 2l2.8 2.5-2.8 2.5" />
      <path d="M19.5 12.8a7 7 0 0 1-7 6.7H9.7" />
      <path d="M12.2 22l-2.8-2.5 2.8-2.5" />
    </>
  ),
  /** レイアウトを保存。しおりを挟む動作に寄せる。 */
  bookmark: <path d="M6 4.5h12a1 1 0 0 1 1 1v15L12 16l-7 4.5v-15a1 1 0 0 1 1-1Z" />,

  // ---- 表示・音（旧 ui.tsx から集約） ----
  eye: (
    <>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.8" />
      <path d="M6.5 7.8A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.9 9.9 0 0 0 4-.8" />
      <path d="M9.9 9.9a2.6 2.6 0 0 0 3.6 3.7" />
    </>
  ),
  sound: (
    <>
      <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4Z" />
      <path d="M15.6 9.4a3.6 3.6 0 0 1 0 5.2" />
      <path d="M18 7a7 7 0 0 1 0 10" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4Z" />
      <path d="M16.5 10l4 4" />
      <path d="M20.5 10l-4 4" />
    </>
  ),

  // ---- トランジション ----
  // 一覧に並ぶので、互いの見分けがつくことを優先している。
  'tr-none': <path d="M6 12h12" />,
  'tr-dissolve': (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </>
  ),
  'tr-fade': (
    <>
      <rect x="3.5" y="7.5" width="17" height="9" rx="2" />
      <path d="M8 7.5v9" opacity="0.45" />
      <path d="M12 7.5v9" opacity="0.7" />
      <path d="M16 7.5v9" />
    </>
  ),
  'tr-slide': (
    <>
      <rect x="3.5" y="7.5" width="7" height="9" rx="2" />
      <path d="M13 12h7" />
      <path d="M17 8.5l3.5 3.5L17 15.5" />
    </>
  ),
  'tr-wipe': (
    <>
      <rect x="3.5" y="7.5" width="17" height="9" rx="2" />
      <path d="M12 7.5v9" />
      <path d="M3.5 7.5h8.5v9H3.5z" fill="currentColor" stroke="none" opacity="0.35" />
    </>
  ),
  'tr-flash': (
    <>
      <path d="M12 3.5v3.2" />
      <path d="M12 17.3v3.2" />
      <path d="M4.8 12h3.2" />
      <path d="M16 12h3.2" />
      <path d="M6.9 6.9 9.2 9.2" />
      <path d="M14.8 14.8l2.3 2.3" />
      <path d="M17.1 6.9 14.8 9.2" />
      <path d="M9.2 14.8 6.9 17.1" />
    </>
  ),
};

/** 塗りで見せるもの。線で描くと潰れるため。 */
const FILLED = new Set<IconName>(['play', 'step-back', 'step-forward', 'skip-back', 'skip-forward', 'folder']);

export interface IconProps {
  name: IconName;
  /** 見た目の大きさ（px）。文字に添えるときは 17 前後が馴染む。 */
  size?: number;
  /** 読み上げ用。見えている文字と重複するなら省く（装飾扱いになる）。 */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 18, label, className }: IconProps) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1.2 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
