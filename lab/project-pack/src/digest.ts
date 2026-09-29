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

/**
 * **同じ読む量（2N）を、実体の端から端まで何個に分けて読むか。既定は 3。**
 *
 * 2026-09-29（2 回目）の積み残し「端の幅 N を素材の大きさで変えるか」を測った答え
 * （`npm run lab:pack:width`・README の 9）。**幅は変えない。代わりに散らす。**
 *
 * 幅を変えても買えるものが無い。端だけの覆いは「読んだ量 ÷ 実体の大きさ」そのもので、
 * **見つける確率はその数と 1 の位まで同じ**（12MB に 1 バイトの化けを 2000 か所置いて、
 * 覆い 1.0% に対し 0.9%・覆い 10.0% に対し 10.0%）。
 * 「長さの 0.5%」にすると覆いは大きさによらず 1.0% で揃うが、**揃えた先が 1.0% のまま**で、
 * 費用だけが大きさに比例して戻る（96MB の素材で 983KB）。**幅は丸ごとへの近道ではない。**
 *
 * 効くのは**幅ではなく、同じ量をどこで読むか**だった。`pieces = 2` が端だけで、
 * 3 以上にすると読み所が中へ入る（読む量は 1 バイトも変わらない）。
 *
 * | | 読む量 | 全域の 1B | 頭 64KB の中 | 両端が決まり文句の入れ替わり |
 * | --- | ---: | ---: | ---: | --- |
 * | 2（端だけ） | 128KB | 0.9% | **100%** | **×（幅をいくら広げても ×）** |
 * | **3（既定）** | 128KB | 1.4% | 66% | **○** |
 * | 16 | 128KB | 0.9% | 13% | ○ |
 *
 * **3 にした理由は、2 が「原理的に取れない」相手を 1 つ抱えているから。**
 * 同じ設定で書き出した動画は頭に同じ容器の見出しが付き、形式によっては尻も同じ形で終わる。
 * 両端が揃っている 2 本は、端だけで見ると**同じ実体に見える**——そして
 * **決まり文句がどこまで続くかは書く側に分からない**ので、幅では守れない
 * （頭 2MB ＋尻 2MB が揃った素材は、端 1MB でも見落とす）。
 * 3 は読み所を 1 つ真ん中へ置くだけでそこへ届く。
 *
 * 代価は 2 つ。**頭・尻に集中した化けが 100% → 66%**（容器の見出しが壊れる形はここに来る）と、
 * ファイルの上で 1 本 0.33 → 0.55ms（読む口を 1 回多く叩くぶん。丸ごとは 14.7ms）。
 * **どちらも一方が他方を覆わない**ので、`pieces` は読む側が選べるようにしてある。
 */
export const DEFAULT_EDGE_PIECES = 3;

/**
 * **`edgePieces` が書かれていないファイルの読み方。**
 *
 * 2026-09-29（1 回目）に書いたファイルは端だけ（＝2 個）で、見出しにこの欄が無い。
 * **そこを「いまの既定」で埋めない。** 埋めると、昔のファイルの端が全部「違う」になる。
 * 幅（`edgeBytes`）で同じ穴を踏まないようにしたのと同じ話で、
 * **欄が無いのは「分からない」ではなく「昔の形」**なので、昔の値を入れる。
 */
export const LEGACY_EDGE_PIECES = 2;

/**
 * **散らし方の上限。** これを超える数は「読めない」として扱う（端は「分からない」）。
 *
 * 上限が要るのは、**この数がそのまま読む口を叩く回数**だから。
 * 壊れた見出しが `edgePieces: 1e9` と言っただけで、読み所を 10 億個並べようとして止まる
 * （幅と違って、ここは 1 バイトも読む前に効く）。差分を粗探しして見つけた穴。
 *
 * 1024 に置いたのは、**256 個で既に「安い検査」ではなくなっている**から
 * （12MB の実体で 散らす 256 個 11.5ms 対 丸ごと 14.6ms。README の 9.4）。
 * その 4 倍まで許して、それより上は使い道が無い。
 *
 * **丸めずに断る側へ倒す。** 丸めると、見出しが 5000 と言っているファイルを
 * 1024 で読んで「中身が違う」と言い出す（嘘をつく口を増やさない——9.5）。
 */
