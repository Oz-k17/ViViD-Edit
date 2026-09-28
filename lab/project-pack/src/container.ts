/**
 * **持ち出しファイルの並べ方（二進の入れ物）。**
 *
 * ```
 * [0,8)              "VIVIDPK1"         目印
 * [8,12)             uint32LE           見出しの**バイト**長 H
 * [12,12+H)          見出し（UTF-8 の JSON）
 * [12+H, 12+H+D)     ハッシュ域（長さ D。`digests: 'section'` のときだけ。既定は D=0）
 * [12+H+D, +T)       サムネイル域（長さ T。`thumbs: 'section'` のときだけ。既定は T=0）
 * [12+H+D+T, …)      実体。見出しの bodies の順に、隙間なく並べる
 * ```
 *
 * サムネイル域を挟める理由と、挟む／挟まないの数字は `thumbs.ts` と `README.md` に書いた。
 * **T は見出しの中に書く**（`thumbBytes`）。T は見出しの長さに依らないので、
 * 下の「位置は実体域の先頭から」と同じく、ここにも不動点は出てこない。
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

import {
  cheapestFirst,
  digestBodies,
  digestToText,
  DIGEST_BYTES,
  verifyBodies,
  type DigestPlacement,
  type VerifyReport,
  type VerifyTarget,
} from './digest.ts';
import { embedded, planPack, type PackPlan, type PlanOptions } from './plan.ts';
import { decodeBase64, splitDataUrl, type PackThumbEntry, type ThumbPlacement } from './thumbs.ts';
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
  /**
   * 中身のハッシュ（`digests: 'header'` のときだけ。`digest.ts`）。
   *
   * **位置と違って、これは無くても読める。** 無いファイルは「壊れている」ではなく
   * 「確かめられない」なので、`verifyPack` では `unknown` になる。
   */
  hash?: string;
  /**
   * ハッシュ域の何番目に自分のハッシュがあるか（`digests: 'section'` のときだけ）。
   *
   * **ファイルには書かない。`openPack` が数えて入れる**（書くと見出しが太るだけ。
   * 実測で素材 1000 個の見出しが 14.5KB 膨らんだ）。
   * 域は**見出しに書いてあった順**に 32 バイトずつ並んでいるので、
   * 位置の合わない実体を落とした後の並びで数えると 1 つずれる。
   * だから数えるのは落とす前の並びで。
   */
  digestAt?: number;
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
  /**
   * サムネイルの置き所（`thumbs.ts`）。**見て分かるように書いておく。**
   * `thumbs` の位置が何を 0 とした相対なのかがこれで決まるので、
   * 「サムネイル域の長さが 0 かどうか」から察させる形にはしない
   * （サムネイルが 1 枚も無い `section` と `scattered` が同じ形になってしまう）。
   */
  thumbPlacement: ThumbPlacement;
  /** サムネイル域の長さ。`section` 以外では 0。 */
  thumbBytes: number;
  /** 追い出したサムネイルの在り処。`inline` では空。 */
  thumbs: PackThumbEntry[];
  /**
   * ハッシュの置き所（`digest.ts`）。**サムネイルと同じ理由で、見て分かるように書いておく。**
   * 「ハッシュ域の長さが 0 かどうか」から察させると、実体が 0 個の `section` と
   * `none` が同じ形になってしまう。
   */
  digestPlacement: DigestPlacement;
  /** ハッシュ域の長さ（32 × 実体の数）。`section` 以外では 0。 */
  digestBytes: number;
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
  /**
   * サムネイル域の中身（`section` のときだけ。見出しの `thumbs` と同じ順）。
   *
   * ここだけは実体と違って**もうメモリに乗っている**——元が見出しの中の
   * data URL 文字列なので、剥がした生バイトは 4 分の 3 に縮んだ写しになる。
   */
  thumbParts: Uint8Array[];
  /**
   * ハッシュ域の中身（`digests: 'section'` のときだけ。見出しの bodies と同じ順）。
   * `attachDigests` を通すまでは空。
   */
  digestParts: Uint8Array[];
  /**
   * ハッシュを実際に計算して入れ終わったか。
   *
   * **`layoutPack` は実体を読まない**という決まりがあるので、ハッシュはここでは出せない
   * （読まないと出せない）。それでも域の長さ（32 × 実体の数）は読まずに決まるので、
   * 場所だけ先に空けて `attachDigests` で埋める形にした。
   * 埋め忘れたまま書くと**全部が「中身が違う」になる**ので、`realizePack` が断る。
   */
  digestsAttached: boolean;
  /** 実体をこの順に繋げる。 */
  order: PackBodyEntry[];
  /**
   * 前置きの後ろに繋げるもの、ぜんぶをこの順で。
   *
   * `inline` / `section` では `thumbParts` → `order` を並べただけだが、
   * `scattered` では**実体とサムネイルが交互に入る**ので、そこだけは
   * 2 本の列では書き表せない。書き出す側はこの 1 本だけを見ればよい。
   */
  parts: PackPart[];
  totalBytes: number;
  plan: PackPlan;
}

