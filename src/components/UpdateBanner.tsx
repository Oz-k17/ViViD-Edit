import { useEffect, useState } from 'react';
import { isNativeHost } from '../engine/exporter';
import { isNewer, stampTime } from '../model/version';

/** GitHub に置いてある、いちばん新しい版の印。 */
const LATEST_URL = 'https://raw.githubusercontent.com/Oz-k17/ViViD-Edit/main/docs/version.json';
/** 端末ごとの最新版の ZIP（`.github/workflows/release.yml` が置き直す）。 */
export const DOWNLOAD_IPAD = 'https://github.com/Oz-k17/ViViD-Edit/releases/download/latest/ViViD-Edit-iPad.zip';
export const DOWNLOAD_PC = 'https://github.com/Oz-k17/ViViD-Edit/releases/download/latest/ViViD-Edit-PC.zip';

const DISMISS_KEY = 'vivid-edit.update.dismissed';
const CHECKED_KEY = 'vivid-edit.update.checkedAt';
/** 調べに行く間隔。開くたびに GitHub へ問い合わせない。 */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

const current = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '';

/**
 * 「ダウンロードして使う」形（ファイルから開いた Web 版・iPad アプリ）のときだけ、新しい版が出ていないか調べて知らせる。
 * NAS や GitHub Pages から開いているときは、置き場が新しくなれば開き直すだけで最新になるので、出さない。
 * つながらない・調べられないときは、何も出さない。
 */
export function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    const downloaded = typeof location !== 'undefined' && (location.protocol === 'file:' || isNativeHost());
    if (!downloaded || !stampTime(current)) return;
    try {
      const last = Number(localStorage.getItem(CHECKED_KEY) ?? '0');
      const cached = localStorage.getItem(CHECKED_KEY + '.stamp');
      if (Date.now() - last < INTERVAL_MS) {
        if (cached && isNewer(cached, current)) setLatest(cached);
        return;
      }
    } catch {
      /* 覚えられない環境では毎回調べる */
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    fetch(`${LATEST_URL}?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { stamp?: string } | null) => {
        const stamp = typeof data?.stamp === 'string' ? data.stamp : null;
        try {
          localStorage.setItem(CHECKED_KEY, String(Date.now()));
          if (stamp) localStorage.setItem(CHECKED_KEY + '.stamp', stamp);
        } catch {
          /* 覚えられなくても知らせは出す */
        }
        if (stamp && isNewer(stamp, current)) setLatest(stamp);
      })
      .catch(() => undefined)
      .finally(() => window.clearTimeout(timer));
    return () => controller.abort();
  }, []);

  if (!latest) return null;
  try {
    if (localStorage.getItem(DISMISS_KEY) === latest) return null;
  } catch {
    /* そのまま出す */
  }
  const ipad = isNativeHost();
  return (
    <div className="update-banner" role="status">
      <span>
        新しいバージョンがあります（{stampTime(latest)}）。いま開いているのは {stampTime(current)} の版です。
      </span>
      <a className="button primary" href={ipad ? DOWNLOAD_IPAD : DOWNLOAD_PC} target="_blank" rel="noreferrer">
        {ipad ? 'iPad 用をダウンロード' : 'パソコン用をダウンロード'}
      </a>
      <button
        type="button"
        className="ghost"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, latest);
          } catch {
            /* 消せなくても閉じる */
          }
          setLatest(null);
        }}
      >
        あとで
      </button>
    </div>
  );
}
