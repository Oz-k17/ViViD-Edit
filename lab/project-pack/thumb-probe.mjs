/**
 * **サムネイルを見出しから追い出すか。**
 *
 *   npm run lab:pack:thumbs
 *
 * 2026-09-28（1 回目）の積み残しの筆頭。見出しは**開くとき必ず全部読む**ので、
 * そこにサムネイルを入れると開く費用が素材の数に比例して増える。
 * ただし「後ろへ回すと一覧を出すのに実体域を読む」ので、測ってから決める、としてあった。
 *
 * ## 比べる 3 通り（`src/thumbs.ts`）
 *
 *   1. `inline`    … 見出しの中（いまの形）
 *   2. `section`   … 見出しと実体の間に**まとめて**
 *   3. `scattered` … 実体と同じ域へ、素材ごとに実体の後ろ（＝「後ろへ回す」を素直に書いた形）
 *
 * ## 何を見るか
 *
 * **時間より先にバイト数と読む回数。** 9/28 に実体の側で分かったとおり
 * （`README.md` の 4）、置き所の違いは「読む量」に先に出る。
 * 時間はそのあとで、実際にファイルへ書いてから測る。
 *
 * 人が踏む道は 2 本あるので、分けて数える。
 *
 *   - **開くだけ**（タイムラインを出す）… 見出しだけ要る
 *   - **一覧を出す**（素材の棚に絵を並べる）… サムネイルも要る
 */

import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { layoutPack: layoutAny, openPack, readThumb, thumbRanges, PACK_PREAMBLE } = await import('./src/container.ts');

/**
 * ここも**ハッシュを入れない形**で測る（既定は `header`）。
 * 見ているのは絵の置き所なので、見出しにハッシュを混ぜると
 * 「見出しが太る／細る」の話が 2 つ重なって読めなくなる。
 */
const layoutPack = (project, assets, bodies, options = {}) =>
  layoutAny(project, assets, bodies, { digests: 'none', ...options });
const { splitDataUrl, toDataUrl } = await import('./src/thumbs.ts');
const { memoryBodies, thumbScenario } = await import('./src/scenarios.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'fixtures', 'out', 'pack');
const KB = 1024;
const MB = 1024 * KB;

const PLACEMENTS = ['inline', 'section', 'scattered'];
/** 素材の数。1000 個は「素材の棚に 3 年ぶん溜まった」あたりの見当。 */
const COUNTS = (process.env.LAB_PACK_COUNTS ?? '8,100,1000').split(',').map(Number);
/** 実体 1 つの大きさ。散らばり方を見たいだけなので小さく置く（理由は `thumbScenario` の注）。 */
const BODY_KB = Number(process.env.LAB_PACK_BODY_KB ?? 64);

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const kb = (n) => `${(n / KB).toFixed(1)}`;

/** ファイルの要る所だけを読む口（`bench.mjs` と同じ。ブラウザの `Blob.slice` の役）。 */
async function fileReader(path) {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    read: async (start, end) => {
      const length = Math.max(0, end - start);
      const buf = Buffer.allocUnsafe(length);
      if (length > 0) await handle.read(buf, 0, length, start);
      return new Uint8Array(buf);
    },
    close: () => handle.close(),
  };
}