export const MAX_EDGE_PIECES = 1024;

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
 * **この境界は `pieces` に依らない**——2N 以下なら何個に分けても全部を読むので。
 *
 * `pieces` は**合計 2N を何個に分けて、端から端まで等間隔に置くか**（`DEFAULT_EDGE_PIECES`）。
 * `pieces = 2` はちょうど先頭 N ＋末尾 N になるので、**「端だけ」は散らし方の 1 つ**で
 * 別物ではない。**読む量は `pieces` で変わらない**（切れ端が短くなるだけ）。
 *
 * 切れ端どうしは重ならない。間隔は `(len - chunk) / (pieces - 1)` で、
 * `len > 2N` かつ `chunk ≦ 2N / pieces` なので間隔は必ず `chunk` より広くなる。
 * 重なると真ん中が二重に混ざる（上と同じ穴）ので、ここは計算で閉じてある。
 */
export function edgeRanges(
  length: number,
  edge: number = DEFAULT_EDGE_BYTES,
  pieces: number = DEFAULT_EDGE_PIECES,
): ByteRange[] {
  const len = Math.max(0, length);
  const n = Math.max(0, Math.floor(edge));
  // 1 個では「端から端まで」が作れない（頭だけになる）ので、下は 2 で止める。
  // 上は `MAX_EDGE_PIECES` で止める。**`Infinity` がそのまま通ると回り続ける。**
  // ここは読む前に効くので、ファイルから来た数をそのまま長さに使わせない
  // （読む側は `openPack` が先に断っているが、この関数は単独でも呼ばれる）。
  const p = Math.min(MAX_EDGE_PIECES, Math.max(2, Math.floor(pieces) || 2));
  if (n === 0 || len <= n * 2) return [{ from: 0, to: len }];
  // 切れ端の長さ。**割り切れないぶんは読まない**（端の 2 個ぶんより増やさない）。
  const chunk = Math.max(1, Math.floor((n * 2) / p));
  const out: ByteRange[] = [];
  for (let i = 0; i < p; i += 1) {
    // i = 0 は先頭から、i = p-1 は末尾で終わる。**p = 2 なら先頭 N と末尾 N そのもの。**
    const from = Math.round((i * (len - chunk)) / (p - 1));
    out.push({ from, to: from + chunk });
  }
  return out;
}

/** 端だけを見るときに読むバイト数。 */
export function edgeReadBytes(
  length: number,
  edge: number = DEFAULT_EDGE_BYTES,
  pieces: number = DEFAULT_EDGE_PIECES,
): number {
  return edgeRanges(length, edge, pieces).reduce((sum, r) => sum + (r.to - r.from), 0);
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
export async function edgeDigestOf(
  bytes: Uint8Array,
  edge: number = DEFAULT_EDGE_BYTES,
  pieces: number = DEFAULT_EDGE_PIECES,
): Promise<string> {
  return digestOfParts(edgeRanges(bytes.byteLength, edge, pieces).map((r) => bytes.subarray(r.from, r.to)));
}

/** 生の 32 バイトを base64 に直す（`section` から読んだものを見出しの形に合わせる）。 */
export function digestToText(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/** 何を出すか。`whole` が丸ごとのハッシュ、`edge` が端だけ（0 なら持たない）。 */
export interface DigestSpec {
  whole: boolean;
  edge: number;
  /** 2N を何個に分けて読むか（`DEFAULT_EDGE_PIECES`）。読む量はこれで変わらない。 */
  pieces?: number;
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
  const pieces = spec.pieces ?? DEFAULT_EDGE_PIECES;
  for (const id of ids) {
    // 大きさが分からない持ち主では端を切れないので、丸ごと読む側へ落とす
    // （**0 バイト扱いにして「何も無い」のハッシュを書くと、黙って全部の実体が通る**）。
    const known = bodies.size(id);
    if (!spec.whole && spec.edge > 0 && bodies.slice && known !== undefined) {
      const parts: Uint8Array[] = [];
      // **読む口を叩く回数が `pieces` になる。** 読む量は変わらないが、
      // ここが散らす費用の出どころ（ファイルの上で 1 回 0.05ms・README の 9.4）。
      for (const r of edgeRanges(known, spec.edge, pieces)) parts.push(await bodies.slice(id, r.from, r.to));
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
      ...(spec.edge > 0 && !duplicate ? { edgeHash: await edgeDigestOf(bytes, spec.edge, pieces) } : {}),
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
  {
    depth = 'full',
    edge = 0,
    // **幅と同じで、ここも呼ぶ側が渡したものだけを使う。** 既定で埋めると、
    // 散らし方の違うファイルを黙って「中身が違う」と言い出す（`LEGACY_EDGE_PIECES` の注）。
    pieces = LEGACY_EDGE_PIECES,
  }: { depth?: VerifyDepth; edge?: number; pieces?: number } = {},
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
    const ranges = depth === 'edge' ? edgeRanges(length, edge, pieces) : [{ from: 0, to: length }];
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
