/**
 * 軽量な多言語化。
 * 日本語の文字列そのものをキーにして、英語だけ辞書で引く。
 * 辞書に無ければ日本語がそのまま出るので、訳し忘れても画面は壊れない。
 */

export type Lang = 'ja' | 'en';

const EN: Record<string, string> = {
  // 共通
  エディタ: 'Editor',
  素材管理: 'Media',
  設定: 'Settings',
  テンプレート: 'Templates',
  テンプレート集: 'Templates',
  保存: 'Save',
  適用: 'Apply',
  削除: 'Delete',
  複製: 'Duplicate',
  追加: 'Add',
  閉じる: 'Close',
  戻す: 'Undo',
  進む: 'Redo',
  なし: 'None',
  名前: 'Name',
  秒: 's',
  すべて: 'All',
  未分類: 'Unsorted',
  効果音: 'Sound FX',
  読込中: 'Loading',
  // エディタ
  素材: 'Media',
  プレビュー: 'Preview',
  タイムライン: 'Timeline',
  プロパティ: 'Properties',
  エフェクト: 'Effects',
  テキスト: 'Text',
  書き出し: 'Export',
  再生: 'Play',
  一時停止: 'Pause',
  分割: 'Split',
  リップル削除: 'Ripple delete',
  スナップ: 'Snap',
  ズーム: 'Zoom',
  トラック: 'Track',
  クリップ: 'Clip',
  トランジション: 'Transition',
  ショートカット: 'Shortcuts',
  ガイド: 'Guides',
  ループ: 'Loop',
  // プロパティ
  不透明度: 'Opacity',
  音量: 'Volume',
  スケール: 'Scale',
  速度: 'Speed',
  回転: 'Rotation',
  横位置: 'Position X',
  縦位置: 'Position Y',
  フェードイン: 'Fade in',
  フェードアウト: 'Fade out',
  背景ぼかし: 'Blurred background',
  ぼかし強さ: 'Blur amount',
  拡大率: 'Zoom',
  クロップ: 'Crop',
  配置: 'Placement',
  フォント: 'Font',
  サイズ: 'Size',
  太さ: 'Weight',
  文字色: 'Text color',
  フチ色: 'Outline color',
  フチの太さ: 'Outline width',
  影: 'Shadow',
  背景色: 'Background',
  背景の濃さ: 'Background opacity',
  揃え: 'Align',
  折り返し幅: 'Wrap width',
  アニメーション: 'Animation',
  入場アニメーション: 'Entrance animation',
  画角: 'Aspect ratio',
  画質: 'Quality',
  形式: 'Format',
  フレームレート: 'Frame rate',
  タイトル: 'Title',
  言語: 'Language',
};

let current: Lang = 'ja';

export function setLang(lang: Lang) {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(text: string): string {
  if (current === 'ja') return text;
  return EN[text] ?? text;
}
