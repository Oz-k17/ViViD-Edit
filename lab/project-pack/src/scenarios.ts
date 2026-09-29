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
export function memoryBodies(
  bodies: Map<string, Uint8Array>,
): BodySource & { reads: string[]; readBytes: number } {
  const reads: string[] = [];
  const self = {
    reads,
    /** **読んだバイト数**。端だけで済んだかを測る側が見る（`slice` は範囲ぶんだけ増える）。 */
    readBytes: 0,
    size: (id: string) => bodies.get(id)?.byteLength,
    bytes: async (id: string) => {
      const body = bodies.get(id);
      if (!body) throw new Error(`実体が無い: ${id}`);
      reads.push(id);
      self.readBytes += body.byteLength;
      return body;
    },
    slice: async (id: string, from: number, to: number) => {
      const body = bodies.get(id);
      if (!body) throw new Error(`実体が無い: ${id}`);
      reads.push(id);
      // ブラウザの `Blob.slice` と同じで、**写しは作らない**（範囲を指す view を返す）。
      self.readBytes += Math.max(0, to - from);
      return body.subarray(from, to);
    },
  };
  return self;
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

/**
 * サムネイルの置き所を測るための構成。**素材の数を振るためだけにある。**
 *
 * 上の `SPECS` と分けてあるのは、あちらが「実体の大きさ」を測る形だから。
 * ここで効くのは**素材が何個あるか**で、実体 1 つの大きさはむしろ小さく置きたい
 * （1000 個 × 12MB ＝ 12GB を実際に並べずに、散らばり方だけを見たい）。
 *
 * サムネイルの長さは `lab:pack:thumbsize` で実測した幅（2.3〜6.4KB）を、
 * 素材ごとに順に当てて散らす。**全部を同じ長さにすると、位置の計算が
 * 掛け算で合ってしまって、足し算の取り違えが検算に出てこない。**
 */
export function thumbScenario(
  count: number,
  { bodyBytes = 64 * 1024, thumbBytes = [2399, 3868, 5372, 6576], refEvery = 0 } = {},
): Scenario {
  const metas: PackAssetMeta[] = [];
  const bodies = new Map<string, Uint8Array>();
  const clips: PackClip[] = [];
  let raw = 0;

  for (let i = 0; i < count; i += 1) {
    // id は**桁を揃えて**置く。`plan.ts` は id の昇順に詰めるので、
    // 桁が揃っていないと `a10` が `a2` より前に来て、並びが人の期待とずれる。
    const id = `a${String(i).padStart(6, '0')}`;
    const isRef = refEvery > 0 && i % refEvery === 0;
    const thumbLen = thumbBytes[i % thumbBytes.length];
    metas.push({
      id,
      name: `素材${i}.mp4`,
      kind: 'video',
      duration: 12,
      width: 1080,
      height: 1920,
      // 本体の `snapshot()` が返すのと同じ形の文字列。中身は測るのに要らないので乱数。
      thumbnail: `data:image/jpeg;base64,${base64Of(pseudoBytes(thumbLen, i + 7))}`,
      size: bodyBytes,
      folder: '未分類',
      createdAt: 1_700_000_000_000 + i,
      ...(isRef ? { src: `media/素材${i}.mp4` } : {}),
    });
    if (!isRef) {
      bodies.set(id, pseudoBytes(bodyBytes, i + 1));
      raw += bodyBytes;
    }
    clips.push(clip(id));
  }

  return {
    name: `素材 ${count} 個`,
    note: `実体 ${(bodyBytes / 1024).toFixed(0)}KB × ${count}`,
    project: makeProject(clips, `素材 ${count} 個`),
    assets: assetMap(metas),
    bodies,
    rawBytes: raw,
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 素材を組むためだけの base64。判断には関わらないので、素直な実装で足りる。 */
function base64Of(bytes: Uint8Array): string {
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

/**
 * **両端に「決まり文句」を持つ実体。** 端だけの検査を潰すための素材。
 *
 * `pseudoBytes` は全域が乱数なので、**どの 1 バイトを見ても実体どうしが違う。**
 * 端だけの検査を乱数の素材で測ると、入れ替わりが必ず見つかって当たり前に見える——
 * それは端の手柄ではなく、素材が端で既に違っていたからでしかない。
 *
 * 本物はそうではない。同じ設定で書き出した動画は**頭に同じ容器の見出し**が付き、
 * 形式によっては**尻が同じ形で終わる**（零で詰める・同じ終端の印）。
 * そこが揃っている素材では、端だけの検査は「別の素材」を同じものと見なす。
 *
 * `head` は素材によらず同じ並び、`tail` は零、間だけが `seed` で変わる。
 * **頭と尻を別々に指定できる**ようにしてあるのは、端が頭と尻の両方を見るので、
 * **片方が揃っているだけでは破れない**（＝どちらが効いているか）を測るため。
 */
export function boilerplateBytes(
  length: number,
  seed = 1,
  { head = 0, tail = 0 }: { head?: number; tail?: number } = {},
): Uint8Array {
  const len = Math.max(0, length);
  const h = Math.min(len, Math.max(0, Math.floor(head)));
  const t = Math.min(len - h, Math.max(0, Math.floor(tail)));
  const out = pseudoBytes(len, seed);
  // 頭は「容器の見出し」のつもりの決まり文句。**素材によらず同じ**にしたいので
  // 種を固定する（`seed` を混ぜると、揃えたつもりで揃っていない素材になる）。
  if (h > 0) out.set(pseudoBytes(h, 0x5f5f), 0);
  // 尻は零詰め。**乱数で埋めると「揃っている」が作れない**（種が違えば違う並びになる）。
  if (t > 0) out.fill(0, len - t, len);
  return out;
}
