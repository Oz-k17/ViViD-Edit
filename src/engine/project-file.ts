/**
 * プロジェクトを 1 個のファイルとして受け渡す。
 *
 * これが成り立つのは、素材を**参照**で持っているときだけ（`media.ts` を見よ）。
 * 取り込んだ素材は実体がその人のブラウザの中にしかないので、ファイルに入れようが無い。
 * なので書き出すときは、参照素材の在り処（相対パス）と寸法だけを一緒に畳んでおき、
 * 開いた側は同じ素材フォルダが見えていれば、そのまま同じ物を開ける。
 *
 * 取り込み素材が混ざっていたら、黙って落とさずに名前を控えて知らせる。
 * 「開いたけど一部が黒い」より「この 3 つは運べません」の方が扱いやすい。
 */

import type { Project } from '../model/types';
import { mediaRegistry, type MediaAsset } from './media';

export const PROJECT_FILE_VERSION = 1;

/** ファイルに畳む素材。url は開いた側で src から作り直すので持たない。 */
export type PortableAsset = Omit<MediaAsset, 'url' | 'src'> & { src: string };

export interface ProjectFile {
  app: 'vivid-edit';
  version: number;
  savedAt: number;
  project: Project;
  /** 参照素材だけ。 */
  assets: PortableAsset[];
  /** 運べなかった取り込み素材の名前。 */
  localOnly: string[];
}

/** プロジェクトで実際に使われている素材の id を集める。使っていない物まで運ばない。 */
function usedMediaIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const clip of project.sequence.clips) {
    if (clip.mediaId) ids.add(clip.mediaId);
    // テロップに差し込んだ絵文字も素材なので拾う。
    for (const match of (clip.text?.content ?? '').matchAll(/\{\{emoji:([^}]+)\}\}/g)) ids.add(match[1]);
  }
  return ids;
}

export function buildProjectFile(project: Project): ProjectFile {
  const assets: PortableAsset[] = [];
  const localOnly: string[] = [];

  for (const id of usedMediaIds(project)) {
    const asset = mediaRegistry.get(id);
    if (!asset) continue; // もう手元に無い素材。開いた側でも同じく欠けるだけ。
    if (!asset.src) {
      localOnly.push(asset.name);
      continue;
    }
    // プロキシはこの端末の中だけのもの。ファイルには持たせない。
    const { url: _url, src, proxy: _proxy, proxyUrl: _proxyUrl, ...rest } = asset;
    assets.push({ ...rest, src });
  }

  return {
    app: 'vivid-edit',
    version: PROJECT_FILE_VERSION,
    savedAt: Date.now(),
    project,
    assets,
    localOnly,
  };
}

export class ProjectFileError extends Error {}

/**
 * 読み込む。中身は人が手で編集できる JSON なので、信じきらずに形を確かめる。
 * 新しい版で作ったファイルは読めない可能性があるので、その旨を言って止める。
 */
export function parseProjectFile(text: string): ProjectFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectFileError('プロジェクトファイルとして読めませんでした（JSON ではありません）。');
  }
  const file = parsed as Partial<ProjectFile>;
  if (file?.app !== 'vivid-edit') {
    throw new ProjectFileError('ViViD Edit のプロジェクトファイルではないようです。');
  }
  if (typeof file.version !== 'number' || file.version > PROJECT_FILE_VERSION) {
    throw new ProjectFileError(
      `新しい版で作られたファイルです（版 ${String(file.version)}）。アプリを新しくしてから開いてください。`,
    );
  }
  const project = file.project;
  if (!project?.sequence?.tracks || !Array.isArray(project.sequence.tracks)) {
    throw new ProjectFileError('プロジェクトの中身が壊れています（トラックがありません）。');
  }
  return {
    app: 'vivid-edit',
    version: file.version,
    savedAt: typeof file.savedAt === 'number' ? file.savedAt : Date.now(),
    project,
    assets: Array.isArray(file.assets) ? file.assets.filter((a) => typeof a?.src === 'string' && typeof a?.id === 'string') : [],
    localOnly: Array.isArray(file.localOnly) ? file.localOnly.filter((n) => typeof n === 'string') : [],
  };
}

/**
 * ファイルに入っていた参照素材をライブラリへ迎え入れる。
 * 既に同じ id があれば上書きしない（自分の整理を、もらったファイルに崩されない方がよい）。
 * 戻り値は、実際に入った数。
 */
export async function adoptProjectAssets(file: ProjectFile): Promise<number> {
  return mediaRegistry.adopt(file.assets);
}