/** 交互に回して中央値（`export-cost` が 9/26 に確定させた形）。返すのは 1 回あたりの ms。 */
async function interleaved(cases, rounds = Number(process.env.LAB_PACK_ROUNDS ?? 5)) {
  const times = new Map(cases.map((c) => [c.name, []]));
  for (let r = 0; r < rounds; r += 1) {
    for (const c of cases) {
      const t = process.hrtime.bigint();
      await c.run();
      times.get(c.name).push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  return new Map([...times].map(([k, v]) => [k, { mid: median(v), lo: Math.min(...v), hi: Math.max(...v) }]));
}

console.log('サムネイルの置き所 — 見出しに残すか、追い出すか\n');
console.log(`node ${process.version} / 実体 ${BODY_KB}KB × 素材の数 / サムネイルは実測の幅（2.3〜6.4KB）\n`);

// --------------------------------------------------------------------------
// 1. 読む量（時間を測る前に。ここに置き所の違いがそのまま出る）
// --------------------------------------------------------------------------

console.log('## 1. 開くのに読む量と、一覧を出すのに読む量\n');
console.log(
  pad('素材', 7) +
    pad('置き所', 11) +
    rpad('全体 MB', 9) +
    rpad('見出し KB', 11) +
    rpad('1 素材 B', 10) +
    rpad('一覧 +KB', 10) +
    rpad('読む回数', 10) +
    rpad('またぐ MB', 11),
);

const layouts = new Map();
for (const count of COUNTS) {
  const scenario = thumbScenario(count, { bodyBytes: BODY_KB * KB });
  const bodies = memoryBodies(scenario.bodies);
  for (const placement of PLACEMENTS) {
    const layout = layoutPack(scenario.project, scenario.assets, bodies, { thumbs: placement });
    // 読む側から見た形にして数える。**書いた側の数字をそのまま並べない**
    // （見出しの書き方の取り違えは、読み直して初めて出る）。
    const reader = fakeReader(layout);
    const opened = await openPack(reader);
    const ranges = thumbRanges(opened);
    const listBytes = ranges.reduce((s, r) => s + (r.end - r.start), 0);
    // サムネイルが**ファイルの中でどこまで散るか**。一続きなら 0 に近い。
    const span = ranges.length ? ranges[ranges.length - 1].end - ranges[0].start : 0;
    const headerBytes = opened.thumbBase;
    layouts.set(`${count}/${placement}`, { layout, scenario, headerBytes, listBytes, reads: ranges.length, span });
    console.log(
      pad(count, 7) +
        pad(placement, 11) +
        rpad((layout.totalBytes / MB).toFixed(2), 9) +
        rpad(kb(headerBytes), 11) +
        rpad((headerBytes / count).toFixed(0), 10) +
        rpad(kb(listBytes), 10) +
        rpad(ranges.length, 10) +
        rpad((span / MB).toFixed(2), 11),
    );
  }
  console.log('');
}

/**
 * 実体を並べずに「読む口」だけを作る。
 *
 * 1000 個ぶんの実体を本当に並べると 64MB×3 通り積むことになるが、
 * **ここで数えたいのは位置と長さだけ**なので、実体域は 0 で埋めて返す。
 * 前置き（目印＋見出し）とサムネイル域は本物のバイトを渡す——
 * そこは実際に `JSON.parse` して読み直すので、嘘を置くと検算にならない。
 *
 * `layout.thumbParts` は `section` のときだけ中身がある（`container.ts` の注）。
 * `scattered` では絵が実体の間に散るので、ここでは**絵の中身を渡せない**。
 * §1 が数えるのは位置と長さだけなので足りるが、**バイトを比べる測りごとを
 * ここへ足すなら、この口では駄目**（§3 のように本当に並べること）。
 */
function fakeReader(layout) {
  const head = [layout.prefix, ...layout.thumbParts];
  const headLength = head.reduce((s, p) => s + p.length, 0);
  const front = new Uint8Array(headLength);
  let at = 0;
  for (const part of head) {
    front.set(part, at);
    at += part.length;
  }
  return {
    size: layout.totalBytes,
    read: async (start, end) => {
      if (end <= front.length) return front.subarray(start, end);
      const out = new Uint8Array(Math.max(0, end - start));
      if (start < front.length) out.set(front.subarray(start, Math.min(end, front.length)), 0);
      return out;
    },
  };
}

// --------------------------------------------------------------------------
// 2. 時間（実際にファイルへ書いて、読み直す）
// --------------------------------------------------------------------------

const BIG = COUNTS[COUNTS.length - 1];
await mkdir(OUT, { recursive: true });
const scenario = thumbScenario(BIG, { bodyBytes: BODY_KB * KB });
const bodies = memoryBodies(scenario.bodies);
const paths = new Map();
for (const placement of PLACEMENTS) {
  const layout = layoutPack(scenario.project, scenario.assets, bodies, { thumbs: placement });
  const parts = [];
  for (const part of layout.parts) {
    parts.push(part.kind === 'thumb' ? Buffer.from(part.bytes) : Buffer.from(await bodies.bytes(part.id)));
  }
  const path = join(OUT, `thumbs-${placement}.vividpack`);
  await writeFile(path, Buffer.concat([Buffer.from(layout.prefix), ...parts]));
  paths.set(placement, path);
}

console.log(`## 2. 素材 ${BIG} 個のファイルを、実際に読み直す\n`);
console.log(pad('置き所', 11) + rpad('開くだけ ms', 22) + rpad('一覧まで ms', 22) + rpad('絵 1 枚 ms', 22));

const readers = new Map();
for (const [placement, path] of paths) readers.set(placement, await fileReader(path));

/**
 * **9 通りをまとめて交互に回す。**
 *
 * 置き所ごとに 3 つの道を測るので、道ごとに固めて回すと
 * **後から回した道が JIT の温まったぶんだけ速く出る**（実際 1 度踏んだ:
 * 「開くだけ」37.9ms より「一覧まで」29.5ms のほうが速いという、順番が逆の数字が出た）。
 * 9/26 に `export-cost` が確定させたのは「設定を交互に回す」で、
 * ここでの設定は**置き所 × 道の 9 通りぜんぶ**。塊を小さくするのでは足りない。
 */
const TASKS = [
  { key: '開くだけ', run: async (p) => openPack(readers.get(p)) },
  {
    key: '一覧まで',
    run: async (p) => {
      const opened = await openPack(readers.get(p));
      // 一覧を出すのに要るのは「絵の中身ぜんぶ」。`inline` は見出しの中にもう入っている。
      if (opened.header.thumbPlacement === 'inline') {
        let total = 0;
        for (const a of opened.header.assets) total += a.thumbnail.length;
        return total;
      }
      let total = 0;
      for (const r of thumbRanges(opened)) total += (await readers.get(p).read(r.start, r.end)).length;
      return total;
    },
  },
  {
    key: '絵 1 枚',
    run: async (p) => {
      const opened = await openPack(readers.get(p));
      const id = opened.header.assets[Math.floor(BIG / 2)].id;
      if (opened.header.thumbPlacement === 'inline') {
        return opened.header.assets.find((a) => a.id === id).thumbnail.length;
      }
      return (await readThumb(readers.get(p), opened, id)).bytes.length;
    },
  },
];

const timings = await interleaved(
  PLACEMENTS.flatMap((p) => TASKS.map((t) => ({ name: `${p}/${t.key}`, run: () => t.run(p) }))),
);

for (const placement of PLACEMENTS) {
  console.log(
    pad(placement, 11) +
      TASKS.map((t) => {
        const s = timings.get(`${placement}/${t.key}`);
        return rpad(`${s.mid.toFixed(1)} (${s.lo.toFixed(1)}〜${s.hi.toFixed(1)})`, 22);
      }).join(''),
  );
}
for (const r of readers.values()) await r.close();

console.log(
  '\n「開くだけ」はタイムラインを出すまで（見出しを読んで `JSON.parse` する）。\n' +
    '「一覧まで」はそこへ素材の棚の絵をぜんぶ足したもの。\n' +
    '「絵 1 枚」は開いてから 1 枚だけ取り出すまで（棚を少しだけ覗く形）。',
);

// --------------------------------------------------------------------------
// 3. 往復する（追い出した絵が、元の絵と 1 バイトも違わないか）
// --------------------------------------------------------------------------

console.log('\n## 3. 往復\n');
const small = thumbScenario(6, { bodyBytes: 4 * KB, refEvery: 3 });
const smallBodies = memoryBodies(small.bodies);
for (const placement of PLACEMENTS) {
  const layout = layoutPack(small.project, small.assets, smallBodies, { thumbs: placement });
  const parts = [Buffer.from(layout.prefix)];
  for (const part of layout.parts) {
    parts.push(part.kind === 'thumb' ? Buffer.from(part.bytes) : Buffer.from(await smallBodies.bytes(part.id)));
  }
  const bytes = new Uint8Array(Buffer.concat(parts));
  const reader = { size: bytes.length, read: async (s, e) => bytes.subarray(s, e) };
  const opened = await openPack(reader);

  let same = 0;
  let differ = 0;
  for (const [id, meta] of small.assets) {
    const want = meta.thumbnail;
    const inHeader = opened.header.assets.find((a) => a.id === id)?.thumbnail ?? '';
    const pulled = await readThumb(reader, opened, id);
    const got = pulled ? toDataUrl(pulled.type, pulled.bytes) : inHeader;
    if (got === want) same += 1;
    else differ += 1;
  }
  console.log(
    `${pad(placement, 11)} 戻った ${same} / ${same + differ} 枚 ・ ` +
      `見出しに残した ${opened.header.assets.filter((a) => a.thumbnail).length} 枚 ・ ` +
      `追い出した ${opened.header.thumbs.length} 枚`,
  );
}

// --------------------------------------------------------------------------
// 4. 本物の大きさを当てはめると、見出しはどこまで太るか
// --------------------------------------------------------------------------

console.log('\n## 4. 実測のサムネイル（`npm run lab:pack:thumbsize`）を当てはめる\n');
const MEASURED = { min: 2399, mid: 5000, max: 6576, guess: 15 * KB };
console.log(pad('1 枚の data URL', 18) + rpad('素材 100', 12) + rpad('素材 1000', 12) + rpad('素材 5000', 12));
for (const [label, size] of [
  ['実測のいちばん小', MEASURED.min],
  ['実測の中央', MEASURED.mid],
  ['実測のいちばん大', MEASURED.max],
  ['9/28 の当て推量', MEASURED.guess],
]) {
  const cells = [100, 1000, 5000].map((n) => rpad(`${((size + 245) * n / MB).toFixed(2)}MB`, 12));
  console.log(pad(label, 18) + cells.join(''));
}
console.log(
  '\n（245B は素材 1 つぶんの覚え書き。サムネイルを追い出すと、見出しはこの列だけになる）',
);

await rm(OUT, { recursive: true, force: true });
