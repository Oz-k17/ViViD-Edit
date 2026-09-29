/**
 * **持ち出したファイルの中身が、書いたときと同じかを確かめる値（ハッシュ）。**
 *
 * 9/28（1 回目）の積み残しに「実体の中身が合っているかを見る手が無い。長さが合っていれば通る」と
 * 書いた所。9/28 の README には「入れない」と書いてあり、理由が 2 つ挙がっていたが、
 * **どちらも「ファイル全体で 1 つ持つ」ときの話だった**
 * （数字は `npm run lab:pack:digest` と README の 7）。
 *
 * ## 決めたこと
 *
 *  - **素材ごとに 1 つ**持つ（ファイル全体で 1 つにしない）。
 *    全体で 1 つだと、書くのにも確かめるのにも**ファイルを丸ごと**読ませることになり、
 *    96MB で **+251MB の山**が立つ（実体の 2.62 倍。9/28 に二進を選んだ理由がそれで消える）。
 *    素材ごとなら上乗せは 0 で、ブラウザでもいちばん大きい素材 1 本ぶんで止まる。
 *  - **開くときには計算しない。「確かめる」ときだけ計算する。**
 *    開くのに要るのは見出しだけで、そこは 10GB のファイルでも一瞬で終わる（`openPack`）。
 *    ハッシュを開く条件にすると、その速さが丸ごと消える。
 *  - **合わなかった素材は落とすが、ファイルは断らない。**
 *    `outOfRange` と同じ扱い（`README.md` の「壊れたファイルの扱い」）。
 *    ただし**列は分ける**——位置が範囲外なのは「読めない」、ハッシュが合わないのは
 *    「読めるが中身が違う」で、人に伝えることが違う。
 *  - **書かれていないものは「駄目」ではなく「分からない」。**
 *    ハッシュ無しで書かれたファイル（`digests: 'none'`）や古いファイルを、
 *    壊れていることにしてはいけない。状態は 3 つ（`ok` / `mismatch` / `unknown`）。
 *
 * ## なぜ `crypto.subtle` で書くか
 *
 * Node にはもっと速い `node:crypto`（`createHash`）があり、そちらは**流し込める**。
 * それでもここは `crypto.subtle` を使う。判断する所をブラウザと同じ道にしておかないと、
 * 「Node では流し込めたのにブラウザでは乗り切らない」を測り落とす。
 * 速さの差そのものは `npm run lab:pack:digest` が両方並べて出す（1.21 倍だった）。
 */

import { encodeBase64 } from './thumbs.ts';
import type { BodySource, PackReader } from './types.ts';

/**
 * ハッシュの置き所。
 *
 * | | どこへ | 見出しの太り（素材 1000 個） | 開く |
 * | --- | --- | --- | --- |
 * | `none` | 持たない | 0 | 5.20ms |
 * | `header` | 見出しの `bodies` の中（既定） | +52.7KB | 5.77ms |
 * | `section` | 見出しと絵の間に、32 バイトずつ並べる | +0（域が 31.3KB） | 6.48ms |
 *
 * **サムネイルと答えが逆になった。** 絵（1 枚 5KB）は追い出すと開くのが 10 倍速くなったが、
 * ハッシュ（1 つ 44 バイト）は**追い出しても開く時間が動かない**（上の 3 つは
 * 振れ幅 4.1〜17.3ms の中に全部入る）。**効かないなら域を増やさない**ほうを既定にした。
 * 数字は `README.md` の 7。`section` は比べる相手として残してある。
 */
export type DigestPlacement = 'none' | 'header' | 'section';

/** sha-256 の生バイト数。`section` はこの固定長で並べる。 */
export const DIGEST_BYTES = 32;

/**
 * **端だけのハッシュ（先頭 N バイト＋末尾 N バイト）で見る幅 N。既定は 64KB。**
 *
 * 9/28（3 回目）の積み残し「ハッシュを端だけで取る形を測っていない」。
 * 費用は全部「実体を丸ごと読む」に出る（3.6ms/MB）ので、端だけなら
 * 素材の大きさに依らない定数になる。**何を見つけられなくなるかは
 * `npm run lab:pack:edge` で測った**（README の 8）。
 *
 * 64KB を既定にしたのは、7.4 で「抜き取り 1 本」の費用として実測した幅と同じにして、
 * **読む量を揃えたまま「1 本だけ」と「全部の端」を比べられる**ようにするため。
 */
