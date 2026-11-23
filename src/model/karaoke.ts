/**
 * カラオケ字幕: 話している所まで、字の色が順に変わっていく。
 *
 * 考え方は openreel-video（MIT, Augustus Otu and Contributors）の「単語ごとに強調する字幕」に倣い、
 * 文字を 1 字ずつ塗り進める形にした。日本語は単語の区切りが見えないので、単語ではなく
 * 「何文字目まで塗ったか」で持つ（単語の途中でも、なめらかに塗り進む）。
 *
 * 時刻は「テロップの頭」から数えた秒。テロップを分割すると右側の `sourceIn` が進むので、
 * 描く側が `local + sourceIn` で引けば、割っても塗る位置がずれない。
 *
 * 画面に依らない計算だけを置く（`npm run test:model` でブラウザ無しに試せる）。
 */

export interface KaraokeWord {
  /** テロップの頭から数えた秒。 */
  start: number;
  end: number;
  /** この言葉が、本文の何文字ぶんか（空白は数えない）。 */
  chars: number;
}

export interface Karaoke {
  /** 話し終えた所の色。 */
  color: string;
  /**
   * 言葉ごとの時刻。書き起こしから作ったときだけ入る。
   * 無ければ、全文を `span` 秒かけて同じ速さで塗る。
   */
  words?: KaraokeWord[] | null;
  /** 時刻が無いとき、全文を塗り終えるまでの秒。未定義なら塗らない（全部を元の色で出す）。 */
  span?: number;
}

/** 塗る文字の数え方。空白は塗っても見えないので数えない。 */
export function karaokeChars(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n += 1;
  return n;
}

/**
 * 書き起こしの単語（タイムラインと同じ秒）を、テロップの頭からの秒に直して持たせる。
 * 単語が無い・読めないときは null（呼ぶ側が `span` で塗るほうへ倒す）。
 */
export function karaokeWords(
  words: readonly { start: number; end: number; text: string }[] | undefined,
  clipStart: number,
): KaraokeWord[] | null {
  if (!words || words.length === 0) return null;
  const out: KaraokeWord[] = [];
  for (const w of words) {
    const chars = karaokeChars(w.text);
    if (chars === 0) continue;
    // 千分の 1 秒に丸める（保存したときに 0.39999… のような端数を残さない）。
    const start = Math.max(0, ms(w.start - clipStart));
    out.push({ start, end: Math.max(start, ms(w.end - clipStart)), chars });
  }
  return out.length ? out : null;
}

const ms = (v: number) => Math.round(v * 1000) / 1000;

/** 0〜1 に収める。 */
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * いま何文字ぶん塗るか（小数あり。0.5 なら次の字の半分まで）。
 *
 * @param at テロップの頭からの秒（`local + sourceIn`）
 * @param total 本文の文字数（`karaokeChars` で数えたもの）。単語の合計と違っても、ここで頭打ちにする
 *              （書き起こしのあとに人が本文を直しても、はみ出して塗らないように）。
 */
export function karaokeProgress(karaoke: Karaoke, at: number, total: number): number {
  if (total <= 0) return 0;
  const words = karaoke.words;
  if (words && words.length) {
    let done = 0;
    for (const w of words) {
      if (at >= w.end) {
        done += w.chars;
        continue;
      }
      if (at > w.start) done += w.chars * clamp01((at - w.start) / Math.max(1e-3, w.end - w.start));
      break;
    }
    return Math.min(total, done);
  }
  const span = karaoke.span ?? 0;
  if (span <= 0) return 0;
  return total * clamp01(at / span);
}

/**
 * 1 つの文字列（折り返したあとの 1 かたまり）のうち、何文字目まで塗るか。
 * `before` はこのかたまりより前に数えた文字数、`progress` は `karaokeProgress` の値。
 * 戻り値は 0〜（このかたまりの文字数）の小数。
 */
export function karaokeWithin(text: string, before: number, progress: number): number {
  const own = karaokeChars(text);
  return Math.max(0, Math.min(own, progress - before));
}

/**
 * かたまりの中で、塗る所の右端が何文字目（空白も含めた、文字列の位置）にあたるか。
 * 整数部は丸ごと塗る字の数、小数部は次の字をどこまで塗るか。
 * 例: 「あい う」で 2.5 字ぶん塗る → 空白を飛ばして「う」の半分 = 位置 3.5。
 */
export function karaokeCut(text: string, within: number): { index: number; fraction: number } {
  const chars = [...text];
  let left = within;
  for (let i = 0; i < chars.length; i += 1) {
    if (/\s/.test(chars[i])) continue;
    if (left < 1) return { index: i, fraction: left };
    left -= 1;
  }
  return { index: chars.length, fraction: 0 };
}

/** 話し終えた所の既定の色。白い字・黒い縁の字幕の上で、いちばん目立つ黄色。 */
export const KARAOKE_DEFAULT_COLOR = '#ffe14d';
