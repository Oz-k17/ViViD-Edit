/**
 * **壊れを見つける値（ハッシュ）を入れるか。入れるならどこに置くか。**
 *
 *   npm run lab:pack:digest
 *
 * 9/28（1 回目）の積み残し。README には「入れない」と書いてあり、理由が 2 つ挙がっていた。
 *
 *   (a) 速さは理由にならない（96MB の sha256 は 79ms で、書く時間より軽い）
 *   (b) ブラウザには流し込む口が無いので、入れると「実体をメモリに乗せない」が壊れる
 *
 * **どちらも、そのままでは信じられない。** (a) は 79ms と 55ms を**別々の測りから**
 * 並べたもので、9/26 に `export-cost` が確定させた「交互に回さないと 1.5 倍化ける」に
 * 引っかかっている。(b) は「ファイル全体で 1 つ持つ」ときの話で、
 * **素材ごとに分けたらどうなるか**は測っていない。ここを測り直す。
 *
 * ## 見るもの
 *
 *   1. ハッシュそのものの速さ（`crypto.subtle` 対 `node:crypto` / 素材ごと 対 まるごと）
 *   2. **書く段と同じ回の中で**並べた費用
 *   3. メモリの山（素材ごと 対 まるごと）
 *   4. 置き所 3 通り（`none` / `header` / `section`）の見出し・開く・確かめる
 *   5. 壊し方 4 通りを見つけられるか、そのとき何バイト読むか
 */

import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const { attachDigests, layoutPack, openPack, realizePack, readerFromBytes, verifyPack, PACK_PREAMBLE } = await import(
  './src/container.ts'
);
const { digestOf, cheapestFirst } = await import('./src/digest.ts');
const { memoryBodies, scenarioAt, thumbScenario } = await import('./src/scenarios.ts');

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const MEM_PROBE = join(HERE, 'mem-probe.mjs');
const OUT = join(HERE, '..', 'fixtures', 'out', 'pack');
const KB = 1024;
const MB = 1024 * KB;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const mb = (n) => `${(n / MB).toFixed(2)}`;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** 交互に回して中央値（`export-cost` が 9/26 に確定させた形。固めて測ると 1.5 倍化ける）。 */
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

/** ファイルの要る所だけを読む口（ブラウザの `Blob.slice` の役）。 */
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

