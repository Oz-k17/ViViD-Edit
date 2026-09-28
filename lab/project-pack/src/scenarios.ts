/**
 * 試し用のプロジェクトと素材。
 *
 * 種を固定した疑似乱数でバイトを作る。**零で埋めない**理由は 2 つ。
 * 動画も音も既に圧縮されているので中身は乱数に近いこと、
 * そして零で埋めると「写しを作っていないつもりで作っていた」ような取り違えが
 * 検算で見つからなくなること（同じバイトが並ぶと、ずれていても気づけない）。
 */

import type { BodySource, PackAssetMeta, PackClip, PackProject } from './types.ts';

/** xorshift32。同じ種なら同じ列が出るので、前後の数字がそのまま比べられる。 */
export function pseudoBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed | 0 || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function makeProject(clips: PackClip[], name = 'テスト'): PackProject {
  return { name, sequence: { tracks: [{ id: 't1' }], clips } };
}

export function clip(mediaId: string | null, content?: string): PackClip {
  return { mediaId, text: content === undefined ? null : { content } };
}

let n = 0;

export function meta(over: Partial<PackAssetMeta> = {}): PackAssetMeta {
  n += 1;
  return {
    id: `m_${n}`,
    name: `素材${n}.mp4`,
    kind: 'video',
    duration: 12,
    width: 1920,
    height: 1080,
    thumbnail: '',
    size: 0,
    folder: '未分類',
    createdAt: 1_700_000_000_000 + n,
    ...over,
  };
}

/** 覚え書きを id 引きの表にする。 */
export function assetMap(list: PackAssetMeta[]): Map<string, PackAssetMeta> {
  return new Map(list.map((a) => [a.id, a]));
}

/**
 * 実体を生バイトで持つ口。
 * **`size` は表を引くだけ、`bytes` は数えて渡す**という差を残してある
 * （ブラウザの `Blob.size` と `Blob.arrayBuffer()` の差がこれ）。
 */
export function memoryBodies(bodies: Map<string, Uint8Array>): BodySource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    size: (id) => bodies.get(id)?.byteLength,
    bytes: async (id) => {
      const body = bodies.get(id);
      if (!body) throw new Error(`実体が無い: ${id}`);
      reads.push(id);
      return body;
    },
  };
}

export interface Scenario {
  name: string;
  note: string;
  project: PackProject;
  assets: Map<string, PackAssetMeta>;
  bodies: Map<string, Uint8Array>;
  /** 実体の合計バイト数。 */
  rawBytes: number;
}

/** 素材を n 個ぶら下げたプロジェクトを組む（`kind` と大きさを指定する）。 */
function build(
  name: string,
  note: string,
  spec: { bytes: number; kind?: PackAssetMeta['kind']; ext?: string; ref?: boolean }[],
): Scenario {
  const metas: PackAssetMeta[] = [];
  const bodies = new Map<string, Uint8Array>();
  const clips: PackClip[] = [];
  let raw = 0;

  spec.forEach((s, i) => {
    const id = `a${i}`;
    const ext = s.ext ?? 'mp4';
    metas.push({
      id,
      name: `素材${i}.${ext}`,
      kind: s.kind ?? 'video',
      duration: 12,
      width: 1080,
      height: 1920,
      thumbnail: '',
      size: s.bytes,
      folder: '未分類',
      createdAt: 1_700_000_000_000 + i,
      ...(s.ref ? { src: `media/素材${i}.${ext}` } : {}),
    });
    if (!s.ref) {
      bodies.set(id, pseudoBytes(s.bytes, i + 1));
      raw += s.bytes;
    }
    clips.push(clip(id));
  });

  return { name, note, project: makeProject(clips, name), assets: assetMap(metas), bodies, rawBytes: raw };
}

const MB = 1024 * 1024;

type Spec = Parameters<typeof build>;

/**
 * 測るときに使う構成。**組む前の指定だけ**を並べてある。
 *
 * 全部まとめて組む口（`scenarios()`）と 1 つだけ組む口（`scenarioAt`）を分けているのは、
 * メモリを測る側が**要らない構成の実体を抱えたくない**から。
 * 4 つまとめて組むと 117MB 先に積むので、測りたい差がその中に隠れる。
 */
const SPECS: Spec[] = [
  [
    '効果音だけ',
    '30KB の音を 40 個（ここは JSON でも運べる大きさ）',
    Array.from({ length: 40 }, () => ({ bytes: 30 * 1024, kind: 'audio' as const, ext: 'wav' })),
  ],
  ['短い動画 1 本', '12MB の動画 1 本', [{ bytes: 12 * MB }]],
  [
    '動画 8 本',
    '12MB × 8 本（切り抜き 1 本ぶんの現実的な量）',
    Array.from({ length: 8 }, () => ({ bytes: 12 * MB })),
  ],
  [
    '参照 6 本＋取り込み 2 本',
    'NAS の素材が混ざっている形（参照は実体を入れない）',
    [
      ...Array.from({ length: 6 }, () => ({ bytes: 20 * MB, ref: true })),
      { bytes: 8 * MB },
      { bytes: 30 * 1024, kind: 'audio' as const, ext: 'wav' },
    ],
  ],
];

export function scenarioCount(): number {
  return SPECS.length;
}

/** 番号で 1 つだけ組む。ほかの構成の実体は作らない。 */
export function scenarioAt(index: number): Scenario {
  const spec = SPECS[index];
  if (!spec) throw new Error(`そんな構成は無い: ${index}`);
  return build(...spec);
}

export function scenarios(): Scenario[] {
  return SPECS.map((spec) => build(...spec));
}
