/**
 * 素材の置き場所（共有 / 個人）。
 *
 * これは「この NAS がどう配信されているか」の設定であって、個人の好みではない。
 * だからプロフィールごとに分けず、端末で 1 つだけ持つ。
 * 分けてしまうと、人が増えるたびに同じパスを入れ直す羽目になる。
 *
 * どちらもページからの相対パスで持つ。NAS のホスト名や口（ポート）が変わっても、
 * また UGREENlink 経由の URL で開いても、プロジェクトが壊れないようにするため。
 */

export interface MediaRoots {
  /** 皆で使う素材。 */
  shared: string;
  /**
   * 個人素材の親フォルダ。この下に人ごとのフォルダが並ぶ想定。
   * 実際に見に行くのは `personal + そのプロフィールの folder + '/'`。
   */
  personal: string;
}

export const DEFAULT_MEDIA_ROOTS: MediaRoots = {
  shared: 'media/',
  personal: 'media-personal/',
};

const KEY = 'vivid.media-roots';

/** 末尾の `/` を必ず 1 つ付ける（`listFolder` が連結して使うため）。 */
export function normalizeBase(base: string): string {
  const trimmed = base.trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * @param legacyShared 旧 `settings.mediaBase`。初回だけ共有側の初期値に引き継ぐ。
 */
export function loadMediaRoots(legacyShared?: string): MediaRoots {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_MEDIA_ROOTS, ...(JSON.parse(raw) as Partial<MediaRoots>) };
  } catch {
    /* 読めないときは既定で始める */
  }
  const shared = normalizeBase(legacyShared ?? '') || DEFAULT_MEDIA_ROOTS.shared;
  return { ...DEFAULT_MEDIA_ROOTS, shared };
}

export function saveMediaRoots(roots: MediaRoots): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(roots));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

/**
 * その人の個人素材フォルダ。設定が足りなければ null（＝個人素材は使えない）。
 */
export function personalBaseFor(roots: MediaRoots, folder: string): string | null {
  const parent = normalizeBase(roots.personal);
  const own = folder.trim().replace(/^\/+|\/+$/g, '');
  if (!parent || !own) return null;
  return `${parent}${own}/`;
}
