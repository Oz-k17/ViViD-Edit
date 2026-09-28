/**
 * **持ち出しファイルの並べ方（二進の入れ物）。**
 *
 * ```
 * [0,8)        "VIVIDPK1"           目印
 * [8,12)       uint32LE             見出しの**バイト**長 H
 * [12,12+H)    見出し（UTF-8 の JSON）
 * [12+H, …)    実体。見出しの bodies の順に、隙間なく並べる
 * ```
 *
 * ## なぜ JSON に base64 で埋めないのか
 *
 * 測った結果は `README.md` に置いたが、要点は 2 つ。
 *
 *  - base64 は 1.333 倍に太る。**それより効くのが文字列の上限**で、
 *    V8 は 1 本の文字列を 536,870,888 文字までしか持てない。
 *    `JSON.stringify` はファイル全体を 1 本の文字列にするので、
 *    **素材の合計が 384MB を越えたところで作れなくなる**（1 本ごとではなく合計）。
 *  - 読む側も `await file.text()` で 1 本の文字列にする。同じ壁が開く側にもある。
 *
 * 二進で並べておけば、書く側は `new Blob([前置き, ...実体の Blob])` で済み、
 * 読む側は `blob.slice(offset, offset+length)` で**1 バイトも起こさずに**
 * その素材の実体を取り出せる（`URL.createObjectURL` にそのまま渡せる）。
 *
 * ## 位置は「実体域の先頭から」の相対で持つ
 *
 * ファイル先頭からの絶対位置で書くと、**位置の桁が伸びたぶん見出しが伸びて、
 * その伸びたぶん位置がずれる**（不動点を解く話になる）。実体域の先頭を 0 にすれば
 * 見出しの長さと位置が切り離せるので、1 回で決まる。
 */

import { embedded, planPack, type PackPlan, type PlanOptions } from './plan.ts';
import { PackError, type BodySource, type PackAssetMeta, type PackProject, type PackReader } from './types.ts';

export const PACK_MAGIC = 'VIVIDPK1';
/** 入れ物の版。読めない版のファイルは、黙って壊すより断る。 */
export const PACK_VERSION = 1;

const MAGIC_BYTES = 8;
const LENGTH_BYTES = 4;
export const PACK_PREAMBLE = MAGIC_BYTES + LENGTH_BYTES;

/** 実体 1 つの在り処。位置は実体域の先頭を 0 とした相対。 */
export interface PackBodyEntry {
  id: string;
  offset: number;
  length: number;
}

export interface PackHeader {
  app: 'vivid-edit';
  /** 入れ物の版（`PACK_VERSION`）。本体の `ProjectFile.version` とは別物。 */
  pack: number;
  savedAt: number;
  project: PackProject;
  /** 運んだ素材の覚え書き（参照も実体入りも両方）。 */
  assets: PackAssetMeta[];
  /** 実体を入れた素材の在り処。 */
  bodies: PackBodyEntry[];
  /** 運べなかった素材の名前。 */
  localOnly: string[];
}

/**
 * 並べ方が決まった状態。**実体はまだ 1 バイトも読んでいない。**
 *
 * ブラウザ側はこれを受けて `new Blob([prefix, ...order の Blob])` を作るだけでよく、
 * 実体がメモリに乗らない。Node で測るときは `realizePack` が実際のバイト列にする。
 */
export interface PackLayout {
  header: PackHeader;
  /** 目印＋見出しの長さ＋見出し。 */
  prefix: Uint8Array;
  /** 実体をこの順に繋げる。 */
  order: PackBodyEntry[];
  totalBytes: number;
  plan: PackPlan;
}

function encodeHeader(header: PackHeader): { prefix: Uint8Array; headerBytes: number } {
  // **長さは「文字数」ではなく「バイト数」で書く。**
  // 素材名に日本語が入ると JSON の文字数と UTF-8 のバイト数がずれるので、
  // 文字数で書くと見出しの終わりが手前にずれて、実体の頭が見出しに食われる。
  const json = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(PACK_PREAMBLE + json.length);
  for (let i = 0; i < MAGIC_BYTES; i += 1) prefix[i] = PACK_MAGIC.charCodeAt(i);
  new DataView(prefix.buffer).setUint32(MAGIC_BYTES, json.length, true);
  prefix.set(json, PACK_PREAMBLE);
  return { prefix, headerBytes: json.length };
}

/**
 * 並べ方を決める。実体を読まないので、書き出す前に「何バイトになるか」が出る。
 */
export function layoutPack(
  project: PackProject,
  assets: Map<string, PackAssetMeta>,
  bodies: BodySource,
  options: PlanOptions = {},
): PackLayout {
  const plan = planPack(project, assets, bodies, options);

  const order: PackBodyEntry[] = [];
  let offset = 0;
  for (const entry of embedded(plan)) {
    order.push({ id: entry.meta.id, offset, length: entry.bytes });
    offset += entry.bytes;
  }

  const header: PackHeader = {
    app: 'vivid-edit',
    pack: PACK_VERSION,
    savedAt: Date.now(),
    project,
    assets: plan.entries.filter((e) => e.disposition !== 'dropped').map((e) => e.meta),
    bodies: order,
    localOnly: plan.dropped,
  };

  const { prefix } = encodeHeader(header);
  return { header, prefix, order, totalBytes: prefix.length + offset, plan };
}

/**
 * 並べ方を実際のバイト列にする（測る側と検算のため）。
 * ブラウザでは呼ばない——ここで初めて実体がメモリに乗るので、
 * 本物は `new Blob([layout.prefix, ...実体の Blob])` で済ませる。
 */
