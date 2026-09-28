/**
 * **サムネイルをどこに置くか。**
 *
 * 見出し（`container.ts` の `PackHeader`）は**開くとき必ず全部読む**。
 * いま見出しは 1 素材 243 バイトで、素材が 1000 個あっても 243KB にしかならない。
 * ところが `MediaAsset.thumbnail` は `data:image/jpeg;base64,…` の**文字列**で、
 * 本体（`src/engine/media.ts` の `snapshot()`）は長辺 240・品質 0.7 で焼いている。
 * これを見出しに入れると 1 素材が 2 桁 KB になり、**開くのに読む量が実体並みに増える。**
 *
 * 追い出す先には 2 通りある。**どちらも「後ろへ回す」なのに、答えが逆になる。**
 *
 * | | どこへ | 一覧を出すのに |
 * | --- | --- | --- |
 * | `inline` | 見出しの中（いまの形） | 見出しを読めば済む（そのぶん見出しが太る） |
 * | `section` | 見出しと実体の間に**まとめて** | その一続きを 1 回読む |
 * | `scattered` | 実体と同じ域へ、素材ごとに実体の後ろ | **実体域に散るので、素材の数だけ読む** |
 *
 * `scattered` が「実体と同じ扱いで後ろへ回す」をそのまま書いた形で、
 * 2026-09-28 の積み残しが心配していた「一覧を出すのに実体域を読む」がこれにあたる。
 * `section` は**域を分ける**ことでその心配だけを外す。数字は `README.md` に置いた。
 *
 * ## 追い出した先では生バイトで置く（data URL のまま置かない）
 *
 * base64 を剥がして**生の JPEG** を置く。理由は 2 つ。base64 の 1.333 倍がそのまま消えること、
 * そして読む側が `URL.createObjectURL(blob.slice(…))` で**文字列を 1 本も作らずに**絵にできること。
 * 実体の側で二進を選んだ理由（`README.md` の 4）と同じ形で、
 * **見出しに置いたままではどちらの利点も取れない。**
 */

/** サムネイルの置き所。既定は `inline`（いまの形）。 */
export type ThumbPlacement = 'inline' | 'section' | 'scattered';

/** 追い出したサムネイル 1 枚の在り処。位置は置いた域の先頭を 0 とした相対。 */
export interface PackThumbEntry {
  id: string;
  offset: number;
  length: number;
  /** `image/jpeg` など。読み戻して `Blob` にするのに要る。 */
  type: string;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 を生バイトに戻す。
 *
 * `atob` はブラウザにも Node にもあるが、**中身が壊れていても黙って何かを返す**
 * （実装によっては投げる）。見出しは人が手で触れる所なので、ここは自前で数えて
 * 形が合わないものは `null` にする。1 枚 10KB 級なので速さは問題にならない。
 */
export function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\r\n]/g, '');
  const body = clean.replace(/=+$/, '');
  if (clean.length % 4 !== 0 || clean.length - body.length > 2) return null;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of body) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (acc >> bits) & 0xff;
      at += 1;
    }
  }
  return at === out.length ? out : null;
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

export interface SplitThumb {
  type: string;
  bytes: Uint8Array;
}

/**
 * `data:image/jpeg;base64,…` を種類と生バイトに割る。**割れなければ `null`。**
 *
 * 割れない形は実際にある——音の素材は `thumbnail` が空文字だし、
 * 外から来たプロジェクトが `https://…` を入れていることもありうる。
 * そこを黙って落とすと**開いた側でサムネイルだけ消える**ので、
 * `null` を返して呼ぶ側に「見出しへ残す」を選ばせる（追い出せないものは追い出さない）。
 */
export function splitDataUrl(url: string): SplitThumb | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const head = url.slice(5, comma);
  if (!head.endsWith(';base64')) return null; // 素の（base64 でない）data URL は剥がす意味が無い
  // 種類が書いていない（`data:;base64,…`）ものは追い出さない。
  // 何かで埋めて戻すと**元の文字列と違う data URL になる**ので、
  // 「追い出しても元のまま戻る」が崩れる。見出しに残せば元のまま残る。
  const type = head.slice(0, -';base64'.length);
  if (!type) return null;
  const bytes = decodeBase64(url.slice(comma + 1));
  return bytes ? { type, bytes } : null;
}

/** 生バイトを data URL に戻す（Node で確かめるときと、画面を持たない呼び出し側のため）。 */
export function toDataUrl(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${encodeBase64(bytes)}`;
}
