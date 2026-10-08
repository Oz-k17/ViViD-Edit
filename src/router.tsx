/**
 * ハッシュ（#/settings など）だけで切り替える、ごく小さなルーター。
 *
 * このアプリのページは 4 つで、要るのは「いまのパス」「リンク」「移動」だけ。
 * ルーターのライブラリ（react-router）は配布物の約 4% を占めていたので、置き換えた。
 * ハッシュ方式にしているのは、静的ホスティングや file:// でも深いリンクが壊れないようにするため。
 */
import { useSyncExternalStore, type ReactNode } from 'react';

function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, '').split('?')[0];
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function subscribe(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

/** いまのパス（`/`、`/media-library` など）。変わると再描画される。 */
export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

export function navigate(to: string): void {
  window.location.hash = to;
}

export function useNavigate(): (to: string) => void {
  return navigate;
}

/** `end` なら完全一致のときだけ、そうでなければ先頭が一致すれば active。 */
export function NavLink({ to, end = false, children }: { to: string; end?: boolean; children: ReactNode }) {
  const path = usePath();
  const active = end ? path === to : path === to || path.startsWith(`${to}/`);
  return (
    <a href={`#${to}`} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
      {children}
    </a>
  );
}

/** パスごとの画面。一致しなければ `fallback`。 */
export function Routes({ routes, fallback }: { routes: Record<string, () => ReactNode>; fallback: () => ReactNode }) {
  const path = usePath();
  return <>{(routes[path] ?? fallback)()}</>;
}