/** 前置きの後ろに並ぶもの 1 つ。ハッシュとサムネイルは中身を持ち、実体は長さだけ持つ。 */
export type PackPart =
  | { kind: 'digest'; id: string; bytes: Uint8Array }
  | { kind: 'thumb'; id: string; bytes: Uint8Array }
  | { kind: 'body'; id: string; length: number };

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

export interface LayoutOptions extends PlanOptions {
  /**
   * サムネイルの置き所（`thumbs.ts`）。**既定は `section`**（2026-09-28・2 回目に測って決めた）。
   * `inline` は「いまの本体の形」として比べるために残してある。
   */
  thumbs?: ThumbPlacement;
  /**
   * ハッシュの置き所（`digest.ts`）。**既定は `header`**（2026-09-28・3 回目に測って決めた）。
   * `none` は 9/28（2 回目）までの形として、`section` は比べる相手として残してある。
   */
  digests?: DigestPlacement;
}

/**
 * 並べ方を決める。**実体は読まない**ので、書き出す前に「何バイトになるか」が出る。
 *
 * サムネイルだけは別で、`section` / `scattered` ではここで data URL を剥がす。
 * 実体と違ってもう手元の文字列に入っているものなので、読む／読まないの話にならない。
 */
export function layoutPack(
  project: PackProject,
  assets: Map<string, PackAssetMeta>,
  bodies: BodySource,
  options: LayoutOptions = {},
): PackLayout {
  const plan = planPack(project, assets, bodies, options);
  const placement: ThumbPlacement = options.thumbs ?? 'section';
  const kept = plan.entries.filter((e) => e.disposition !== 'dropped');

  // 追い出せる絵と、追い出せない覚え書きを先に分ける。
  // **剥がせなかったものは見出しに残す**（空文字・外部 URL・壊れた base64）。
  // ここで黙って落とすと、開いた側でサムネイルだけ消える。
  const pulled = new Map<string, { type: string; bytes: Uint8Array }>();
  const metas = kept.map((e) => e.meta);
  if (placement !== 'inline') {
    for (const [i, meta] of metas.entries()) {
      const split = meta.thumbnail ? splitDataUrl(meta.thumbnail) : null;
      if (!split) continue;
      pulled.set(meta.id, split);
      metas[i] = { ...meta, thumbnail: '' };
    }
  }

  const embeds = new Map(embedded(plan).map((e) => [e.meta.id, e.bytes]));
  const parts: PackPart[] = [];
  const thumbs: PackThumbEntry[] = [];
  const order: PackBodyEntry[] = [];

  if (placement === 'scattered') {
    // 「実体と同じ扱いで後ろへ回す」をそのまま書いた形。1 つの域に、
    // 素材ごとに実体 → サムネイルの順で入る。**サムネイルが実体の間に散る。**
    let offset = 0;
    for (const meta of metas) {
      const size = embeds.get(meta.id);
      if (size !== undefined) {
        order.push({ id: meta.id, offset, length: size });
        parts.push({ kind: 'body', id: meta.id, length: size });
        offset += size;
      }
      const thumb = pulled.get(meta.id);
      if (thumb) {
        thumbs.push({ id: meta.id, offset, length: thumb.bytes.length, type: thumb.type });
        parts.push({ kind: 'thumb', id: meta.id, bytes: thumb.bytes });
        offset += thumb.bytes.length;
      }
    }
  } else {
    // `section` はサムネイルを先にまとめる。`inline` は `pulled` が空なので、
    // 同じ道を通って何も足さずに抜ける。
    let thumbOffset = 0;
    for (const meta of metas) {
      const thumb = pulled.get(meta.id);
      if (!thumb) continue;
      thumbs.push({ id: meta.id, offset: thumbOffset, length: thumb.bytes.length, type: thumb.type });
      parts.push({ kind: 'thumb', id: meta.id, bytes: thumb.bytes });
      thumbOffset += thumb.bytes.length;
    }
    let offset = 0;
    for (const entry of embedded(plan)) {
      order.push({ id: entry.meta.id, offset, length: entry.bytes });
      parts.push({ kind: 'body', id: entry.meta.id, length: entry.bytes });
      offset += entry.bytes;
    }
  }

  const thumbBytes = placement === 'section' ? thumbs.reduce((sum, t) => sum + t.length, 0) : 0;
  // **ハッシュ域の長さは、実体を 1 バイトも読まずに決まる**（32 × 実体の数）。
  // 中身が決まるのは `attachDigests` だが、長さがここで決まるので
  // サムネイル域も実体の位置も動かない。不動点が出てこないのは
  // 「位置は域の先頭からの相対」という決まりのおかげ（このファイルの頭の注）。
  const digests: DigestPlacement = options.digests ?? 'header';
  const digestBytes = digests === 'section' ? DIGEST_BYTES * order.length : 0;
  // **番号はファイルに書かない。** 域は見出しの `bodies` と同じ順なので、
  // 何番目かは読む側が数えれば分かる（`openPack`）。最初は書いていたが、
  // 測ったら素材 1000 個で見出しが 14.5KB 太っていた——**「見出しから追い出す」ために
  // 足した形が、見出しを太らせていた。**
  const header: PackHeader = {
    app: 'vivid-edit',
    pack: PACK_VERSION,
    savedAt: Date.now(),
    project,
    assets: metas,
    bodies: order,
    localOnly: plan.dropped,
    thumbPlacement: placement,
    thumbBytes,
    thumbs,
    digestPlacement: digests,
    digestBytes,
  };

  const { prefix } = encodeHeader(header);
  const after = parts.reduce((sum, p) => sum + (p.kind === 'body' ? p.length : p.bytes.length), 0);
  // **`section` のときだけ埋める。** `scattered` では絵が実体の間に散るので、
  // これを `[prefix, ...thumbParts, ...実体]` と繋ぐと位置が全部ずれたファイルになる。
  // 書き出す側が見るのは `parts` 1 本、という決まりをここで守らせる。
  const thumbParts =
    placement === 'section'
      ? parts.filter((p): p is Extract<PackPart, { kind: 'thumb' }> => p.kind === 'thumb').map((p) => p.bytes)
      : [];
  return {
    header,
    prefix,
    thumbParts,
    digestParts: [],
    // ハッシュを持たない形は、この時点でもう書ける。
    digestsAttached: digests === 'none',
    order,
    parts,
    totalBytes: prefix.length + digestBytes + after,
    plan,
  };
}

