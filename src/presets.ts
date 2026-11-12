import { DEFAULT_TEXT } from './model/factory';
import { DEFAULT_TEXT_FRAME, type TextProps } from './model/types';

export const FONT_OPTIONS = [
  { value: '"Noto Sans JP", system-ui, sans-serif', label: 'Noto Sans JP（標準）' },
  { value: '"Zen Kaku Gothic New", system-ui, sans-serif', label: 'Zen Kaku Gothic（やわらか）' },
  { value: '"M PLUS Rounded 1c", system-ui, sans-serif', label: 'M PLUS Rounded（まる）' },
  { value: '"Kaisei Decol", serif', label: 'Kaisei Decol（明朝）' },
  { value: '"RocknRoll One", system-ui, sans-serif', label: 'RocknRoll One（太丸）' },
  { value: 'Impact, "Noto Sans JP", sans-serif', label: 'Impact（ミーム）' },
  { value: 'Georgia, serif', label: 'Georgia（英字セリフ）' },
  { value: 'ui-monospace, "SFMono-Regular", monospace', label: 'Monospace' },
];

/** スタイルの使いどころ。画面では、この順のグループに分けて並べる。 */
export type TextPresetGroup = 'caption' | 'title' | 'punch' | 'deco';

export const TEXT_PRESET_GROUPS: { key: TextPresetGroup; label: string; hint: string }[] = [
  { key: 'caption', label: '字幕向け', hint: 'しゃべっている言葉を出す。小さめで読みやすい' },
  { key: 'title', label: '見出し向け', hint: '動画の題や話題。大きく出す' },
  { key: 'punch', label: '強調・ツッコミ', hint: '決めの一言や驚き。色と動きで目立たせる' },
  { key: 'deco', label: '飾り・札', hint: '引用や説明を、台紙に載せて見せる' },
];

export interface TextPreset {
  /** 保存した設定やテンプレートが覚えている名前。変えない。 */
  key: string;
  label: string;
  group: TextPresetGroup;
  text: TextProps;
}

const ROCKNROLL = FONT_OPTIONS[4].value;
const ZEN = FONT_OPTIONS[1].value;
const ROUNDED = FONT_OPTIONS[2].value;
const MINCHO = FONT_OPTIONS[3].value;

/**
 * ショート動画で使い回しの効くテロップスタイル。
 * 名前は、見たままを言う（「ざぶとん」のような業界の呼び名は、かっこで添える）。
 */
