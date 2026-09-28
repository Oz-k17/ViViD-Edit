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

export type VerifyState = 'ok' | 'mismatch' | 'unknown';

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

/** 生の 32 バイトを base64 に直す（`section` から読んだものを見出しの形に合わせる）。 */
export function digestToText(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/**
 * 実体ごとのハッシュを出す。**1 本ずつ読んで、その場で捨てる。**
 *
 * 山はいちばん大きい素材 1 本ぶんで止まる（全部を抱えない）。
 * ここだけは実体を読むので、`layoutPack` からは切り離してある——
 * 「詰める計画は実体を 1 バイトも読まない」を壊さないため
 * （画面に「このファイルは何 MB になります」を出すのは計画の段の仕事）。
 */
export async function digestBodies(ids: string[], bodies: BodySource): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of ids) {
    out.set(id, await digestOf(await bodies.bytes(id)));
  }
  return out;
}

/** 確かめる相手（`verifyBodies` に渡す形）。`hash` が無ければ `unknown` になる。 */
export interface VerifyTarget {
  id: string;
  name: string;
  /** ファイル先頭からの位置。 */
  start: number;
  end: number;
  hash?: string;
}

/**
 * 実体を読み直して、書いたときのハッシュと突き合わせる。
 *
 * **1 本読んで、確かめて、捨てる**を繰り返す（`digestBodies` と同じ理由）。
 * 呼ぶ側が相手を選べるようにしてあるのは、**全部を確かめる必要が無い場合がある**から。
 * 域の長さがずれた壊れ方（`README.md` の 6.4）は実体の位置を**全部**ずらすので、
 * 1 本でも合わなければ分かる（`cheapestFirst` がその 1 本を選ぶ）。
 */
export async function verifyBodies(reader: PackReader, targets: VerifyTarget[]): Promise<VerifyReport> {
  const entries: VerifyEntry[] = [];
  let bytesRead = 0;

  for (const target of targets) {
    if (!target.hash) {
      // **読まない。** 書かれていないものを読んでも分かることは増えない。
      entries.push({ id: target.id, name: target.name, state: 'unknown', bytesRead: 0 });
      continue;
    }
    const bytes = await reader.read(target.start, target.end);
    const got = await digestOf(bytes);
    const read = Math.max(0, target.end - target.start);
    bytesRead += read;
    entries.push({
      id: target.id,
      name: target.name,
      state: got === target.hash ? 'ok' : 'mismatch',
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