/**
 * ハッシュを計算して並べ方に入れる。**ここで初めて実体を読む**（1 本ずつ、読んだら捨てる）。
 *
 * `layoutPack` と分けてあるのは、あちらの「実体を 1 バイトも読まない」を守るため。
 * 画面に「このファイルは何 MB になります」を出すのは `layoutPack` の仕事で、
 * そこにハッシュの費用（96MB で 0.3 秒）を混ぜたくない。
 *
 * **`header` なら、埋めても位置は 1 つも動かない**（見出しが伸びるだけで、
 * 実体の位置は実体域の先頭からの相対なので）。`section` は長さが先に空いている。
 */
export async function attachDigests(layout: PackLayout, bodies: BodySource): Promise<PackLayout> {
  const placement = layout.header.digestPlacement;
  // 2 回通しても同じ結果になるようにする。`section` で 2 回通すと
  // **域が 2 つ並んだファイル**になり、位置が全部ずれる（長さの辻褄だけ合わない形）。
  if (placement === 'none' || layout.digestsAttached) return layout;

  const hashes = await digestBodies(
    layout.order.map((b) => b.id),
    bodies,
  );

  if (placement === 'header') {
    const order = layout.order.map((b) => ({ ...b, hash: hashes.get(b.id) }));
    const header = { ...layout.header, bodies: order };
    const { prefix } = encodeHeader(header);
    const after = layout.parts.reduce((sum, p) => sum + (p.kind === 'body' ? p.length : p.bytes.length), 0);
    return {
      ...layout,
      header,
      prefix,
      order,
      digestsAttached: true,
      totalBytes: prefix.length + after,
    };
  }

  // `section`: 生の 32 バイトを見出しの bodies の順に並べて、前置きの直後に置く。
  // base64 にしないのは、域に置くなら 1.333 倍がそのまま損になるから（サムネイルと同じ話）。
  const digestParts = layout.order.map((b) => decodeDigest(hashes.get(b.id)!));
  return {
    ...layout,
    digestParts,
    digestsAttached: true,
    parts: [...layout.order.map((b, i) => ({ kind: 'digest' as const, id: b.id, bytes: digestParts[i] })), ...layout.parts],
  };
}

