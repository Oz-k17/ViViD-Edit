/**
 * **ハッシュを「端だけ」で取る形は入れられるか。**
 *
 *   npm run lab:pack:edge
 *
 * 2026-09-28（3 回目）の積み残しの筆頭。README の 7.2 のとおり、ハッシュの費用は全部
 * **「実体を丸ごと読む」**に出る（3.6ms/MB）。7.4 の壊し方 5 つのうち
 * **1 つ（実体の中の 1 バイト）以外は端だけを見れば分かる**形だったので、
 * 端の数十 KB だけを混ぜれば費用が 100 分の 1 になるはず——という見込みが書いてあった。
 * **どこまで見つけられなくなるかを測っていない**ので入れていなかった。ここを測る。
 *
 * ## 見るもの
 *
 *   1. **覆いの割合** — 1 バイトの化けを実体のどこに置くかで振って、端だけが見つける割合
 *   2. **壊し方 × 4 象限** — 「何本見るか（全部／抜き取り 1 本）」×「1 本のどこを見るか（丸ごと／端）」
 *   3. **費用** — 書く側（丸ごと／端だけ／両方）と読む側 4 象限を、同じ回の中で交互に
 *   4. **見出しの太り** — 端のぶんを足すと 1 素材あたり何バイト増えるか
 *
 * **4 象限で見るのが今回の要**。7.4 の「抜き取り 1 本」は*素材*を絞る手で、
 * 端だけは*1 本の中*を絞る手。同じ「安くする」に見えて、絞る向きが直交している。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { attachDigests, layoutPack, openPack, realizePack, readerFromBytes, verifyPack, PACK_PREAMBLE } = await import(
  './src/container.ts'
);
const { digestOf, edgeDigestOf, edgeReadBytes, DEFAULT_EDGE_BYTES } = await import('./src/digest.ts');
const { memoryBodies, pseudoBytes, scenarioAt, thumbScenario } = await import('./src/scenarios.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'fixtures', 'out', 'pack');
const KB = 1024;
const MB = 1024 * KB;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const pct = (n) => `${(n * 100).toFixed(1)}%`;

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

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

await mkdir(OUT, { recursive: true });

// ---------- 1. 覆いの割合 ----------

console.log('\n## 1. 端だけにすると、1 バイトの化けをどれだけ見逃すか\n');

{
  const lengths = [96 * KB, 512 * KB, 4 * MB, 12 * MB];
  const edges = [4 * KB, 64 * KB, 256 * KB];
  // 化けを置く所は**端に寄せずに等間隔で**散らす。端だけを測るのだから、
  // 端に寄せると自分に都合のいい数字が出る（見つかる側しか試さないことになる）。
  const spots = Number(process.env.LAB_PACK_EDGE_SPOTS ?? 201);

  console.log(`${pad('実体', 10)}${edges.map((e) => rpad(`端 ${e / KB}KB`, 14)).join('')}`);
  for (const length of lengths) {
    const body = pseudoBytes(length, 5);
    const row = [];
    for (const edge of edges) {
      const want = await edgeDigestOf(body, edge);
      let found = 0;
      for (let i = 0; i < spots; i += 1) {
        const at = Math.min(length - 1, Math.floor((i * length) / (spots - 1)));
        body[at] ^= 0x01;
        if ((await edgeDigestOf(body, edge)) !== want) found += 1;
        body[at] ^= 0x01;
      }
      const read = edgeReadBytes(length, edge);
      row.push(`${pct(found / spots)} / ${(read / KB).toFixed(0)}KB`);
    }
    console.log(`${pad(`${(length / KB).toFixed(0)}KB`, 10)}${row.map((r) => rpad(r, 14)).join('')}`);
  }
  console.log('\n左が「1 バイトの化けを見つけた割合」、右が「1 本あたり読んだ量」。');
  console.log('**割合は読んだ量 ÷ 実体の大きさそのもの**——端だけの形は「実体の何割を見るか」を選ぶ話で、');
  console.log('12MB の素材を 64KB×2 で見るなら、中身の化けは **99% 見逃す。**');
  console.log('実体が 2N 以下なら端＝全部になるので、小さい素材では 100%（96KB の行）。');
}

// ---------- 2. 壊し方 × 4 象限 ----------

console.log('\n## 2. 壊し方 × 4 象限（何本見るか × 1 本のどこを見るか）\n');

{
  const EDGE = 64 * KB;
  const t = thumbScenario(6, { bodyBytes: 1 * MB });
  const tb = memoryBodies(t.bodies);
  const layout = await attachDigests(layoutPack(t.project, t.assets, tb, { digests: 'header', edges: EDGE }), tb);
  const clean = concat(await realizePack(layout, tb));
  const bodyBase = clean.length - layout.order.reduce((n, o) => n + o.length, 0);

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

  /** 3 本目（真ん中の実体）の位置。 */
  const third = layout.order[2];
  const at = (offset) => bodyBase + third.offset + offset;

  const cases = [
    { name: '実体の先頭 1 バイト', make: () => flip(at(0)) },
    { name: '実体の**中ほど** 1 バイト', make: () => flip(at(third.length >> 1)) },
    { name: '実体の末尾 1 バイト', make: () => flip(at(third.length - 1)) },
    {
      // 意地悪その 1。ディスクのブロックが 1 つ落ちた形。**端には 1 バイトも触らない。**
      name: '中ほどの 4KB が零で埋まった',
      make: () => {
        const b = Uint8Array.from(clean);
        b.fill(0, at(third.length >> 1), at((third.length >> 1) + 4 * KB));
        return b;
      },
    },
    {
      // 意地悪その 2。**端だけの形を狙って潰す素材。** 端 64KB×2 をそのまま残して
      // 中身だけ別のバイト列に差し替える（同じ長さ）。端だけでは原理的に出ない。
      name: '端は同じで、中だけ別物',
      make: () => {
        const b = Uint8Array.from(clean);
        const inner = pseudoBytes(third.length - 2 * EDGE, 99);
        b.set(inner, at(EDGE));
        return b;
      },
    },
    {
      name: '同じ長さの実体が入れ替わった（1 本目と 2 本目）',
      make: () => {
        const b = Uint8Array.from(clean);
        const [x, y] = layout.order;
        const a = b.slice(bodyBase + x.offset, bodyBase + x.offset + x.length);
        const c = b.slice(bodyBase + y.offset, bodyBase + y.offset + y.length);
        b.set(c, bodyBase + x.offset);
        b.set(a, bodyBase + y.offset);
        return b;
      },
    },
    {
      name: '同じ長さの実体が入れ替わった（5 本目と 6 本目）',
      make: () => {
        const b = Uint8Array.from(clean);
        const [x, y] = [layout.order[4], layout.order[5]];
        const a = b.slice(bodyBase + x.offset, bodyBase + x.offset + x.length);
        const c = b.slice(bodyBase + y.offset, bodyBase + y.offset + y.length);
        b.set(c, bodyBase + x.offset);
        b.set(a, bodyBase + y.offset);
        return b;
      },
    },
    { name: 'サムネイル域が 1 長い（門を素通り）', make: () => rewriteHeader(clean, (h) => (h.thumbBytes += 1)) },
    { name: '末尾が切れている', make: () => Uint8Array.from(clean.subarray(0, clean.length - 5000)) },
    {
      // 意地悪その 3。**端だけの形にしか無い弱み。** 見る幅を見出しに預けているので、
      // そこが化けると壊れていない実体まで「違う」と言い出す（丸ごとには起きない）。
      name: '見出しの edgeBytes が化けた',
      make: () => rewriteHeader(clean, (h) => (h.edgeBytes = 32 * KB)),
    },
  ];

  function flip(index) {
    const b = Uint8Array.from(clean);
    b[index] ^= 0x01;
    return b;
  }

  const head = `${pad('壊し方', 40)}${pad('位置だけ', 16)}${pad('全部×丸ごと', 14)}${pad('全部×端', 12)}${pad('1 本×丸ごと', 14)}${pad('1 本×端', 12)}`;
  console.log(head);
  for (const c of cases) {
    const reader = readerFromBytes(c.make());
    try {
      const opened = await openPack(reader);
      const runs = {
        allFull: await verifyPack(reader, opened),
        allEdge: await verifyPack(reader, opened, { depth: 'edge' }),
        oneFull: await verifyPack(reader, opened, { sample: 1 }),
        oneEdge: await verifyPack(reader, opened, { sample: 1, depth: 'edge' }),
      };
      const place = opened.outOfRange.length > 0 ? `範囲外 ${opened.outOfRange.length} 本` : '気づけない';
      const say = (r) => (r.mismatch.length > 0 ? `○ ${r.mismatch.length}/${r.entries.length}` : '×');
      console.log(
        `${pad(c.name, 40)}${pad(place, 16)}${pad(say(runs.allFull), 14)}${pad(say(runs.allEdge), 12)}${pad(say(runs.oneFull), 14)}${pad(say(runs.oneEdge), 12)}`,
      );
    } catch (error) {
      console.log(`${pad(c.name, 40)}${pad('断る（開く前）', 16)}${pad('—', 14)}${pad('—', 12)}${pad('—', 14)}${pad('—', 12)}`);
      void error;
    }
  }

  // 読む量（壊れていないファイルで）
  const ok = readerFromBytes(clean);
  const opened = await openPack(ok);
  const reads = {
    '全部×丸ごと': await verifyPack(ok, opened),
    '全部×端': await verifyPack(ok, opened, { depth: 'edge' }),
    '1 本×丸ごと': await verifyPack(ok, opened, { sample: 1 }),
    '1 本×端': await verifyPack(ok, opened, { sample: 1, depth: 'edge' }),
  };
  console.log('\n読む量（実体 1MB × 6 本・端 64KB）:');
  for (const [name, r] of Object.entries(reads)) {
    console.log(`  ${pad(name, 14)}${rpad((r.bytesRead / KB).toFixed(0) + 'KB', 10)}  （${r.entries.length} 本）`);
  }
  console.log('\n○ が「見つかった」。**列が 4 つに割れているのが今回の要**——');
  console.log('「何本見るか」を絞ると *どの素材* の壊れを見落とし、「端だけ」にすると *実体のどこ* の壊れを見落とす。');
}

