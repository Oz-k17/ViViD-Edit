/**
 * **比べる相手：JSON に base64 で実体を埋める形。**
 *
 * いちばん素直で、いまの本体（`buildProjectFile` ＋ `JSON.stringify`）から
 * いちばん近い所にある形。捨てるなら「太るから」ではなく**測った上で**捨てたいので、
 * ちゃんと動くものを書いて並べる。
 *
 * base64 の変換だけは外から渡す。Node の `Buffer` を使えば速いが、
 * それを中に書くとブラウザで動かなくなる（ラボの決まり：判断する所は環境に依らせない）。
 */

import { embedded, planPack, type PackPlan, type PlanOptions } from './plan.ts';
import { PackError, type BodySource, type PackAssetMeta, type PackProject } from './types.ts';

export const JSON_PACK_VERSION = 1;

/**
 * 1 本の文字列に入る文字数の上限（V8 の `String::kMaxLength`）。
 * 環境によって違うので、外から渡せるようにしてある（測る側が実測値を渡す）。
 */
export const MAX_STRING_LENGTH = 536_870_888;

export interface JsonPackAsset extends PackAssetMeta {
  /** 実体（base64）。参照素材では持たない。 */
  body?: string;
}

export interface JsonPackFile {
  app: 'vivid-edit';
  version: number;
  savedAt: number;
  project: PackProject;
  assets: JsonPackAsset[];
  localOnly: string[];
}

export type ToBase64 = (bytes: Uint8Array) => string;
export type FromBase64 = (text: string) => Uint8Array;

export interface BuiltJsonPack {
  text: string;
  plan: PackPlan;
}

/**
 * 1 本の文字列にして返す。
 *
 * **ここが壁になる。** `JSON.stringify` は入れ物ぜんたいを 1 本の文字列にするので、
 * V8 の上限（536,870,888 文字）を越えると `Invalid string length` で落ちる。
 * base64 は 4/3 に太るから、生バイトで約 384MB が天井。しかも
 * **1 本ごとではなく合計**なので、100MB の素材 4 つでも越える。
 *
 * 見た目を整える（`JSON.stringify(x, null, 2)` の字下げ）は本体がやっているが、
 * ここでは入れていない。字下げは base64 の 1 行には効かないうえ、
 * 文字数の上限を無駄に食う。
 */
export async function buildJsonPack(
  project: PackProject,
  assets: Map<string, PackAssetMeta>,
  bodies: BodySource,
  toBase64: ToBase64,
  options: PlanOptions = {},
  maxStringLength = MAX_STRING_LENGTH,
): Promise<BuiltJsonPack> {
  const plan = planPack(project, assets, bodies, options);

  // **先に数えて断る。** `toString('base64')` に渡してから RangeError を受けると、
  // その時点で実体の 1.33 倍を積み終えているので、落ちる瞬間がいちばん重い。
  // 太り方は変換しなくても分かる（`base64Length`）ので、積む前に言える。
  if (base64Length(plan.embedBytes) > maxStringLength) {
    throw new PackError(
      `素材が大きすぎて 1 つの JSON に入りません（実体 ${plan.embedBytes} バイト → base64 ` +
        `${base64Length(plan.embedBytes)} 文字 > 上限 ${maxStringLength} 文字）。`,
    );
  }

  const embeds = new Set(embedded(plan).map((e) => e.meta.id));

  const list: JsonPackAsset[] = [];
  for (const entry of plan.entries) {
    if (entry.disposition === 'dropped') continue;
    if (!embeds.has(entry.meta.id)) {
      list.push({ ...entry.meta });
      continue;
    }
    list.push({ ...entry.meta, body: toBase64(await bodies.bytes(entry.meta.id)) });
  }

  const file: JsonPackFile = {
    app: 'vivid-edit',
    version: JSON_PACK_VERSION,
    savedAt: Date.now(),
    project,
    assets: list,
    localOnly: plan.dropped,
  };

  return { text: JSON.stringify(file), plan };
}

/**
 * 読む。**実体を 1 つだけ要るときでも、ファイル全部を文字列にして JSON にしないと
 * その 1 つへ手が届かない。** ここが二進の入れ物との決定的な差。
 */
export function parseJsonPack(text: string): JsonPackFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // 上限を越えた文字列は JSON.parse まで行かずに落ちることもあるので、文言を分けておく。
    throw new PackError(`持ち出しファイルとして読めませんでした（${error instanceof Error ? error.message : '不明'}）。`);
  }
  const file = parsed as Partial<JsonPackFile>;
  if (file?.app !== 'vivid-edit') throw new PackError('ViViD Edit の持ち出しファイルではないようです。');
  if (typeof file.version !== 'number' || file.version > JSON_PACK_VERSION) {
    throw new PackError(`新しい版で作られたファイルです（版 ${String(file.version)}）。`);
  }
  if (!file.project?.sequence?.tracks || !Array.isArray(file.project.sequence.tracks)) {
    throw new PackError('プロジェクトの中身が壊れています（トラックがありません）。');
  }
  return {
    app: 'vivid-edit',
    version: file.version,
    savedAt: typeof file.savedAt === 'number' ? file.savedAt : Date.now(),
    project: file.project,
    assets: Array.isArray(file.assets) ? file.assets.filter((a): a is JsonPackAsset => typeof a?.id === 'string') : [],
    localOnly: Array.isArray(file.localOnly) ? file.localOnly.filter((n) => typeof n === 'string') : [],
  };
}

/** 実体を取り出す。無ければ null。 */
export function jsonPackBody(file: JsonPackFile, id: string, fromBase64: FromBase64): Uint8Array | null {
  const asset = file.assets.find((a) => a.id === id);
  if (!asset?.body) return null;
  return fromBase64(asset.body);
}

/**
 * base64 が何文字になるか（変換せずに数える）。
 * 壁に当たるかどうかを**実際に作る前に**言うために要る。
 */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}