export const DEFAULT_EDGE_BYTES = 64 * 1024;

/** ファイルの中の範囲。`[from, to)`。 */
export interface ByteRange {
  from: number;
  to: number;
}

/**
 * 端だけを見るとき、実体のどこを読むか。
 *
 * **`length <= edge * 2` なら 1 本にまとめて丸ごと返す。** 頭と尻を別々に返すと
 * 真ん中が二重に混ざり、同じバイト列なのに**全部を見たときと値が変わる**。
 * まとめておけば小さい実体では端＝全部になり、`edgeHash === hash` が成り立つ
 * （検算で固定してある）。ここを間違えると「小さい素材だけ必ず違う」になる。
 */
export function edgeRanges(length: number, edge: number = DEFAULT_EDGE_BYTES): ByteRange[] {
  const len = Math.max(0, length);
  const n = Math.max(0, Math.floor(edge));
  if (n === 0 || len <= n * 2) return [{ from: 0, to: len }];
  return [
    { from: 0, to: n },
    { from: len - n, to: len },
  ];
}

/** 端だけを見るときに読むバイト数。 */
export function edgeReadBytes(length: number, edge: number = DEFAULT_EDGE_BYTES): number {
  return edgeRanges(length, edge).reduce((sum, r) => sum + (r.to - r.from), 0);
}

export type VerifyState = 'ok' | 'mismatch' | 'unknown';

/**
 * どこまで読んで確かめるか。
 *
 * | | 読む量 | 見つかるもの |
 * | --- | --- | --- |
 * | `full`（既定） | 実体を丸ごと | 中身の化けも、ずれも |
 * | `edge` | 端 2×64KB だけ | **ずれだけ**（中の化けは端に落ちたぶんだけ） |
 *
 * **`edge` は `full` の安い版ではなく、見つけるものが違う検査。**
 * 数字は README の 8。混ぜて読まないこと。
 */
export type VerifyDepth = 'full' | 'edge';

export interface VerifyEntry {
  id: string;
  /** 人に見せる名前（見出しから引く。無ければ id）。 */
  name: string;
  state: VerifyState;
  /** 読んだバイト数。`unknown` では 0（読まずに済ませる）。 */
  bytesRead: number;
}

export interface VerifyReport {
  entries: VerifyEntry[];
  /** 中身が違った素材の名前。**`outOfRange` とは別の列で出す。** */
  mismatch: string[];
  /** ハッシュが書かれていなかった素材の名前。 */
  unknown: string[];
  bytesRead: number;
}

/** 生バイトの sha-256 を base64 で返す。 */
export async function digestOf(bytes: Uint8Array): Promise<string> {
  // `subtle.digest` は BufferSource を丸ごと受け取る形しか無い（少しずつ食わせられない）。
  // だから**素材ごとに分ける**のが効く。ここが `node:crypto` と違う所で、
  // 「ブラウザでも同じ道が通る」を守るためにこちらで書いている（上の注）。
  //
  // **`bytes.buffer` ではなく `bytes` を渡す。** ファイルから切り出した実体は
  // 大きな buffer の一部を指す `subarray` で来るので、`buffer` を渡すと
  // **範囲の外まで混ぜて数える**。view を渡せば範囲は守られ、写しも増えない
  // （`buffer.slice` で範囲を切ると、そこで実体ぶんの写しが 1 つ立つ）。
  // 型の上だけの言い直し。`Uint8Array` の buffer は `SharedArrayBuffer` かもしれない、と
  // 型が言うので `BufferSource` に収まらない（実体は必ず `ArrayBuffer` で来る）。
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return encodeBase64(new Uint8Array(digest));
}

