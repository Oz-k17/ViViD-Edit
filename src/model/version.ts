/**
 * 版の印（`2026-10-16 17:26（日本時間）`）の比べ方。DOM を使わない純粋関数。
 */

/** 印から日時の部分（`2026-10-16 17:26`）を取り出す。読めなければ null。 */
export function stampTime(stamp: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec((stamp ?? '').trim());
  return m ? m[1] : null;
}

/** `latest` のほうが新しいか。どちらかが読めないときは「新しくない」とする（うるさく出さない）。 */
export function isNewer(latest: string | null | undefined, current: string | null | undefined): boolean {
  const a = stampTime(latest);
  const b = stampTime(current);
  if (!a || !b) return false;
  // 固定の書式なので、文字列のまま比べれば日時の順になる。
  return a > b;
}