/** base64 の 44 文字を生の 32 バイトへ。`section` に置くときだけ通る。 */
function decodeDigest(text: string): Uint8Array {
  const bytes = decodeBase64(text);
  if (!bytes || bytes.length !== DIGEST_BYTES) {
    throw new PackError('ハッシュの形が合いません（作り方の間違いです）。');
  }
  return bytes;
}

/**
 * 並べ方を実際のバイト列にする（測る側と検算のため）。
 * ブラウザでは呼ばない——ここで初めて実体がメモリに乗るので、
 * 本物は `new Blob([layout.prefix, ...実体の Blob])` で済ませる。
 */
export async function realizePack(layout: PackLayout, bodies: BodySource): Promise<Uint8Array[]> {
  // **埋め忘れたまま書かせない。** 空けただけのハッシュ域を書くと、
  // 開いた側では「全部の実体の中身が違う」になる。壊れていないのに壊れて見えるのが
  // いちばん悪いので、ここで止める（`attachDigests` を通し忘れたときに必ず踏む）。
  if (!layout.digestsAttached) {
    throw new PackError('ハッシュを入れる約束のまま、計算せずに書こうとしています（attachDigests が要ります）。');
  }
  const out: Uint8Array[] = [layout.prefix];
  for (const part of layout.parts) {
    // **`kind` を並べて書く。** ここを「実体でなければ絵」の形（`kind === 'thumb' ? … : 実体`）で
    // 書いていたら、3 つ目（ハッシュ）を足したとたんハッシュの所に**実体が丸ごと**入った
    // （測って気づいた。ファイルが 67MB → 130MB に膨らんだ）。
    // 中身を持つものが 2 種類になったので、取り違えても長さの辻褄は合ってしまう。
    out.push(part.kind === 'body' ? await bodies.bytes(part.id) : part.bytes);
  }
  return out;
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
  /** ハッシュ域の先頭のファイル内位置（`section` 以外では長さ 0 の域を指す）。 */
  digestBase: number;
  /** サムネイル域の先頭のファイル内位置（`section` 以外では実体域と同じ所を指す）。 */
  thumbBase: number;
  /**
   * 見出しに載っていたが、ファイルの中に収まっていなかった素材の名前。
   *
   * **1 つ壊れていても全部を捨てない。** 本体の `parseProjectFile` も
   * 形の合わない素材だけを落とす。ただし黙って落とすと「開いたら一部が黒い」になるので、
   * 名前をここに出して呼び出し側に知らせる（本体の `localOnly` と同じ扱い）。
   */
  outOfRange: string[];
  /**
   * サムネイルだけが取れなかった素材の名前。**実体とは分けて出す。**
   *
   * 絵が出ないのと素材が開けないのは、人にとって重さがまるで違う。
   * 同じ列に混ぜると「この 3 つは運べません」が水増しされて、
   * 本当に運べなかったものが埋もれる。
   */
  thumbsOutOfRange: string[];
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

  const digestBase = PACK_PREAMBLE + headerBytes;
  const digestPlacement: DigestPlacement =
    header.digestPlacement === 'header' || header.digestPlacement === 'section' ? header.digestPlacement : 'none';
  /**
   * ハッシュ域の長さ。
   *
   * **サムネイル域とまったく同じ理由で、丸めて先へ進めない**（この値も実体域の頭を決める）。
   * 加えて中身が 32 バイトの固定長なので、**32 で割れない長さは形からして嘘**だと分かる。
   * ここで断れば、ずれたハッシュを読んで「全部の中身が違う」と言い出すのを防げる。
   */
  let digestBytes = 0;
  if (digestPlacement === 'section') {
    const declared = header.digestBytes;
    if (!Number.isSafeInteger(declared) || (declared as number) < 0 || (declared as number) % DIGEST_BYTES !== 0) {
      throw new PackError('ハッシュ域の長さが読めません（ファイルが壊れています）。');
    }
    digestBytes = declared as number;
    if (digestBase + digestBytes > reader.size) {
      throw new PackError('ハッシュ域がファイルの外へはみ出しています（途中で切れている可能性があります）。');
    }
  }
  const thumbBase = digestBase + digestBytes;
  const placement: ThumbPlacement =
    header.thumbPlacement === 'section' || header.thumbPlacement === 'scattered' ? header.thumbPlacement : 'inline';
  /**
   * サムネイル域の長さ。
   *
   * **ここだけは丸めて先へ進めない。** この値が実体域の先頭そのものなので、
   * 0 や負へ倒して読み進めると**実体の位置が全部ずれたまま**、位置も長さも辻褄が合って
   * 中身だけが別物になる（長さは通るので気づけない）。0 以上の整数でなければ断る。
   * `section` 以外では域が無いので 0 で確定する。
   */
  let thumbBytes = 0;
  if (placement === 'section') {
    const declared = header.thumbBytes;
    if (!Number.isSafeInteger(declared) || (declared as number) < 0) {
      throw new PackError('サムネイル域の長さが読めません（ファイルが壊れています）。');
    }
    thumbBytes = declared as number;
    if (thumbBase + thumbBytes > reader.size) {
      throw new PackError('サムネイル域がファイルの外へはみ出しています（途中で切れている可能性があります）。');
    }
    // 域の中にあるはずの絵が域からはみ出していたら、同じ理由でそこも断る
    // （絵 1 枚を落とすのでは済まず、域の長さそのものが疑わしいことになる）。
    const needed = (Array.isArray(header.thumbs) ? header.thumbs : []).reduce(
      (max, t) => (Number.isSafeInteger(t?.offset) && Number.isSafeInteger(t?.length) ? Math.max(max, t.offset + t.length) : max),
      0,
    );
    if (needed > thumbBytes) {
      throw new PackError('サムネイル域の長さが合っていません（ファイルが壊れています）。');
    }
  }
  const bodyBase = thumbBase + thumbBytes;
  const available = reader.size - bodyBase;
  const assets = Array.isArray(header.assets)
    ? header.assets.filter((a): a is PackAssetMeta => typeof a?.id === 'string')
    : [];
  const nameOf = new Map(assets.map((a) => [a.id, a.name]));

  /** 位置と長さが、その域に収まっているか。嘘は「壊れている」ではなく「その 1 つを落とす」。 */
  const fits = (entry: { offset?: unknown; length?: unknown }, room: number) =>
    Number.isSafeInteger(entry?.offset) &&
    Number.isSafeInteger(entry?.length) &&
    (entry.offset as number) >= 0 &&
    (entry.length as number) >= 0 &&
    (entry.offset as number) + (entry.length as number) <= room;

  const bodies: PackBodyEntry[] = [];
  const outOfRange: string[] = [];
  const declared = Array.isArray(header.bodies) ? header.bodies : [];
  for (const [at, entry] of declared.entries()) {
    if (typeof entry?.id !== 'string' || !fits(entry, available)) {
      outOfRange.push(nameOf.get(entry?.id) ?? String(entry?.id ?? '(名前なし)'));
      continue;
    }
    bodies.push({
      id: entry.id,
      offset: entry.offset,
      length: entry.length,
      // ハッシュは「無くても読める」ので、形が違えば黙って捨てる（`unknown` になるだけ）。
      ...(digestPlacement === 'header' && typeof entry.hash === 'string' ? { hash: entry.hash } : {}),
      // **番号は落とす前の並びで数える**（`digestAt` の注）。
      ...(digestPlacement === 'section' ? { digestAt: at } : {}),
    });
  }

  // サムネイルの在り処は、置き所によって何を 0 とした相対かが変わる。
  // `section` はサムネイル域、`scattered` は実体域。**`inline` では 1 つも読まない**
  // （見出しの `thumbnail` がそのまま絵なので、外に置く必要が無い）。
  const thumbRoom = placement === 'section' ? thumbBytes : available;
  const thumbs: PackThumbEntry[] = [];
  const thumbsOutOfRange: string[] = [];
  if (placement !== 'inline') {
    for (const entry of Array.isArray(header.thumbs) ? header.thumbs : []) {
      if (typeof entry?.id !== 'string' || !fits(entry, thumbRoom)) {
        thumbsOutOfRange.push(nameOf.get(entry?.id) ?? String(entry?.id ?? '(名前なし)'));
        continue;
      }
      thumbs.push({
        id: entry.id,
        offset: entry.offset,
        length: entry.length,
        type: typeof entry.type === 'string' && entry.type ? entry.type : 'application/octet-stream',
      });
    }
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
      thumbPlacement: placement,
      thumbBytes,
      thumbs,
      digestPlacement,
      digestBytes,
    },
    bodyBase,
    thumbBase,
    digestBase,
    outOfRange,
    thumbsOutOfRange,
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

/** そのサムネイルがファイルのどこにあるか。`inline` と、追い出せなかった素材では `null`。 */
export function locateThumb(opened: OpenedPack, id: string): { start: number; end: number } | null {
  const entry = opened.header.thumbs.find((t) => t.id === id);
  if (!entry) return null;
  const base = opened.header.thumbPlacement === 'section' ? opened.thumbBase : opened.bodyBase;
  return { start: base + entry.offset, end: base + entry.offset + entry.length };
}

/**
 * **一覧を出すのに要る範囲**を、読む順に返す。
 *
 * ここが `section` と `scattered` の分かれ目そのもの。`section` では隣り合う範囲が
 * 1 本に繋がるので、実際に読むのは**一続きの 1 回**で済む。
 * `scattered` では実体を挟むので繋がらず、**素材の数だけ読む**ことになる。
 * 繋げる仕事をここに置いてあるのは、**どちらが何回読むのかを数字で見せるため**
 * （呼ぶ側が気を利かせて繋いでしまうと、置き所の違いが消えて見える）。
 */
export function thumbRanges(opened: OpenedPack): { start: number; end: number }[] {
  const spans = opened.header.thumbs
    .map((t) => locateThumb(opened, t.id))
    .filter((r): r is { start: number; end: number } => r !== null && r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const out: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span.start === last.end) last.end = span.end;
    else out.push({ ...span });
  }
  return out;
}