function concat(parts) {
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

await mkdir(OUT, { recursive: true });

// ---------- 1. ハッシュそのものの速さ ----------

console.log('\n## 1. ハッシュそのものの速さ（素材ごと 対 まるごと）\n');

const s = scenarioAt(2); // 動画 8 本（12MB × 8 ＝ 96MB）
const bodies = memoryBodies(s.bodies);
const bodyList = [...s.bodies.values()];
const whole = concat(bodyList);

{
  const t = await interleaved([
    {
      name: 'subtle：素材ごと（8 回）',
      run: async () => {
        for (const b of bodyList) await digestOf(b);
      },
    },
    { name: 'subtle：まるごと 1 回', run: async () => digestOf(whole) },
    {
      name: 'node：素材ごと（8 回）',
      run: async () => {
        for (const b of bodyList) createHash('sha256').update(b).digest();
      },
    },
    {
      name: 'node：流し込み（1 つの値）',
      run: async () => {
        const h = createHash('sha256');
        for (const b of bodyList) h.update(b);
        h.digest();
      },
    },
  ]);

  console.log(`${pad('やり方', 26)}${rpad('ms', 8)}${rpad('MB/s', 8)}   （最小〜最大）`);
  for (const [name, v] of t) {
    console.log(
      `${pad(name, 26)}${rpad(v.mid.toFixed(1), 8)}${rpad((96 / (v.mid / 1000)).toFixed(0), 8)}   ${v.lo.toFixed(1)}〜${v.hi.toFixed(1)}`,
    );
  }
  console.log('\n素材 8 本・合計 96MB。**素材ごとに分けても速さはほとんど落ちない**（境界の手間だけ）。');
  console.log('`node:crypto` のほうが速いが、判断する所はブラウザと同じ道（`crypto.subtle`）で書く。');
}

// ---------- 2. 書く段と同じ回の中で並べる ----------

console.log('\n## 2. 書く段と並べる（README の「書く時間より軽い」を同じ回で測り直す）\n');

{
  const path = join(OUT, 'digest-probe.bin');
  // **並べる相手をそろえる。** 詰める計画と繋ぎ合わせは 3 つとも同じだけ通るので、
  // 先に 1 回だけやっておいて、測る中では「書く」と「ハッシュ」だけを回す。
  const plain = await realizePack(layoutPack(s.project, s.assets, bodies, { digests: 'none' }), bodies);
  const layoutH = layoutPack(s.project, s.assets, bodies, { digests: 'header' });
  const restH = (await realizePack(await attachDigests(layoutH, bodies), bodies)).slice(1);

  const t = await interleaved([
    { name: '書く（96MB・8 本）', run: async () => writeFile(path, plain.map((p) => Buffer.from(p))) },
    {
      name: 'ハッシュ（素材ごと 8 本）',
      run: async () => {
        for (const b of bodyList) await digestOf(b);
      },
    },
    {
      name: 'ハッシュ→書く',
      run: async () => {
        const l = await attachDigests(layoutH, bodies);
        await writeFile(path, [Buffer.from(l.prefix), ...restH.map((p) => Buffer.from(p))]);
      },
    },
  ]);

  const write = t.get('書く（96MB・8 本）');
  const hash = t.get('ハッシュ（素材ごと 8 本）');
  const both = t.get('ハッシュ→書く');
  console.log(`${pad('やること', 24)}${rpad('ms', 9)}   （最小〜最大）`);
  for (const [name, v] of t) {
    console.log(`${pad(name, 24)}${rpad(v.mid.toFixed(1), 9)}   ${v.lo.toFixed(1)}〜${v.hi.toFixed(1)}`);
  }
  console.log(`\nハッシュ ÷ 書く = 中央値で **${(hash.mid / write.mid).toFixed(2)} 倍**、`);
  console.log(`足すと書く段が ${write.mid.toFixed(0)} → ${both.mid.toFixed(0)}ms（**${(both.mid / write.mid).toFixed(2)} 倍**）。`);
  // **倍率そのものが測りごとに振れる。** 書く段は最小と最大で何倍も違うので、
  // 「ハッシュは書く時間より軽い／重い」を 1 つの倍率で言い切れない。両端も出しておく。
  console.log(
    `倍率の幅: ${(hash.lo / write.hi).toFixed(2)}〜${(hash.hi / write.lo).toFixed(2)} 倍` +
      `（書く段が ${write.lo.toFixed(0)}〜${write.hi.toFixed(0)}ms と ${(write.hi / write.lo).toFixed(1)} 倍振れる）。`,
  );
  await rm(path, { force: true });
}

// ---------- 3. メモリの山 ----------

console.log('\n## 3. メモリの山（素材ごと 対 まるごと）\n');

{
  const modes = ['baseline', 'pack', 'digest-each', 'digest-whole'];
  const rows = [];
  for (const mode of modes) {
    const { stdout } = await execFile(process.execPath, [MEM_PROBE, '2', mode], {
      maxBuffer: 64 * MB,
    });
    rows.push({ mode, ...JSON.parse(stdout) });
  }
  const base = rows.find((r) => r.mode === 'baseline');
  console.log(`${pad('やり方', 22)}${rpad('山 MB', 10)}${rpad('素材を引いた MB', 18)}`);
  for (const r of rows) {
    console.log(`${pad(r.mode, 22)}${rpad(mb(r.peak), 10)}${rpad(mb(r.peak - base.peak), 18)}`);
  }
  console.log('\n実体は 96MB（12MB × 8）。`digest-each` は 1 本ずつ読んで捨てる、');
  console.log('`digest-whole` はファイル全体で 1 つの値にする（＝繋げてから渡す）。');
}

// ---------- 4. 置き所 ----------

console.log('\n## 4. 置き所（素材 1000 個）\n');

{
  const count = Number(process.env.LAB_PACK_DIGEST_COUNT ?? 1000);
  const t = thumbScenario(count, { bodyBytes: 64 * KB });
  const tb = memoryBodies(t.bodies);
  const built = new Map();

  for (const digests of ['none', 'header', 'section']) {
    const layout = await attachDigests(layoutPack(t.project, t.assets, tb, { digests }), tb);
    const bytes = concat(await realizePack(layout, tb));
    const path = join(OUT, `digest-${digests}.bin`);
    await writeFile(path, bytes);
    built.set(digests, { layout, path, headerBytes: layout.prefix.length - PACK_PREAMBLE, total: bytes.length });
  }

  const none = built.get('none');
  console.log(`${pad('置き所', 10)}${rpad('見出し KB', 12)}${rpad('1 素材 B', 10)}${rpad('域 KB', 9)}${rpad('全体 MB', 10)}`);
  for (const [name, b] of built) {
    const area = b.layout.header.digestBytes;
    console.log(
      `${pad(name, 10)}${rpad((b.headerBytes / KB).toFixed(1), 12)}${rpad(Math.round(b.headerBytes / count), 10)}${rpad((area / KB).toFixed(1), 9)}${rpad(mb(b.total), 10)}`,
    );
  }
  console.log(`\n見出しの太り: header +${((built.get('header').headerBytes - none.headerBytes) / KB).toFixed(1)}KB / section +${((built.get('section').headerBytes - none.headerBytes) / KB).toFixed(1)}KB`);

  // 開くだけ（見出しを読む）と、全部確かめる
  const cases = [];
  for (const [name, b] of built) {
    cases.push({
      name: `${name}：開く`,
      run: async () => {
        const r = await fileReader(b.path);
        await openPack(r);
        await r.close();
      },
    });
  }
  for (const [name, b] of built) {
    if (name === 'none') continue;
    cases.push({
      name: `${name}：全部確かめる`,
      run: async () => {
        const r = await fileReader(b.path);
        const opened = await openPack(r);
        await verifyPack(r, opened);
        await r.close();
      },
    });
    cases.push({
      name: `${name}：抜き取り 1 本`,
      run: async () => {
        const r = await fileReader(b.path);
        const opened = await openPack(r);
        await verifyPack(r, opened, { sample: 1 });
        await r.close();
      },
    });
  }

  const times = await interleaved(cases, Number(process.env.LAB_PACK_ROUNDS ?? 5));
  console.log(`\n${pad('やること', 24)}${rpad('ms', 9)}   （最小〜最大）`);
  for (const [name, v] of times) {
    console.log(`${pad(name, 24)}${rpad(v.mid.toFixed(2), 9)}   ${v.lo.toFixed(2)}〜${v.hi.toFixed(2)}`);
  }

  // 読む量
  for (const [name, b] of built) {
    if (name === 'none') continue;
    const r = await fileReader(b.path);
    const opened = await openPack(r);
    const all = await verifyPack(r, opened);
    const one = await verifyPack(r, opened, { sample: 1 });
    await r.close();
    console.log(
      `${pad(name, 10)} 確かめるのに読む: 全部 ${mb(all.bytesRead)}MB（${all.entries.length} 本）/ 抜き取り 1 本 ${(one.bytesRead / KB).toFixed(1)}KB`,
    );
  }

  for (const [, b] of built) await rm(b.path, { force: true });
}

// ---------- 5. 壊し方 4 通り ----------

console.log('\n## 5. 壊し方を見つけられるか\n');

{
  const t = thumbScenario(6, { bodyBytes: 32 * KB });
  const tb = memoryBodies(t.bodies);
  const layout = await attachDigests(layoutPack(t.project, t.assets, tb, { digests: 'header' }), tb);
  const clean = concat(await realizePack(layout, tb));

  /** 見出しの JSON を書き換えて、長さも直したファイルを作る。 */
  function rewriteHeader(bytes, edit) {
    const headerBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(PACK_PREAMBLE, PACK_PREAMBLE + headerBytes)));
    edit(header);
    const json = new TextEncoder().encode(JSON.stringify(header));
    const prefix = new Uint8Array(PACK_PREAMBLE + json.length);
    prefix.set(bytes.subarray(0, 8));
    new DataView(prefix.buffer).setUint32(8, json.length, true);
    prefix.set(json, PACK_PREAMBLE);
    return concat([prefix, bytes.subarray(PACK_PREAMBLE + headerBytes)]);
  }

  const cases = [
    {
      name: '1 バイトだけ化けた',
      make: () => {
        const b = Uint8Array.from(clean);
        b[b.length - 1000] ^= 0x01;
        return b;
      },
    },
    {
      name: '同じ長さの実体が入れ替わった',
      make: () => {
        const b = Uint8Array.from(clean);
        const [x, y] = layout.order;
        const base = clean.length - layout.order.reduce((n, o) => n + o.length, 0);
        const a = b.slice(base + x.offset, base + x.offset + x.length);
        const c = b.slice(base + y.offset, base + y.offset + y.length);
        b.set(c, base + x.offset);
        b.set(a, base + y.offset);
        return b;
      },
    },
    {
      // 9/28（2 回目）に入れた門（絵が域からはみ出したら断る）がここで効く。
      name: 'サムネイル域が 1 短い（門が断る）',
      make: () => rewriteHeader(clean, (h) => (h.thumbBytes -= 1)),
    },
    {
      // **こちらは門を素通りする。** 域が長い側へずれると絵は域の中に収まったままなので、
      // 「絵が域からはみ出す」に引っかからない。実体の位置だけが全部ずれる
      // ＝ README 6.4 が「長さは通るので気づけない」と書いた形そのもの。
      name: 'サムネイル域が 1 長い（門を素通り）',
      make: () => rewriteHeader(clean, (h) => (h.thumbBytes += 1)),
    },
    {
      name: '末尾が切れている',
      make: () => Uint8Array.from(clean.subarray(0, clean.length - 5000)),
    },
  ];

  console.log(`${pad('壊し方', 30)}${pad('位置だけで（元から）', 22)}${pad('ハッシュで', 20)}${pad('抜き取り 1 本', 14)}`);
  for (const c of cases) {
    const bytes = c.make();
    const reader = readerFromBytes(bytes);
    try {
      const opened = await openPack(reader);
      const all = await verifyPack(reader, opened);
      const one = await verifyPack(reader, opened, { sample: 1 });
      const byPlace = opened.outOfRange.length > 0 ? `実体 ${opened.outOfRange.length} 本が範囲外` : '気づけない';
      console.log(
        `${pad(c.name, 30)}${pad(byPlace, 22)}${pad(`${all.mismatch.length} / ${all.entries.length} 本が違う`, 20)}${pad(one.mismatch.length > 0 ? '見つかる' : '見つからない', 14)}`,
      );
    } catch (error) {
      console.log(`${pad(c.name, 30)}${pad('断る（開く前）', 22)}${pad(`— ${error.message.slice(0, 18)}…`, 20)}${pad('—', 14)}`);
    }
  }
  console.log('\n**ハッシュが足すのは「読めるが中身が違う」の列だけ。** 切れている・はみ出しているのは、');
  console.log('もともと位置で見つかっていた（`outOfRange`）。**抜き取りで見つかるのは「ずれ」だけ**で、');
  console.log('1 本だけ化けた形はその 1 本を引かないと出ない。');
}

console.log('');