/**
 * いくつかの切れ端をつないで 1 つのハッシュにする。**端だけを見るときに通る道。**
 *
 * `subtle.digest` に流し込む口が無いので、**ここでだけ写しを 1 つ作る**（端の 2×64KB ぶん）。
 * 実体を丸ごと繋ぐのと形は同じだが、大きさが実体に比例しないので山にならない
 * （丸ごと繋ぐと 96MB で +251MB になる——README の 7.1）。
 * 切れ端が 1 本のときは繋がない（写しを増やさない）。
 */
export async function digestOfParts(parts: Uint8Array[]): Promise<string> {
  if (parts.length === 1) return digestOf(parts[0]);
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return digestOf(joined);
}

/**
 * 端だけ（先頭 N ＋末尾 N）のハッシュ。**長さは混ぜない。**
 *
 * 長さは見出しの `bodies` に書いてあり、そこがずれる形は位置の門（`outOfRange`）が
 * 先に見つける。混ぜると小さい実体で `edgeHash === hash` が成り立たなくなり、
 * 「端＝全部」という境界が読む側から見えなくなる。
 */
export async function edgeDigestOf(bytes: Uint8Array, edge: number = DEFAULT_EDGE_BYTES): Promise<string> {
  return digestOfParts(edgeRanges(bytes.byteLength, edge).map((r) => bytes.subarray(r.from, r.to)));
}