// ---------- 3. 費用 ----------

console.log('\n## 3. 費用（96MB・12MB × 8 本。同じ回の中で交互に）\n');

{
  const EDGE = 64 * KB;
  const s = scenarioAt(2);
  const bodies = memoryBodies(s.bodies);

  // **並べる相手をそろえる。** `layoutPack` は 3 通りとも同じだけ通るので先に 1 回だけ作る。
  // 測る中に入れると、端だけ（4ms 台）ではそれが半分を占めて**差が縮んで見えた**
  // （1 回目の測りがそうなっていた。丸ごと 93ms の側では埋もれて気づけない）。
  // **「丸ごとだけ」には `edges: 0` を明示する。** 2026-09-29 に端が既定へ入ったので、
  // 省くと*これも*端を持ち、**同じものを 2 回測って「差は 1.09 倍」と読んでしまう**
  // （1 回目の測りが実際そうなっていた。9/28 の測りには `edges: 0` を足したのに、
  // 新しく書いたこの測りの中で同じ穴を踏んだ）。
  const whole = layoutPack(s.project, s.assets, bodies, { digests: 'header', edges: 0 });
  const edgeOnly = layoutPack(s.project, s.assets, bodies, { digests: 'none', edges: EDGE });
  const both = layoutPack(s.project, s.assets, bodies, { digests: 'header', edges: EDGE });
  const cases = [
    { name: '書く：丸ごとだけ', run: async () => attachDigests(whole, bodies) },
    { name: '書く：端だけ', run: async () => attachDigests(edgeOnly, bodies) },
    { name: '書く：両方', run: async () => attachDigests(both, bodies) },
  ];
  const t = await interleaved(cases);
  console.log(`${pad('やること', 26)}${rpad('ms', 9)}   （最小〜最大）`);
  for (const [name, v] of t) {
    console.log(`${pad(name, 26)}${rpad(v.mid.toFixed(1), 9)}   ${v.lo.toFixed(1)}〜${v.hi.toFixed(1)}`);
  }
  const wholeMs = t.get('書く：丸ごとだけ').mid;
  const edgeMs = t.get('書く：端だけ').mid;
  console.log(
    `\n端だけは丸ごとの **${(edgeMs / wholeMs).toFixed(3)} 倍**（1/${(wholeMs / edgeMs).toFixed(0)}）、` +
      `両方持つと **${(t.get('書く：両方').mid / wholeMs).toFixed(2)} 倍**。`,
  );
  console.log(
    `1MB あたりでは 丸ごと ${(wholeMs / 96).toFixed(2)}ms/MB 対 端だけ ${(edgeMs / 1).toFixed(2)}ms/MB ——` +
      `**読む量は 96 分の 1 でも、時間はそこまで下がらない**（1 本あたりの手間が残る）。`,
  );
  const w = t.get('書く：丸ごとだけ');
  console.log(
    `**添える上乗せは、書く段の振れ（${(w.hi / w.lo).toFixed(2)} 倍）の中に入って測れない。**` +
      ` 読む量は 1 バイトも増えない（同じ 1 回の読みから両方を作る）。`,
  );

  // 読んだバイト数（`memoryBodies.readBytes` が数えている）
  for (const [name, opts] of [
    ['丸ごとだけ', { digests: 'header', edges: 0 }],
    ['端だけ', { digests: 'none', edges: EDGE }],
    ['両方', { digests: 'header', edges: EDGE }],
  ]) {
    const b = memoryBodies(s.bodies);
    await attachDigests(layoutPack(s.project, s.assets, b, opts), b);
    console.log(`  ${pad(name, 12)} 書く側が実体を読んだ量: ${rpad((b.readBytes / MB).toFixed(2) + 'MB', 10)}`);
  }

  // 読む側 4 象限（実際のファイルを 1 本作って測る）
  const layout = await attachDigests(layoutPack(s.project, s.assets, bodies, { digests: 'header', edges: EDGE }), bodies);
  const path = join(OUT, 'edge-probe.bin');
  await writeFile(path, (await realizePack(layout, bodies)).map((p) => Buffer.from(p)));
  const bytes = concat(await realizePack(layout, bodies));
  const reader = readerFromBytes(bytes);
  const opened = await openPack(reader);

  const readCases = [
    { name: '確かめる：全部×丸ごと', run: async () => verifyPack(reader, opened) },
    { name: '確かめる：全部×端', run: async () => verifyPack(reader, opened, { depth: 'edge' }) },
    { name: '確かめる：1 本×丸ごと', run: async () => verifyPack(reader, opened, { sample: 1 }) },
    { name: '確かめる：1 本×端', run: async () => verifyPack(reader, opened, { sample: 1, depth: 'edge' }) },
  ];
  const rt = await interleaved(readCases);
  console.log(`\n${pad('やること', 26)}${rpad('ms', 9)}${rpad('読む MB', 10)}   （最小〜最大）`);
  for (const c of readCases) {
    const v = rt.get(c.name);
    const r = await c.run();
    console.log(
      `${pad(c.name, 26)}${rpad(v.mid.toFixed(2), 9)}${rpad((r.bytesRead / MB).toFixed(3), 10)}   ${v.lo.toFixed(2)}〜${v.hi.toFixed(2)}`,
    );
  }
  await rm(path, { force: true });
}