export const TEXT_PRESETS: TextPreset[] = [
  // ---------------------------------------------------------------- 字幕向け
  {
    /**
     * 基本の字幕。白い文字に、太めの黒い縁と、ぼかさない落ち影。
     * ぼかした影を縁の外に広げると、輪郭がにじんで安く見える。影は下へ短く、はっきり落とす。
     */
    key: 'caption',
    label: '白文字＋黒フチ',
    group: 'caption',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ZEN,
      fontSize: 62,
      weight: 900,
      strokeColor: '#101010',
      strokeWidth: 9,
      shadow: 0,
      shadowY: 6,
      shadowColor: 'rgba(0,0,0,0.5)',
      letterSpacing: 1,
      animation: 'fade',
    },
  },
  {
    /**
     * テレビ番組で使われている形。**内側が黒、外側が白**で、外を少し細くする。
     * 調べた作例はどれもこの組み方で、太さの比は 5:4 前後に収まっていた。
     * 見出し（幅いっぱい）と同じ縁で、字幕の大きさにしたもの。
     */
    key: 'tv',
    label: 'テレビ風（黒フチ＋白フチ）',
    group: 'caption',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 92,
      weight: 400,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 10,
      strokeColor2: '#ffffff',
      strokeWidth2: 8,
      shadow: 0,
      shadowY: 0,
      maxWidth: 0.92,
      animation: 'pop',
    },
  },
  {
    /**
     * 縁を使わず、下に敷いた帯（ざぶとん）に読ませる仕事を渡す形。
     * 縁と立体は「バラエティ系」の作法で、落ち着いた画では嫌われる。
     * そちらでは、ざぶとんか落ち影を使う。
     */
    key: 'zabuton',
    label: '黒い帯に白文字（ざぶとん）',
    group: 'caption',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 72,
      weight: 400,
      color: '#ffffff',
      strokeWidth: 0,
      strokeWidth2: 0,
      bgColor: '#000000',
      bgOpacity: 0.62,
      shadow: 0,
      shadowY: 0,
      maxWidth: 0.86,
      animation: 'fade',
    },
  },
  {
    key: 'box',
    label: '白い帯に黒文字',
    group: 'caption',
    text: {
      ...DEFAULT_TEXT,
      fontSize: 62,
      weight: 800,
      color: '#111111',
      strokeWidth: 0,
      bgColor: '#ffffff',
      bgOpacity: 0.95,
      shadow: 6,
      animation: 'slideUp',
    },
  },
  {
    /** 縁も帯も無い、白い文字だけ。やわらかい影で、明るい絵の上でも読めるようにする。落ち着いた動画向け。 */
    key: 'plain',
    label: 'シンプルな白文字',
    group: 'caption',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ZEN,
      fontSize: 60,
      weight: 700,
      strokeWidth: 0,
      shadow: 22,
      shadowY: 3,
      shadowColor: 'rgba(0,0,0,0.85)',
      letterSpacing: 2,
      animation: 'fade',
    },
  },
  {
    /** 説明・ナレーション用。白い文字に青い縁。しゃべりの字幕（黒フチ）と色で分けられる。 */
    key: 'narration',
    label: '説明の青フチ',
    group: 'caption',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ZEN,
      fontSize: 62,
      weight: 900,
      strokeColor: '#1d4ed8',
      strokeWidth: 9,
      strokeColor2: '#ffffff',
      strokeWidth2: 4,
      shadow: 0,
      shadowY: 0,
      animation: 'slideUp',
    },
  },
  {
    key: 'mono',
    label: 'タイプライター風',
    group: 'caption',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: FONT_OPTIONS[6].value,
      fontSize: 52,
      weight: 700,
      strokeWidth: 0,
      bgColor: '#000000',
      bgOpacity: 0.55,
      letterSpacing: 1,
      animation: 'typewriter',
    },
  },

  // ---------------------------------------------------------------- 見出し向け
  {
    /**
     * 見出し。改行は自分で決めて、横幅いっぱいになる大きさは機械に出させる。
     * 「タイトル・飾り」なので、字幕なしで書き出しても残る。
     */
    key: 'title',
    label: '幅いっぱいの見出し',
    group: 'title',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 140,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 8,
      strokeColor2: '#ffffff',
      strokeWidth2: 6,
      shadow: 0,
      maxWidth: 0.88,
      fit: 'shrink',
      role: 'design',
      animation: 'none',
    },
  },
  {
    key: 'headline',
    label: '大きな白文字',
    group: 'title',
    text: { ...DEFAULT_TEXT, fontSize: 96, strokeWidth: 8, letterSpacing: -1, animation: 'pop' },
  },
  {
    /** 金色の見出し。上を明るく下を濃くして、光が当たっているように見せる。 */
    key: 'gold',
    label: '金色の見出し',
    group: 'title',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 120,
      weight: 400,
      color: '#fff6c2',
      color2: '#f5a000',
      strokeColor: '#4a2500',
      strokeWidth: 9,
      strokeColor2: '#ffffff',
      strokeWidth2: 5,
      shadow: 0,
      shadowY: 0,
      maxWidth: 0.9,
      role: 'design',
      animation: 'zoom',
    },
  },
  {
    /** 落ち着いた題。明朝の白い文字に、やわらかい影だけ。 */
    key: 'mincho',
    label: 'しっとり明朝',
    group: 'title',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: MINCHO,
      fontSize: 92,
      weight: 700,
      strokeWidth: 0,
      shadow: 24,
      shadowY: 4,
      shadowColor: 'rgba(0,0,0,0.8)',
      letterSpacing: 6,
      role: 'design',
      animation: 'fade',
    },
  },

  // ---------------------------------------------------------------- 強調・ツッコミ
  {
    /**
     * 立体。黄色い文字（上を明るく、下を濃く）に黒い縁と白い縁を重ね、
     * 縁と同じ濃い色の影を、ぼかさずに真下へ落とす。影が縁とつながって、文字に厚みがあるように見える。
     * 半透明の灰色の影だと、ずれた影にしか見えず安くなる。
     */
    key: 'solid',
    label: '立体の黄色',
    group: 'punch',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 104,
      weight: 400,
      color: '#fff27a',
      color2: '#ffb300',
      strokeColor: '#1a1206',
      strokeWidth: 9,
      strokeColor2: '#ffffff',
      strokeWidth2: 6,
      shadow: 0,
      shadowY: 13,
      shadowColor: '#1a1206',
      maxWidth: 0.92,
      animation: 'bounce',
    },
  },
  {
    /** ツッコミ。赤い文字に白と黒の縁。出るときに震える。 */
    key: 'tsukkomi',
    label: '赤いツッコミ',
    group: 'punch',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 112,
      weight: 400,
      color: '#ff5a4d',
      color2: '#d00018',
      strokeColor: '#ffffff',
      strokeWidth: 9,
      strokeColor2: '#1a0000',
      strokeWidth2: 7,
      shadow: 0,
      shadowY: 0,
      maxWidth: 0.92,
      animation: 'shake',
    },
  },
  {
    /**
     * 3 層の縁取り。内側から「文字の色 → 白 → 黒」。
     * 話す人ごとに文字の色だけ変えると、誰のセリフかが色で分かる。
     * 背景が明るくても暗くても読めるのは、白と黒を両方持っているため。
     */
    key: 'triple',
    label: '色文字＋白黒フチ（話す人の色分け）',
    group: 'punch',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 112,
      color: '#5cd6ff',
      strokeColor: '#ffffff',
      strokeWidth: 10,
      strokeColor2: '#000000',
      strokeWidth2: 10,
      shadow: 0,
      maxWidth: 0.94,
      animation: 'pop',
    },
  },
  {
    key: 'pop',
    label: '黄色のポップ',
    group: 'punch',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ZEN,
      fontSize: 88,
      color: '#fde047',
      strokeColor: '#7c2d12',
      strokeWidth: 8,
      animation: 'bounce',
    },
  },
  {
    key: 'neon',
    label: 'ネオン（光る水色）',
    group: 'punch',
    text: {
      ...DEFAULT_TEXT,
      fontSize: 84,
      color: '#b8f5ff',
      strokeColor: '#0b6b84',
      strokeWidth: 5,
      shadow: 28,
      animation: 'zoom',
    },
  },

  // ---------------------------------------------------------------- 飾り・札
  {
    /**
     * 視聴者のコメントなどを札にして見せる形。
     * 台紙があるぶん、文字だけより「引用している」ことがはっきりする。
     * 「タイトル・飾り」なので、字幕なしで書き出しても残る。
     */
    key: 'card',
    label: 'コメントの札',
    group: 'deco',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROCKNROLL,
      fontSize: 64,
      weight: 700,
      color: '#1f2937',
      strokeWidth: 0,
      strokeWidth2: 0,
      shadow: 0,
      maxWidth: 0.68,
      role: 'design',
      animation: 'pop',
      frame: {
        ...DEFAULT_TEXT_FRAME,
        heading: 'コメント',
        iconLeft: 'message-circle',
        iconRight: 'languages',
      },
    },
  },
  {
    /** やわらかい色の帯に、丸い文字。心の声・ひとこと・補足に。 */
    key: 'pastel',
    label: 'パステルの吹き出し風',
    group: 'deco',
    text: {
      ...DEFAULT_TEXT,
      fontFamily: ROUNDED,
      fontSize: 62,
      weight: 800,
      color: '#5b3a4a',
      strokeWidth: 0,
      bgColor: '#ffe1ec',
      bgOpacity: 1,
      shadow: 0,
      shadowY: 0,
      maxWidth: 0.8,
      animation: 'pop',
    },
  },
];

export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 3];

export const LOOK_PRESETS: { key: string; label: string; effects: { type: string; intensity: number }[] }[] = [
  { key: 'none', label: 'オリジナル', effects: [] },
  { key: 'vivid', label: 'ビビッド', effects: [{ type: 'saturate', intensity: 0.72 }, { type: 'contrast', intensity: 0.6 }] },
  { key: 'clean', label: 'クリア', effects: [{ type: 'brightness', intensity: 0.6 }, { type: 'saturate', intensity: 0.56 }] },
  { key: 'film', label: 'フィルム', effects: [{ type: 'sepia', intensity: 0.2 }, { type: 'contrast', intensity: 0.62 }] },
  { key: 'mono', label: 'モノクロ', effects: [{ type: 'grayscale', intensity: 1 }, { type: 'contrast', intensity: 0.6 }] },
  { key: 'dream', label: 'ドリーム', effects: [{ type: 'blur', intensity: 0.06 }, { type: 'brightness', intensity: 0.56 }] },
];
