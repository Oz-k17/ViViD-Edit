/**
 * 素材のビン（フォルダ）をツリーとして扱う。
 *
 * 素材は今までどおり `folder: string` を 1 つ持つだけ。**その文字列を `/` 区切りのパスとして読む**
 * （`映像/配信1`）。`/` を含まない既存の名前は、そのまま最上位のビンになるので、
 * 保存済みのデータは作り直さずに使える。
 *
 * 素材がまだ入っていないビンは素材からは見えないので、`extraBins`（別に保存する一覧）で持つ。
 * DOM を使わない純粋関数なので Node で検査できる（`scripts/model-selftest.mjs`）。
 */

export const BIN_SEP = '/';
/** ツリーの根（どのビンにも属さない = すべて）。 */
export const ROOT = '';

export interface BinNode {
  /** 先頭から末尾までのパス（`映像/配信1`）。 */
  path: string;
  /** 表示名（パスの最後の部分）。 */
  name: string;
  depth: number;
  children: BinNode[];
  /** このビン直下の素材の数。 */
  count: number;
  /** 子孫も含めた素材の数。 */
  total: number;
}

export function splitPath(path: string): string[] {
  return path.split(BIN_SEP).filter((p) => p.length > 0);
}

export function joinPath(...parts: string[]): string {
  return parts.flatMap((p) => splitPath(p)).join(BIN_SEP);
}

export function parentOf(path: string): string {
  const parts = splitPath(path);
  return parts.slice(0, -1).join(BIN_SEP);
}

export function baseName(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? '';
}

/** `inside` が `ancestor` と同じか、その下にあるか（ルートは全部を含む）。 */
export function isWithin(inside: string, ancestor: string): boolean {
  if (ancestor === ROOT) return true;
  return inside === ancestor || inside.startsWith(ancestor + BIN_SEP);
}

/** ビン名として使えるか。使えなければ理由を返す。 */
export function binNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '名前を入力してください';
  if (trimmed.includes(BIN_SEP)) return `「${BIN_SEP}」は名前に使えません`;
  if (trimmed === '.' || trimmed === '..') return 'その名前は使えません';
  return null;
}

/** 素材から見える全ビンと、空のビンを合わせて、祖先も補ったパスの一覧にする。 */
export function allBinPaths(assetFolders: Iterable<string>, extraBins: Iterable<string>): string[] {
  const set = new Set<string>();
  const add = (path: string) => {
    const parts = splitPath(path);
    for (let i = 1; i <= parts.length; i += 1) set.add(parts.slice(0, i).join(BIN_SEP));
  };
  for (const f of assetFolders) if (f) add(f);
  for (const b of extraBins) if (b) add(b);
  return [...set];
}

/**
 * ツリーを作る。兄弟は名前順（日本語は `localeCompare`）。
 * `pinned` に挙げた最上位のビンは、その順で先頭に置く（未分類・効果音など）。
 */
export function buildTree(
  assetFolders: string[],
  extraBins: Iterable<string> = [],
  pinned: string[] = [],
): BinNode[] {
  const paths = allBinPaths(assetFolders, extraBins);
  const direct = new Map<string, number>();
  for (const f of assetFolders) if (f) direct.set(f, (direct.get(f) ?? 0) + 1);

  const nodes = new Map<string, BinNode>();
  for (const path of paths) {
    nodes.set(path, {
      path,
      name: baseName(path),
      depth: splitPath(path).length - 1,
      children: [],
      count: direct.get(path) ?? 0,
      total: 0,
    });
  }
  const roots: BinNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parentOf(node.path));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const order = (a: BinNode, b: BinNode) => a.name.localeCompare(b.name, 'ja');
  const total = (node: BinNode): number => {
    node.children.sort(order);
    node.total = node.count + node.children.reduce((sum, c) => sum + total(c), 0);
    return node.total;
  };
  roots.forEach(total);
  roots.sort((a, b) => {
    const ia = pinned.indexOf(a.path);
    const ib = pinned.indexOf(b.path);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return order(a, b);
  });
  return roots;
}

/** 深さ優先で並べた平らな一覧。`expanded` に無いビンの子は含めない。 */
export function visibleNodes(tree: BinNode[], expanded: ReadonlySet<string>): BinNode[] {
  const out: BinNode[] = [];
  const walk = (nodes: BinNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0 && expanded.has(node.path)) walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/** あるパスの祖先（自分は含まない）を、根に近い順に返す。選んだビンを見せるのに使う。 */
export function ancestorsOf(path: string): string[] {
  const parts = splitPath(path);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join(BIN_SEP));
  return out;
}

/** `from` 以下のパスを `to` 以下へ付け替えた新しいパス（`from` の外なら変えない）。 */
export function rebase(path: string, from: string, to: string): string {
  if (!isWithin(path, from) || from === ROOT) return path;
  return joinPath(to, path.slice(from.length));
}

/** 同じ親の下に同名のビンがあるか。 */
export function siblingExists(paths: Iterable<string>, parent: string, name: string, except?: string): boolean {
  const target = joinPath(parent, name);
  for (const p of paths) if (p === target && p !== except) return true;
  return false;
}

export interface MoveCheck {
  ok: boolean;
  reason?: string;
  /** 動かしたあとのパス。 */
  to?: string;
}

/** ビン `path` を `newParent` の下へ移せるか（自分の中へは移せない、同名がぶつかるときも不可）。 */
export function checkMoveBin(path: string, newParent: string, existing: Iterable<string>): MoveCheck {
  if (!path) return { ok: false, reason: '動かせません' };
  if (isWithin(newParent, path)) return { ok: false, reason: '自分の中には移せません' };
  if (parentOf(path) === newParent) return { ok: false, reason: '同じ場所です' };
  const to = joinPath(newParent, baseName(path));
  if (siblingExists(existing, newParent, baseName(path), path)) {
    return { ok: false, reason: `「${baseName(path)}」はその場所に既にあります` };
  }
  return { ok: true, to };
}

/** ビンの名前を変えたあとのパスを返す。同名が既にあれば null。 */
export function renamedPath(path: string, newName: string, existing: Iterable<string>): string | null {
  if (binNameProblem(newName)) return null;
  const parent = parentOf(path);
  const name = newName.trim();
  if (siblingExists(existing, parent, name, path)) return null;
  return joinPath(parent, name);
}

/**
 * 素材をあいまい検索する。空の問い合わせは全件。
 * 名前と、ビンのパスの両方を見る（`配信/ゲーム` で探せる）。空白区切りは AND。
 */
export function matchesQuery(name: string, folder: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${name} ${folder}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
