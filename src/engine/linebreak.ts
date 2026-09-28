/**
 * 日本語のテロップを、読みやすい所で折り返す。
 *
 * 幅だけで折ると「自動翻訳でき / るぐらい」のように語の途中で切れる。
 * 読む人はそこで一度つまずくので、同じ秒数でも入ってくる量が減る。
 * そこで「どこで切っても幅に収まる」候補の中から、**意味の切れ目に近い所**を選ぶ。
 *
 * 規則は 2 つに分かれる:
 *   - **切りたい所**（点数が高いほど良い）… 句読点・閉じ括弧・助詞・接続のあと
 *   - **切ってはいけない所**（禁則）… 行頭に来ると落ち着かない文字、行末に置けない文字
 *
 * 幅を測る手段は渡してもらう（`measure`）。こうしておくと canvas が無くても試せるので、
 * 規則そのものをブラウザ抜きで確かめられる。
 */

/** 行頭に置かない文字。ここへ送ると行の頭が落ち着かない。 */
const NO_LINE_START = new Set(
  '、。，．,.！？!?…‥・ー〜～:;：；)]｝」』）〉》】〕”’%％℃°ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶゝゞ々'.split(''),
);

/** 行末に置かない文字。開いたまま行が終わると、次の行と繋がって見えない。 */
const NO_LINE_END = new Set('([｛「『（〈《【〔“‘'.split(''));

/**
 * この文字の**あとで**切ると読みやすい、というもの。数が大きいほど切りたい。
 * 句読点がいちばん強く、助詞がその次。
 */
const AFTER_SCORE: Record<string, number> = {
  '。': 6, '．': 6, '.': 6, '、': 5, '，': 5, ',': 5,
  '！': 5, '!': 5, '？': 5, '?': 5, '…': 5, '‥': 5,
  '」': 4, '』': 4, '）': 4, ')': 4, '】': 4, '》': 4, '〉': 4, '］': 4, ']': 4,
  // 助詞。単独で意味の切れ目になりやすいもの。
  は: 3, が: 3, を: 3, に: 3, へ: 3, と: 3, も: 3, や: 3, ね: 3, よ: 3, ば: 3,
};

/** この 2 文字の**あとで**切ると読みやすい、というもの。 */
const AFTER2 = ['から', 'って', 'けど', 'ので', 'より', 'まで', 'たら', 'ても', 'のに', 'だけ'];

/** 空白は元から切れ目なので、いちばん強い。 */
const SPACE_SCORE = 7;

const HIRAGANA = /[\u3041-\u309f]/;
const KANJI_OR_KATAKANA = /[\u4e00-\u9fff\u30a1-\u30ff]/;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

/**
 * 文字の種類が変わる所は、たいてい語の変わり目でもある。
 * 助詞や句読点ほど確かではないが、ここを見ないと
 * 「自動翻訳できるぐ / らいには」のように平仮名の途中で切れてしまう。
 */
function scriptChangeScore(prev: string, next: string): number {
  if (LATIN_OR_DIGIT.test(prev) !== LATIN_OR_DIGIT.test(next)) return 2;
  // 平仮名 → 漢字・片仮名。次の語が始まる所なので強い。
  if (HIRAGANA.test(prev) && KANJI_OR_KATAKANA.test(next)) return 2;
  // 漢字・片仮名 → 平仮名。送り仮名や助詞が続くだけのこともあるので弱い。
  if (KANJI_OR_KATAKANA.test(prev) && HIRAGANA.test(next)) return 1;
  return 0;
}

/**
 * `text` を `p` 文字目で切ったときの良さ。0 は「切れるが、特に良くはない」。
 * 位置 `p` は「`p` 文字目までを今の行に置く」という意味（1 以上 text.length 未満）。
 */
export function breakScore(text: string, p: number): number {
  const prev = text[p - 1];
  const next = text[p];
  if (/\s/.test(prev)) return SPACE_SCORE;
  if (/\s/.test(next)) return SPACE_SCORE;
  const two = text.slice(p - 2, p);
  const particle = AFTER2.includes(two) ? 3 : (AFTER_SCORE[prev] ?? 0);
  return Math.max(particle, scriptChangeScore(prev, next));
}

/** そこで切ってよいか（禁則）。 */
export function canBreakAt(text: string, p: number): boolean {
  if (p <= 0 || p >= text.length) return false;
  if (NO_LINE_START.has(text[p])) return false;
  if (NO_LINE_END.has(text[p - 1])) return false;
  // 「っ」「ゃ」などは上で弾いているが、サロゲートペア（絵文字など）の途中でも切らない。
  const code = text.charCodeAt(p);
  if (code >= 0xdc00 && code <= 0xdfff) return false;
  return true;
}

export interface WrapOptions {
  /** その文字列を描いたときの幅。 */
  measure: (s: string) => number;
  /** 1 行に許す幅。 */
  maxWidth: number;
  /**
   * 意味の切れ目を探す範囲。入る長さの何割まで戻ってよいか（既定 0.55）。
   * 戻りすぎると行が極端に短くなるので、下限を決めておく。
   */
  minRatio?: number;
}

/**
 * 1 つながりの文字列を、幅に収まる行の列にする。
 * 改行文字はここでは扱わない（呼ぶ側が段落に分けてから渡す）。
 */
export function wrapJapanese(text: string, options: WrapOptions): string[] {
  const { measure, maxWidth } = options;
  const minRatio = options.minRatio ?? 0.55;
  if (text === '') return [''];
  if (maxWidth <= 0 || !Number.isFinite(maxWidth)) return [text];

  const lines: string[] = [];
  let rest = text;

  while (rest !== '') {
    if (measure(rest) <= maxWidth) {
      lines.push(rest);
      break;
    }

    // 幅に収まるいちばん長い位置を探す。1 文字でも溢れるときは 1 文字置いて進める
    //（置かないと進まなくなる）。
    let fit = 1;
    while (fit < rest.length && measure(rest.slice(0, fit + 1)) <= maxWidth) fit += 1;

    // そこから戻りながら、いちばん点の高い切れ目を探す。
    // 同点なら先に見つかったほう（＝より長いほう）を採る。
    const floor = Math.max(1, Math.floor(fit * minRatio));
    let bestAt = -1;
    let bestScore = -1;
    for (let p = fit; p >= floor; p -= 1) {
      if (!canBreakAt(rest, p)) continue;
      const score = breakScore(rest, p);
      if (score > bestScore) {
        bestScore = score;
        bestAt = p;
      }
      if (score >= SPACE_SCORE) break; // これ以上は良くならない
    }

    // 範囲に 1 つも切れ目が無ければ、禁則だけ守って探し直す。
    if (bestAt < 0) {
      for (let p = fit; p >= 1; p -= 1) {
        if (canBreakAt(rest, p)) {
          bestAt = p;
          break;
        }
      }
    }
    // それでも無ければ、幅を諦めて入る所で切る（禁則より「進むこと」を優先）。
    if (bestAt < 0) bestAt = fit;

    lines.push(rest.slice(0, bestAt).replace(/\s+$/, ''));
    rest = rest.slice(bestAt).replace(/^\s+/, '');
  }

  return lines.length ? lines : [''];
}