/** 生の 32 バイトを base64 に直す（`section` から読んだものを見出しの形に合わせる）。 */
export function digestToText(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/** 何を出すか。`whole` が丸ごとのハッシュ、`edge` が端だけ（0 なら持たない）。 */
export interface DigestSpec {
  whole: boolean;
  edge: number;
}

export interface BodyDigests {
  hash?: string;
  edgeHash?: string;
}

/**
 * 実体ごとのハッシュを出す。**1 本ずつ読んで、その場で捨てる。**
 *
 * 山はいちばん大きい素材 1 本ぶんで止まる（全部を抱えない）。
 * ここだけは実体を読むので、`layoutPack` からは切り離してある——
 * 「詰める計画は実体を 1 バイトも読まない」を壊さないため
 * （画面に「このファイルは何 MB になります」を出すのは計画の段の仕事）。
 *
 * **端だけを書くときは、実体も端だけ読む**（`BodySource.slice` があれば）。
 * ここが「端だけにすると 100 分の 1 になるはず」の 100 分の 1 が出てくる唯一の場所で、
 * 丸ごと読んでから端を切っても費用は 1 バイトも下がらない
 * （ブラウザでは `Blob.slice(…).arrayBuffer()` がこの `slice` にあたる）。
 */
export async function digestBodies(
  ids: string[],
  bodies: BodySource,
  spec: DigestSpec = { whole: true, edge: 0 },
): Promise<Map<string, BodyDigests>> {
  const out = new Map<string, BodyDigests>();
  for (const id of ids) {
    // 大きさが分からない持ち主では端を切れないので、丸ごと読む側へ落とす
    // （**0 バイト扱いにして「何も無い」のハッシュを書くと、黙って全部の実体が通る**）。
    const known = bodies.size(id);
    if (!spec.whole && spec.edge > 0 && bodies.slice && known !== undefined) {
      const parts: Uint8Array[] = [];
      for (const r of edgeRanges(known, spec.edge)) parts.push(await bodies.slice(id, r.from, r.to));
      out.set(id, { edgeHash: await digestOfParts(parts) });
      continue;
    }
    // 丸ごと要るなら 1 回だけ読んで、そこから両方を作る。
    // **端のぶんに読み直しは要らない**（読んだ物の上で切るだけ）。
    const bytes = await bodies.bytes(id);
    // **2N 以下の実体には端のぶんを書かない。** そこは端＝全部なので、
    // 書くと**同じ 44 文字が見出しに 2 つ並ぶ**だけになる（測って気づいた——README の 8.5）。
    // 読む側は「端＝全部」の境界を長さから出せるので、丸ごとのぶんで確かめられる。
    const duplicate = spec.whole && bytes.byteLength <= spec.edge * 2;
    out.set(id, {
      ...(spec.whole ? { hash: await digestOf(bytes) } : {}),
      ...(spec.edge > 0 && !duplicate ? { edgeHash: await edgeDigestOf(bytes, spec.edge) } : {}),
    });
  }
  return out;
}

/** 確かめる相手（`verifyBodies` に渡す形）。要るほうのハッシュが無ければ `unknown` になる。 */
export interface VerifyTarget {
  id: string;
  name: string;
  /** ファイル先頭からの位置。 */
  start: number;
  end: number;
  hash?: string;
  /** 端だけのハッシュ（`depth: 'edge'` のときに使う）。 */
  edgeHash?: string;
}

/**
 * 実体を読み直して、書いたときのハッシュと突き合わせる。
 *
 * **1 本読んで、確かめて、捨てる**を繰り返す（`digestBodies` と同じ理由）。
 * 呼ぶ側が相手を選べるようにしてあるのは、**全部を確かめる必要が無い場合がある**から。
 * 域の長さがずれた壊れ方（`README.md` の 6.4）は実体の位置を**全部**ずらすので、
 * 1 本でも合わなければ分かる（`cheapestFirst` がその 1 本を選ぶ）。
 */
export async function verifyBodies(
  reader: PackReader,
  targets: VerifyTarget[],
  { depth = 'full', edge = 0 }: { depth?: VerifyDepth; edge?: number } = {},
): Promise<VerifyReport> {
  const entries: VerifyEntry[] = [];
  let bytesRead = 0;

  for (const target of targets) {
    const length = Math.max(0, target.end - target.start);
    // **端＝全部になる大きさでは、丸ごとのぶんで端を確かめる。**
    // 書く側がそこに `edgeHash` を置かない（同じ値になるので）ぶんの受け側。
    // ここが無いと、小さい素材だけ「分からない」になって読む側から境界が見えなくなる。
    // **幅が無いときに既定の幅で埋めない。** 埋めると、その幅より小さい実体では
    // 「端＝全部」が成り立ってしまい、**端の検査が黙って丸ごとの検査に化ける**
    // （幅が読めないファイルでも小さい素材だけ ok と言い出す）。検算が捕まえた穴。
    const wholeIsEdge = edge > 0 && length <= edge * 2;
    const want =
      depth === 'edge'
        ? edge > 0
          ? (target.edgeHash ?? (wholeIsEdge ? target.hash : undefined))
          : undefined
        : target.hash;
    if (!want) {
      // **読まない。** 書かれていないものを読んでも分かることは増えない。
      entries.push({ id: target.id, name: target.name, state: 'unknown', bytesRead: 0 });
      continue;
    }
    // **端だけのときは、読む範囲を実体の頭からの相対で決めてからファイルの位置へ移す。**
    // ファイル上の位置で先に足すと、`length` が 0 の実体で頭と尻が同じ所を指す。
    const ranges = depth === 'edge' ? edgeRanges(length, edge) : [{ from: 0, to: length }];
    const parts: Uint8Array[] = [];
    let read = 0;
    for (const r of ranges) {
      const part = await reader.read(target.start + r.from, target.start + r.to);
      read += r.to - r.from;
      parts.push(part);
    }
    const got = await digestOfParts(parts);
    bytesRead += read;
    entries.push({
      id: target.id,
      name: target.name,
      state: got === want ? 'ok' : 'mismatch',
      bytesRead: read,
    });
  }

  return {
    entries,
    mismatch: entries.filter((e) => e.state === 'mismatch').map((e) => e.name),
    unknown: entries.filter((e) => e.state === 'unknown').map((e) => e.name),
    bytesRead,
  };
}

/**
 * 読む量の小さい順に並べ替える。**抜き取りで確かめるとき用。**
 *
 * 空（0 バイト）の実体は**いちばん後ろへ回す**。読む量は 0 で確かめられるが、
 * 位置がずれていても 0 バイトのハッシュはいつでも合うので、
 * 「ずれ」を見つける役には立たない（確かめた——`selftest.ts`）。
 */
export function cheapestFirst(targets: VerifyTarget[]): VerifyTarget[] {
  return [...targets].sort((a, b) => {
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (la === 0 !== (lb === 0)) return la === 0 ? 1 : -1;
    return la - lb;
  });
}