/** サムネイルを 1 枚取り出す。ブラウザでは `blob.slice` の結果をそのまま絵にできる。 */
export async function readThumb(
  reader: PackReader,
  opened: OpenedPack,
  id: string,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  const at = locateThumb(opened, id);
  if (!at) return null;
  const entry = opened.header.thumbs.find((t) => t.id === id)!;
  return { bytes: await reader.read(at.start, at.end), type: entry.type };
}

export interface VerifyOptions {
  /** 確かめる素材を選ぶ。省くと全部。 */
  ids?: string[];
  /**
   * **抜き取りの本数。** 読む量の小さい順にこの数だけ確かめる。
   *
   * 全部を確かめる必要が無い場合があるので付けてある。域の長さがずれた壊れ方
   * （`README.md` の 6.4 が心配していた形）は実体の位置を**全部**同じだけずらすので、
   * **いちばん小さい実体 1 本でも見つかる**（測った——README の 7.4）。
   * 逆に「1 本だけ中身が化けた」はその 1 本を引かないと見つからないので、
   * **抜き取りで見つかるのは「ずれ」だけ**。ここを混ぜて読まないこと。
   */
  sample?: number;
}

/**
 * 実体の中身が、書いたときと同じかを確かめる。
 *
 * `section` のときだけ、ここでハッシュ域を 1 回読む（`header` なら見出しに入っている）。
 * 実体は**1 本ずつ読んで捨てる**ので、山はいちばん大きい素材 1 本ぶんで止まる（`digest.ts`）。
 */
