/**
 * 最後にまとめて入れた動画（いちばん新しいものから 2 分以内に入れたもの）を、入れた順に。
 * はじめかたの「入れた動画を並べる」で使う（古い素材まで全部並べないように）。
 */
export function latestBatch<T extends { kind: string; createdAt: number }>(assets: T[], windowMs = 120_000): T[] {
  const videos = assets.filter((a) => a.kind === 'video');
  if (videos.length === 0) return [];
  const newest = Math.max(...videos.map((a) => a.createdAt));
  return videos.filter((a) => newest - a.createdAt <= windowMs).sort((a, b) => a.createdAt - b.createdAt);
}