export async function realizePack(layout: PackLayout, bodies: BodySource): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [layout.prefix];
  for (const entry of layout.order) parts.push(await bodies.bytes(entry.id));
  return parts;
}

/** 生バイトを読む口にする（測る側と検算のため。本物は `Blob.slice`）。 */
export function readerFromBytes(bytes: Uint8Array): PackReader {
  return {
    size: bytes.length,
    // subarray なので写しは作らない。Blob.slice と同じく「切るのはタダ」を保つ。
    read: async (start, end) => bytes.subarray(start, end),
  };
}

export interface OpenedPack {
  header: PackHeader;
  /** 実体域の先頭のファイル内位置。 */
  bodyBase: number;
  /**
   * 見出しに載っていたが、ファイルの中に収まっていなかった素材の名前。
   *
   * **1 つ壊れていても全部を捨てない。** 本体の `parseProjectFile` も
   * 形の合わない素材だけを落とす。ただし黙って落とすと「開いたら一部が黒い」になるので、
   * 名前をここに出して呼び出し側に知らせる（本体の `localOnly` と同じ扱い）。
   */
  outOfRange: string[];
}

/**
 * 見出しだけを読む。**実体は読まない**ので、10GB のファイルでもここは一瞬で終わる。
 *
 * 中身は人が手で触れる形（JSON）なので、信じきらずに形を確かめる。
 */
export async function openPack(reader: PackReader): Promise<OpenedPack> {
  if (reader.size < PACK_PREAMBLE) {
    throw new PackError('ファイルが短すぎます（ViViD Edit の持ち出しファイルではないようです）。');
  }

  const head = await reader.read(0, PACK_PREAMBLE);
  if (head.length < PACK_PREAMBLE) throw new PackError('ファイルの頭を読めませんでした。');
  let magic = '';
  for (let i = 0; i < MAGIC_BYTES; i += 1) magic += String.fromCharCode(head[i]);
  if (magic !== PACK_MAGIC) {
    throw new PackError('ViViD Edit の持ち出しファイルではないようです。');
  }

  // DataView は渡された範囲の外を読めてしまうので、byteOffset を必ず添える
  // （subarray で来た口だと head.buffer の先頭はファイルの先頭とは限らない）。
  const headerBytes = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(MAGIC_BYTES, true);
  if (headerBytes === 0) throw new PackError('見出しが空です（壊れています）。');
  if (PACK_PREAMBLE + headerBytes > reader.size) {
    throw new PackError('見出しがファイルの外へはみ出しています（途中で切れている可能性があります）。');
  }

  const raw = await reader.read(PACK_PREAMBLE, PACK_PREAMBLE + headerBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new PackError('見出しを読めませんでした（壊れています）。');
  }

  const header = parsed as Partial<PackHeader>;
  if (header?.app !== 'vivid-edit') throw new PackError('ViViD Edit の持ち出しファイルではないようです。');
  if (typeof header.pack !== 'number' || header.pack > PACK_VERSION) {
    throw new PackError(
      `新しい版で作られたファイルです（版 ${String(header.pack)}）。アプリを新しくしてから開いてください。`,
    );
  }
  const project = header.project;
  if (!project?.sequence?.tracks || !Array.isArray(project.sequence.tracks)) {
    throw new PackError('プロジェクトの中身が壊れています（トラックがありません）。');
  }

  const bodyBase = PACK_PREAMBLE + headerBytes;
  const available = reader.size - bodyBase;
  const assets = Array.isArray(header.assets)
    ? header.assets.filter((a): a is PackAssetMeta => typeof a?.id === 'string')
    : [];
  const nameOf = new Map(assets.map((a) => [a.id, a.name]));

  const bodies: PackBodyEntry[] = [];
  const outOfRange: string[] = [];
  for (const entry of Array.isArray(header.bodies) ? header.bodies : []) {
    const ok =
      typeof entry?.id === 'string' &&
      Number.isSafeInteger(entry.offset) &&
      Number.isSafeInteger(entry.length) &&
      entry.offset >= 0 &&
      entry.length >= 0 &&
      entry.offset + entry.length <= available;
    if (!ok) {
      outOfRange.push(nameOf.get(entry?.id) ?? String(entry?.id ?? '(名前なし)'));
      continue;
    }
    bodies.push({ id: entry.id, offset: entry.offset, length: entry.length });
  }

  return {
    header: {
      app: 'vivid-edit',
      pack: header.pack,
      savedAt: typeof header.savedAt === 'number' ? header.savedAt : Date.now(),
      project,
      assets,
      bodies,
      localOnly: Array.isArray(header.localOnly) ? header.localOnly.filter((n) => typeof n === 'string') : [],
    },
    bodyBase,
    outOfRange,
  };
}

/**
 * その素材の実体がファイルのどこにあるかを、**ファイル先頭からの位置**で返す。
 * ブラウザ側はこれを `blob.slice(start, end)` に渡すだけで実体が手に入る。
 */
export function locateBody(opened: OpenedPack, id: string): { start: number; end: number } | null {
  const entry = opened.header.bodies.find((b) => b.id === id);
  if (!entry) return null;
  return { start: opened.bodyBase + entry.offset, end: opened.bodyBase + entry.offset + entry.length };
}

/** 実体を 1 つ取り出す。要る 1 つだけを読むので、ほかの素材は起こさない。 */
export async function readBody(reader: PackReader, opened: OpenedPack, id: string): Promise<Uint8Array | null> {
  const at = locateBody(opened, id);
  if (!at) return null;
  return reader.read(at.start, at.end);
}