export async function verifyPack(
  reader: PackReader,
  opened: OpenedPack,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const nameOf = new Map(opened.header.assets.map((a) => [a.id, a.name]));
  let sectionBytesRead = 0;
  let section: Uint8Array | null = null;
  if (opened.header.digestPlacement === 'section' && opened.header.digestBytes > 0) {
    section = await reader.read(opened.digestBase, opened.digestBase + opened.header.digestBytes);
    sectionBytesRead = opened.header.digestBytes;
  }

  const wanted = options.ids ? new Set(options.ids) : null;
  let targets: VerifyTarget[] = [];
  for (const entry of opened.header.bodies) {
    if (wanted && !wanted.has(entry.id)) continue;
    const at = locateBody(opened, entry.id);
    if (!at) continue;
    let hash = entry.hash;
    if (section && entry.digestAt !== undefined) {
      const from = entry.digestAt * DIGEST_BYTES;
      // 域が短くて自分のぶんが入っていないときは「分からない」に倒す。
      // 域の長さそのものは `openPack` が形（32 の倍数・ファイルに収まる）で見ている。
      if (from + DIGEST_BYTES <= section.length) {
        hash = digestToText(section.subarray(from, from + DIGEST_BYTES));
      }
    }
    targets.push({ id: entry.id, name: nameOf.get(entry.id) ?? entry.id, start: at.start, end: at.end, hash });
  }

  if (options.sample !== undefined) targets = cheapestFirst(targets).slice(0, Math.max(0, options.sample));

  const report = await verifyBodies(reader, targets);
  // ハッシュ域を読んだぶんも足して返す（「確かめるのに何バイト読んだか」を濁さない）。
  return { ...report, bytesRead: report.bytesRead + sectionBytesRead };
}