// ---------- 4. 見出しの太り ----------

console.log('\n## 4. 見出しの太り\n');

{
  // 2 通り並べる。**実体が 2N 以下の側では、端のぶんは 1 バイトも増えない**
  // （そこは端＝全部なので書かない——`digestBodies` の注）。
  for (const [label, count, bodyBytes] of [
    ['素材 1000 個・実体 64KB（端＝全部）', Number(process.env.LAB_PACK_DIGEST_COUNT ?? 1000), 64 * KB],
    ['素材 200 個・実体 512KB（端が要る）', 200, 512 * KB],
  ]) {
    const t = thumbScenario(count, { bodyBytes });
    const tb = memoryBodies(t.bodies);
    const rows = [];
    for (const [name, opts] of [
      ['持たない', { digests: 'none' }],
      ['丸ごとだけ', { digests: 'header', edges: 0 }],
      ['端だけ', { digests: 'none', edges: DEFAULT_EDGE_BYTES }],
      ['両方（既定）', { digests: 'header', edges: DEFAULT_EDGE_BYTES }],
    ]) {
      const layout = await attachDigests(layoutPack(t.project, t.assets, tb, opts), tb);
      rows.push({ name, headerBytes: layout.prefix.length - PACK_PREAMBLE });
    }
    const base = rows[0].headerBytes;
    console.log(`### ${label}\n`);
    console.log(`${pad('持ち方', 22)}${rpad('見出し KB', 12)}${rpad('1 素材 B', 10)}${rpad('太り KB', 10)}`);
    for (const r of rows) {
      console.log(
        `${pad(r.name, 22)}${rpad((r.headerBytes / KB).toFixed(1), 12)}${rpad(Math.round(r.headerBytes / count), 10)}${rpad(((r.headerBytes - base) / KB).toFixed(1), 10)}`,
      );
    }
    console.log('');
  }
  console.log('開く時は見出しを丸ごと読むので、ここは**開く費用**そのもの。');
  console.log('7.3 で「絵が 1000 個で当たった壁（6.2MB）にハッシュが当たるのは素材 10 万個から」と');
  console.log('測れているので、44 バイトがもう 1 つ増えても向きは動かない。');
}

// ---------- 5. 小さい実体では端＝全部 ----------

console.log('\n## 5. 端＝全部になる境界\n');

{
  const edge = 64 * KB;
  for (const length of [0, 1, edge, 2 * edge, 2 * edge + 1]) {
    const body = pseudoBytes(length, 3);
    const same = (await edgeDigestOf(body, edge)) === (await digestOf(body));
    console.log(
      `  ${rpad(length, 8)} バイト: 読む ${rpad(edgeReadBytes(length, edge), 8)} / 丸ごとと同じ値 ${same ? '○' : '×'}`,
    );
  }
  console.log('\n**2N までは端＝全部**（頭と尻が重なるので 1 本にまとめてある）。');
  console.log('ここを別々に混ぜると真ん中が二重に入り、同じバイト列なのに丸ごとと値が変わる。');
}

console.log('');
