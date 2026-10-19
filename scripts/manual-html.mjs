/**
 * README（操作説明書）を、ネット無しでも読める 1 枚の HTML にする。
 *
 * ダウンロードした ZIP（パソコン用・iPad 用）に「使い方.html」として入れる。
 * iPad の「ファイル」でも、パソコンのブラウザでも、タップ・ダブルクリックで読める。
 *
 * - 見出しには GitHub と同じ形の id を付ける（README の目次のリンクがそのまま効くように）
 * - リポジトリの中を指す相対リンクは、GitHub の URL に直す（ZIP の中には無いファイルなので）
 */
import { marked } from 'marked';

const REPO = 'https://github.com/Oz-k17/ViViD-Edit/blob/main/';

/** GitHub の見出しの id と同じ作り方（小文字にし、記号を落とし、空白を - に）。 */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function buildManualHtml(readme) {
  let body = marked.parse(readme, { gfm: true });

  const seen = new Map();
  body = body.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
    const base = slug(stripTags(inner));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });

  // marked は目次のリンク（#見出し）を %E3… の形にするので、見出しの id と同じ形へ戻す。
  body = body.replace(/href="#([^"]+)"/g, (_, hash) => `href="#${decodeURIComponent(hash)}"`);
  body = body.replace(/href="(?!https?:|#|mailto:)(?:\.\/)?([^"]+)"/g, (_, target) => `href="${REPO}${target}"`);
  // 外へのリンクは別のタブで（説明書を閉じてしまわないように）。
  body = body.replace(/<a href="(https?:[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ViViD Edit の使い方</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --code: #f3f5f7; --link: #0b62d6;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #15171b; --fg: #e6e8eb; --muted: #9aa3ad; --line: #30353c; --code: #22262c; --link: #6aa8ff; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 1.9em; margin: 0.4em 0 0.6em; }
  h2 { font-size: 1.45em; margin: 2.2em 0 0.6em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1.15em; margin: 1.6em 0 0.4em; }
  a { color: var(--link); }
  code { background: var(--code); border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.9em; }
  pre { background: var(--code); border-radius: 6px; padding: 12px; overflow-x: auto; }
  pre code { padding: 0; }
  ul, ol { padding-left: 1.5em; }
  li { margin: 0.2em 0; }
  .table { overflow-x: auto; margin: 1em 0; }
  table { border-collapse: collapse; min-width: 100%; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: var(--code); }
  blockquote { margin: 1em 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--line); }
</style>
</head>
<body>
<main>
${body.replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, '</table></div>')}
</main>
</body>
</html>
`;
}
