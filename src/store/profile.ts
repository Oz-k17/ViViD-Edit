/**
 * 「いま誰が使っているか」。
 *
 * 一台の端末を複数人で回すとき（編集用 PC を共有している、NAS のショートカットを
 * 皆が同じブラウザから開く、など）、保存先が 1 つだと下書きも素材ライブラリも
 * 混ざってしまう。そこで保存キーを人ごとに分ける。
 *
 * ここが持つのは「仕切り」であって「鍵」ではない。同じブラウザを開けば他人の
 * 名前に切り替えられるし、中身も見える。秘密を守る用途には使えない。
 *
 * 最初の 1 人（既定のプロフィール）だけは、キーを分けずに昔のまま使う。
 * 今まで 1 人で使っていた人の下書きを、移行処理なしでそのまま残すため。
 */

export interface Profile {
  id: string;
  name: string;
  /** NAS 上の個人素材フォルダ名。空なら個人素材は使わない。 */
  folder: string;
}

/** 既定のプロフィール。この人の保存キーだけは接頭辞を付けない。 */
export const DEFAULT_PROFILE_ID = 'default';

const PROFILES_KEY = 'vivid.profiles';
const CURRENT_KEY = 'vivid.profile';

function defaultProfile(): Profile {
  return { id: DEFAULT_PROFILE_ID, name: '既定', folder: '' };
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できない環境（容量超過・プライベートウィンドウ）では諦める */
  }
}

export function listProfiles(): Profile[] {
  const found = read<Profile[]>(PROFILES_KEY, []);
  if (!Array.isArray(found) || found.length === 0) return [defaultProfile()];
  // 既定が消えていても必ず 1 つは残す（切り替え先が無くなるのを防ぐ）。
  return found.filter((p) => p && typeof p.id === 'string' && p.id);
}

export function saveProfiles(profiles: Profile[]): void {
  write(PROFILES_KEY, profiles.length ? profiles : [defaultProfile()]);
}

export function currentProfileId(): string {
  const id = read<string>(CURRENT_KEY, DEFAULT_PROFILE_ID);
  const known = listProfiles().some((p) => p.id === id);
  // 消されたプロフィールが選ばれたままにならないようにする。
  return known ? id : DEFAULT_PROFILE_ID;
}

export function currentProfile(): Profile {
  const id = currentProfileId();
  return listProfiles().find((p) => p.id === id) ?? defaultProfile();
}

export function setCurrentProfileId(id: string): void {
  write(CURRENT_KEY, id);
}

/** 表示名から作る。重複しても困らないよう、実体の id は別に振る。 */
export function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 保存キーを、いまの人のものにする。
 * 既定の人は昔のキーのまま（移行処理を要らなくするため）。
 */
export function scopedKey(key: string): string {
  const id = currentProfileId();
  if (id === DEFAULT_PROFILE_ID) return key;
  // `vivid.project` → `vivid.p123.project`
  const dot = key.indexOf('.');
  if (dot < 0) return `${id}.${key}`;
  return `${key.slice(0, dot)}.${id}${key.slice(dot)}`;
}

/** 素材の実体を置く IndexedDB も人ごとに分ける。 */
export function scopedDbName(name: string): string {
  const id = currentProfileId();
  return id === DEFAULT_PROFILE_ID ? name : `${name}-${id}`;
}
