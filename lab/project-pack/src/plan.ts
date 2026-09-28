/**
 * **何を運び、何を運ばないかを決める段。**
 *
 * 本体の `buildProjectFile` は「参照素材の在り処だけを畳み、取り込み素材は名前を控えて落とす」。
 * ここはその判断に**実体を埋める**という 3 つ目の行き先を足したもの。
 * ファイルの並べ方（`container.ts`）とは分けてある。決め方だけなら実体を 1 バイトも読まずに
 * 出せるので、「この構成なら何 MB になるか」を書き出す前に言える。
 *
 * ## 3 つの行き先
 *
 * | | どうする | なぜ |
 * | --- | --- | --- |
 * | `ref` | 在り処（`src`）だけ入れる | 実体は相手にも見えている。二重に運ぶ意味が無い |
 * | `embed` | 実体をファイルに入れる | 相手の端末には無い。入れるしか渡す道が無い |
 * | `dropped` | 名前だけ控える | 実体がもう手元に無い／上限を超えた |
 *
 * **参照素材の実体は、手元にあっても埋めない。** 開いた側は `src` を先に見るので
 * 埋めたぶんは使われず、ファイルだけが太る。ここは測るより先に決まる。
 *
 * ## 上限について
 *
 * 上限は既定では**無い**。理由は `README.md` の「上限が要るのは JSON の側だけ」。
 * 二進の入れ物は流しながら書けるので、詰まるのはディスクだけになる。
 * それでも上限を渡せるようにしてあるのは、JSON に埋める形と並べて測るため。
 */

import type { BodySource, PackAssetMeta, PackProject } from './types.ts';

export type Disposition = 'ref' | 'embed' | 'dropped';

export interface PlannedAsset {
  meta: PackAssetMeta;
  disposition: Disposition;
  /** 埋めるバイト数。`ref` と `dropped` は 0。 */
  bytes: number;
  /** なぜそうなったか。画面にそのまま出せる文にしておく。 */
  reason: string;
}

export interface PackPlan {
  entries: PlannedAsset[];
  /** 実体として入るバイト数の合計。 */
  embedBytes: number;
  /** 運べなかった素材の名前。本体の `localOnly` と同じ役。 */
  dropped: string[];
}

/**
 * プロジェクトで実際に使われている素材の id。
 *
 * 本体の `usedMediaIds` と**同じ拾い方**にしてある（絵文字トークンまで拾う）。
 * 本体の正規表現は `[^}]+` で、テロップを描く側（`types.ts` の `EMOJI_TOKEN_RE`）の
 * `[A-Za-z0-9_-]+` より緩い。緩い側は取りこぼさないので、拾いすぎた id は
 * 素材が見つからず落ちるだけ。合わせるより、緩いほうへ倒しておく。
 */
export function usedMediaIds(project: PackProject): Set<string> {
  const ids = new Set<string>();
  for (const clip of project.sequence.clips) {
    if (clip.mediaId) ids.add(clip.mediaId);
    for (const match of (clip.text?.content ?? '').matchAll(/\{\{emoji:([^}]+)\}\}/g)) ids.add(match[1]);
  }
  return ids;
}

export interface PlanOptions {
  /** 実体の合計の上限（バイト）。既定は無制限。 */
  embedLimit?: number;
}

/**
 * 詰める計画を立てる。**実体は読まない**（`BodySource.size` しか呼ばない）。
 *
 * 並べる順は、素材の登録順（`createdAt`）ではなく **id の昇順**。
 * `usedMediaIds` が返す `Set` の順はクリップの並びに依るので、
 * クリップを 1 つ動かしただけで実体の位置が全部ずれる。位置がずれると
 * 「同じプロジェクトを 2 回書き出したら同じファイルになる」が崩れて、差分も取れない。
 */
export function planPack(
  project: PackProject,
  assets: Map<string, PackAssetMeta>,
  bodies: BodySource,
  options: PlanOptions = {},
): PackPlan {
  const limit = options.embedLimit ?? Number.POSITIVE_INFINITY;
  const entries: PlannedAsset[] = [];
  const dropped: string[] = [];
  let embedBytes = 0;

  for (const id of [...usedMediaIds(project)].sort()) {
    const meta = assets.get(id);
    // もう手元に無い素材。開いた側でも同じく欠けるだけなので、名前も出さない
    // （本体も同じ扱い。「消した素材」を毎回蒸し返されても直せない）。
    if (!meta) continue;

    if (meta.src) {
      entries.push({ meta, disposition: 'ref', bytes: 0, reason: '参照素材（在り処だけ入れる）' });
      continue;
    }

    const size = bodies.size(id);
    if (size === undefined) {
      entries.push({ meta, disposition: 'dropped', bytes: 0, reason: '実体が手元に無い' });
      dropped.push(meta.name);
      continue;
    }

    if (embedBytes + size > limit) {
      entries.push({
        meta,
        disposition: 'dropped',
        bytes: 0,
        reason: `上限（${limit} バイト）を超える`,
      });
      dropped.push(meta.name);
      continue;
    }

    entries.push({ meta, disposition: 'embed', bytes: size, reason: '取り込み素材（実体ごと入れる）' });
    embedBytes += size;
  }

  return { entries, embedBytes, dropped };
}

/** 計画のうち、実体を入れるものだけ。 */
export function embedded(plan: PackPlan): PlannedAsset[] {
  return plan.entries.filter((e) => e.disposition === 'embed');
}
