import type { LucideIcon } from 'lucide-react';
import {
  ArrowRightFromLine,
  Blend,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleQuestionMark,
  Contrast,
  Download,
  Eye,
  EyeOff,
  Film,
  FoldHorizontal,
  Folder,
  Image,
  Layers,
  Link2,
  Magnet,
  Minus,
  Monitor,
  Music,
  PanelsTopLeft,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  Scissors,
  SkipBack,
  SkipForward,
  Smartphone,
  SquareDashed,
  SquareSplitHorizontal,
  StepBack,
  StepForward,
  Trash2,
  TriangleAlert,
  Undo2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';

/**
 * UI のアイコン。
 *
 * 絵文字（✂ 🗑 ▶ …）をやめてここに集約している。絵文字は端末ごとに字形も色も
 * 違って出るので、同じ画面が人によって別物に見える。線幅も揃わない。
 *
 * 絵を引くのは **Lucide**（ISC ライセンス・再配布可）に任せている。
 * 自前で引いていたものを差し替えたのは、1000 を超える絵が同じ 24 の枠・同じ線幅で
 * 揃えてあるからで、こちらが 41 個を手で描くより形の揃いが良い。
 *
 * SF Symbols は使えない。Apple のライセンスが Apple プラットフォーム向けアプリに
 * 限られていて、Web アプリには持ち込めないため。代わりに Human Interface Guidelines の
 * 作法を Lucide の絵に当てている:
 *   - **線の太さは大きさに比例させる**（SF Symbols は書体なので、12pt の記号は 20pt より
 *     細い）。Lucide の既定の振る舞いがこれなので `absoluteStrokeWidth` は使わない。
 *     太さ 1.75 は SF Symbols の Regular に寄せた値。
 *   - **移動の操作（再生・一時停止・コマ送り）は塗り**。iOS の再生操作は塗りの字形で、
 *     線画にすると小さいところで潰れる。
 *   - **文字に添えるときは同じ大きさに寄せる**。呼ぶ側は隣の文字と同じ px を渡す
 *     （本文 17 なら 17、脚注 13 なら 13）。ベースラインは `.icon` の
 *     `vertical-align` で合わせている。
 *   - **色は currentColor**。1 色で描き、文字色に追従させる。
 *   - **意味を持つ絵には読み上げ名を付ける**（`label`）。付けないものは装飾として
 *     読み上げから外す。見えている文字と重複するなら付けない。
 *
 * 触れる大きさ（iOS の最小 44）はアイコン側では決まらない。押せる範囲は
 * ボタン側の寸法で、`styles.css` の `--ios-hit` / `--ios-hit-sm` が持っている。
 */

export type IconName =
  // 再生まわり
  | 'skip-back' | 'step-back' | 'play' | 'pause' | 'step-forward' | 'skip-forward'
  // 編集
  | 'scissors' | 'trash' | 'undo' | 'redo' | 'ripple-delete' | 'magnet' | 'link' | 'layers'
  // 素材
  | 'photo' | 'film' | 'music-note' | 'warning'
  // 画面まわり
  | 'iphone' | 'display' | 'export' | 'grid' | 'folder' | 'chevron-right' | 'plus' | 'minus' | 'check'
  | 'panels' | 'loop' | 'bookmark' | 'eye' | 'eye-off' | 'sound' | 'mute'
  | 'xmark' | 'chevron-left' | 'question'
  // トランジション
  | 'tr-none' | 'tr-dissolve' | 'tr-fade' | 'tr-slide' | 'tr-wipe' | 'tr-flash';

/**
 * 名前と Lucide の絵の対応。
 *
 * 呼ぶ側は Lucide の名前を知らない。ここが唯一の対応表なので、
 * 絵を替えたくなったらこの表だけを直せばよい。
 * 素直に読めない当てはめだけ、理由を添えている。
 */
const GLYPH: Record<IconName, LucideIcon> = {
  // ---- 再生まわり ----
  'skip-back': SkipBack,
  'step-back': StepBack,
  play: Play,
  pause: Pause,
  'step-forward': StepForward,
  'skip-forward': SkipForward,

  // ---- 編集 ----
  scissors: Scissors,
  trash: Trash2,
  undo: Undo2,
  redo: Redo2,
  /** リップル削除。両側から寄る矢印で「空いた隙間を詰める」を表す。 */
  'ripple-delete': FoldHorizontal,
  /** スナップ。磁石は「吸い付く」がそのまま読める。 */
  magnet: Magnet,
  link: Link2,
  /** まとめたクリップ（ネスト）。重なった板で「中に何本か入っている」を表す。 */
  layers: Layers,

  // ---- 素材 ----
  photo: Image,
  film: Film,
  'music-note': Music,
  warning: TriangleAlert,

  // ---- 画面まわり ----
  iphone: Smartphone,
  display: Monitor,
  export: Download,
  /** セーフエリアのガイド。破線の内枠が「ここから内側」を表す。 */
  grid: SquareDashed,
  folder: Folder,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  plus: Plus,
  minus: Minus,
  check: Check,
  /** パネルの表示切り替え。窓が分かれている様子。 */
  panels: PanelsTopLeft,
  loop: Repeat,
  /** レイアウトを保存。しおりを挟む動作に寄せる。 */
  bookmark: Bookmark,
  eye: Eye,
  'eye-off': EyeOff,
  sound: Volume2,
  mute: VolumeX,
  xmark: X,
  question: CircleQuestionMark,

  // ---- トランジション ----
  // 一覧に並ぶので、互いの見分けがつくことを優先している。
  /** なし。継ぎ目のない 1 本の線。 */
  'tr-none': Minus,
  /** ディゾルブ。2 つの円が重なって混ざる。 */
  'tr-dissolve': Blend,
  /** フェード。明るさが片側へ落ちていく。 */
  'tr-fade': Contrast,
  /** スライド。端から押し出して入ってくる。 */
  'tr-slide': ArrowRightFromLine,
  /** ワイプ。境目が画面を横切る。 */
  'tr-wipe': SquareSplitHorizontal,
  /** フラッシュ。一瞬光る。 */
  'tr-flash': Zap,
};

/**
 * 塗りで見せるもの。
 * iOS の再生操作は塗りの字形で、線画だと小さいところで潰れる。
 * フォルダも iOS では塗り。
 */
const FILLED = new Set<IconName>([
  'play', 'pause', 'step-back', 'step-forward', 'skip-back', 'skip-forward', 'folder',
]);

/** 線で描くときの太さ（24 の枠での値）。SF Symbols の Regular に寄せている。 */
const STROKE = 1.75;
/** 塗るときは細くする。同じ太さだと輪郭が太って見えるため。 */
const STROKE_FILLED = 1.2;

export interface IconProps {
  name: IconName;
  /**
   * 見た目の大きさ（px）。
   * 隣の文字と同じ値を渡すと馴染む（本文 17 / 小見出し 15 / 脚注 13）。
   */
  size?: number;
  /** 読み上げ用。見えている文字と重複するなら省く（装飾扱いになる）。 */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 18, label, className }: IconProps) {
  const Glyph = GLYPH[name];
  const filled = FILLED.has(name);
  return (
    <Glyph
      className={className ? `icon ${className}` : 'icon'}
      size={size}
      fill={filled ? 'currentColor' : 'none'}
      strokeWidth={filled ? STROKE_FILLED : STROKE}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    />
  );
}
