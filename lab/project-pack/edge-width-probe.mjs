/**
 * **端の幅 N を、素材の大きさで変えるか。**
 *
 *   npm run lab:pack:width
 *
 * 2026-09-29（1 回目）の積み残しの筆頭。前の回で
 * **端だけの覆いは「読んだ量 ÷ 実体の大きさ」そのもの**だと分かったので、
 * 幅を固定（64KB）にしておくと**大きい素材ほど覆いが薄くなる**。
 * 積み残しには「『長さの 1%』なら覆いは揃うが費用が大きさに比例して戻る」と書いてある。
 * **その交換が本当に交換なのかを測る。**
 *
 * ## 見るもの
 *
 *   1. **方針 × 大きさ** — 固定 / 長さの割合 / 挟む、で覆いと読む量がどう動くか
 *   2. **覆いを上げると何が買えるのか** — 中ほどの化けの検出率は覆いと一致するか
 *   3. **同じ読む量を「端に寄せる」か「散らす」か** — 覆いが同じなら見つかるものも同じか
 *   4. **両端が決まり文句の素材**（意地悪。`boilerplateBytes`）— 幅の**下限**はどこから来るか
 *   5. **費用** — 読む回数を増やすと、同じ量を読んでもどれだけ高くつくか
 *
 * **2 と 3 を分けて測るのが今回の要。** 「覆い」は*どれだけ*読むか、
 * 「散らし方」は*どこを*読むか。前の回に見つけた 2 軸（何本 × 1 本のどこ）の、
 * さらに内側にもう 1 つ軸があるのではないか、という見込みでここを測る。
 */

import { open, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { digestOfParts, edgeRanges, edgeReadBytes, DEFAULT_EDGE_BYTES } = await import('./src/digest.ts');

/**
 * **幅の話をしている所では、散らし方を 2（＝端だけ）で固定する。**
 *
 * この測りが既定を 3 へ動かしたので、`edgeRanges` を省いて呼ぶと
 * **幅の軸を測っているつもりで散らし方の軸が混ざる。** 9/29（1 回目）に
 * 「比べる相手は既定を使わずに書く」と書いた所を、その既定を作った回で踏まないように。
 */
const EDGE_ONLY = 2;
const { boilerplateBytes, pseudoBytes } = await import('./src/scenarios.ts');

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'out', 'pack');

const KB = 1024;
const MB = 1024 * KB;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const pct = (n) => `${(n * 100).toFixed(1)}%`;

/**
 * 交互に回して中央値（`export-cost` が 9/26 に確定させた形）。**ただし順番も毎巡混ぜる。**
 *
 * 9/26 の形は「塊で固めずに交互に回す」までで、**巡の中の順番は固定**だった。
 * それだと**各巡の 1 番目だけが損をする**（場所を取る・掃除が入る）。今回それを踏んだ。
 *
 * **巡回でずらすだけでは足りない。** `cases[(i + r) % n]` は順番を回しているだけなので、
 * **隣り合わせがそのまま残る**——重い案（丸ごと 12MB）の次はいつも同じ案で、
 * その案だけが毎巡その掃除を払う。実際「128KB を 2 個」が 2.63ms と、
 * 同じ量を読む他の案（0.6〜1.2ms）の 4 倍に見えた。**種を固定して混ぜれば消える。**
 * 掃除を誰が払うかが毎巡変わるので、中央値の側に寄らない。
 */
async function interleaved(cases, rounds = Number(process.env.LAB_PACK_ROUNDS ?? 9)) {
  const times = new Map(cases.map((c) => [c.name, []]));
  let x = 20260929;
  const nextRandom = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
  // 捨て巡。**場所を取る所と JIT のぶんを、どの案にも同じだけ払わせてから測る。**
  for (const c of cases) await c.run();
  for (let r = 0; r < rounds; r += 1) {
    const order = [...cases];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(nextRandom() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const c of order) {
      const t = process.hrtime.bigint();
      await c.run();
      times.get(c.name).push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  return new Map([...times].map(([k, v]) => [k, { mid: median(v), lo: Math.min(...v), hi: Math.max(...v) }]));
}

/**
 * 化けを置く所。**等間隔に置かない。**
 *
 * 1 回目の測りは等間隔（`i * length / (spots-1)`）で置いていたが、読む所のほうも
 * 等間隔なので、**周期が噛み合うと当たりすぎる**（散らし 16 個で 4KB のブロック落ちが
 * 11.8% ＝ 覆い 1.0% の 11 倍。噛み合わせが作った数で、散らし方の手柄ではない）。
 * 種を固定した疑似乱数で置けば噛み合わない。
 *
 * **両端（0 と 末尾）は別に数える。** そこはどの方針でも必ず当たるので、
 * 混ぜると覆い 0.1% の方針まで「1.0% 見つけた」と言い出す（201 か所の 2 か所ぶん）。
 */
function spotsIn(length, count, width = 1, seed = 7) {
  let x = seed | 0 || 1;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out.push((x >>> 0) % Math.max(1, length - width));
  }
  return out;
}

/**
 * **同じ読む量を `pieces` 個に分けて、実体の端から端まで等間隔に散らす。**
 *
 * `pieces === 2` のときは端だけ（`edgeRanges`）とちょうど同じ並びになる。
 * つまり**「端だけ」は「散らす」の pieces = 2 の場合**で、別物ではない。
 * ここでは src に入れる前に確かめたいので、測る側に置いてある。
 *
 * 予算（合計 2N）は動かさない。動かすと覆いが変わって、2 と 3 が混ざる。
 */
function spreadRanges(length, edge, pieces) {
  const len = Math.max(0, length);
  const n = Math.max(0, Math.floor(edge));
  const p = Math.max(2, Math.floor(pieces));
  if (n === 0 || len <= n * 2) return [{ from: 0, to: len }];
  const chunk = Math.max(1, Math.floor((n * 2) / p));
  const out = [];
  for (let i = 0; i < p; i += 1) {
    // 端から端まで届かせる。**i=0 は 0 から、i=p-1 は末尾で終わる**ので、
    // pieces=2 なら先頭 N と末尾 N にそのまま落ちる。
    const from = Math.round((i * (len - chunk)) / (p - 1));
    out.push({ from, to: from + chunk });
  }
  return out;
}

const digestOfRanges = (bytes, ranges) => digestOfParts(ranges.map((r) => bytes.subarray(r.from, r.to)));

/** 幅の方針。**「大きさで変えるか」がそのまま並ぶように書く。** */
const POLICIES = [
  { name: '固定 4KB', of: () => 4 * KB },
  { name: '固定 64KB（既定）', of: () => DEFAULT_EDGE_BYTES },
  { name: '固定 256KB', of: () => 256 * KB },
  { name: '長さの 0.5%', of: (len) => Math.floor(len * 0.005) },
  { name: '長さの 5%', of: (len) => Math.floor(len * 0.05) },
  { name: '0.5% を 64KB〜1MB で挟む', of: (len) => Math.min(MB, Math.max(64 * KB, Math.floor(len * 0.005))) },
];

// ---------- 1. 方針 × 大きさ ----------

console.log('\n## 1. 幅の方針 × 実体の大きさ（覆い ＝ 読む量 ÷ 大きさ）\n');

{
  const lengths = [96 * KB, 512 * KB, 4 * MB, 12 * MB, 96 * MB];
  console.log(`${pad('方針', 26)}${lengths.map((l) => rpad(l >= MB ? `${l / MB}MB` : `${l / KB}KB`, 16)).join('')}`);
  for (const p of POLICIES) {
    const row = lengths.map((len) => {
      const n = p.of(len);
      const read = edgeReadBytes(len, n, EDGE_ONLY);
      return `${pct(read / len)} / ${read >= MB ? `${(read / MB).toFixed(1)}MB` : `${(read / KB).toFixed(0)}KB`}`;
    });
    console.log(`${pad(p.name, 26)}${row.map((r) => rpad(r, 16)).join('')}`);
  }
  console.log('\n左が覆い、右が 1 本あたり読む量。**覆いを揃えると読む量が大きさに比例して戻る**のは');
  console.log('そのとおりで、そこは交換になっている。問題は「揃えた先の覆いで何が買えるか」（次）。');
}

// ---------- 2. 覆いを上げると何が買えるのか ----------

console.log('\n## 2. 覆いを上げると、中ほどの化けはどれだけ見つかるようになるか\n');

{
  const length = 12 * MB;
  const body = pseudoBytes(length, 5);
  const count = Number(process.env.LAB_PACK_EDGE_SPOTS ?? 2000);
  const spots = spotsIn(length, count);
  console.log(`実体 12MB・1 バイトの化けを ${count} か所（**種を固定した乱数で置く**。等間隔にしない）\n`);
  console.log(`${pad('方針', 26)}${rpad('幅 N', 10)}${rpad('読む量', 12)}${rpad('覆い', 10)}${rpad('見つけた', 10)}`);
  for (const p of POLICIES) {
    const n = p.of(length);
    const ranges = edgeRanges(length, n, EDGE_ONLY);
    const want = await digestOfRanges(body, ranges);
    let found = 0;
    for (const at of spots) {
      body[at] ^= 0x01;
      if ((await digestOfRanges(body, ranges)) !== want) found += 1;
      body[at] ^= 0x01;
    }
    const read = edgeReadBytes(length, n, EDGE_ONLY);
    console.log(
      `${pad(p.name, 26)}${rpad(n >= MB ? `${(n / MB).toFixed(2)}MB` : `${(n / KB).toFixed(0)}KB`, 10)}` +
        `${rpad(read >= MB ? `${(read / MB).toFixed(2)}MB` : `${(read / KB).toFixed(0)}KB`, 12)}` +
        `${rpad(pct(read / length), 10)}${rpad(pct(found / count), 10)}`,
    );
  }
  console.log('\n**覆いと見つけた割合は同じ数**。つまみで買えるのは確率だけで、確率は読む量に正比例する。');
  console.log('**100% が欲しいなら丸ごと読むしかない**——幅は「丸ごとへの近道」ではない。');
}

// ---------- 3. 同じ読む量を、端に寄せるか散らすか ----------

console.log('\n## 3. 読む量を変えずに、読む所だけ散らす（pieces = 2 が「端だけ」）\n');

{
  const length = 12 * MB;
  const edge = DEFAULT_EDGE_BYTES;
  const pieces = [2, 3, 4, 16, 64];
  const count = Number(process.env.LAB_PACK_EDGE_SPOTS ?? 2000);
  const one = spotsIn(length, count);
  const blocks = spotsIn(length, count, 4 * KB, 21);
  const body = pseudoBytes(length, 5);

  // **散らす案を潰しにいく素材。** 容器の見出しは実体の頭にあるので、
  // 「開けない壊れ方」はそこに集中しやすい。端だけはそこを丸ごと見るが、散らすと薄くなる。
  const headSpots = spotsIn(64 * KB, count, 1, 33);
  const tailSpots = spotsIn(64 * KB, count, 1, 44).map((v) => length - 64 * KB + v);

  const hitRate = async (ranges, want, spots, width) => {
    let n = 0;
    for (const at of spots) {
      if (width === 1) {
        body[at] ^= 0x01;
        if ((await digestOfRanges(body, ranges)) !== want) n += 1;
        body[at] ^= 0x01;
      } else {
        const keep = body.slice(at, at + width);
        body.fill(0, at, at + width);
        if ((await digestOfRanges(body, ranges)) !== want) n += 1;
        body.set(keep, at);
      }
    }
    return n / spots.length;
  };

  console.log(
    `${pad('散らし方', 14)}${rpad('読む量', 9)}${rpad('覆い', 8)}${rpad('全域 1B', 10)}${rpad('全域 4KB', 11)}${rpad('頭 64KB の中', 15)}${rpad('尻 64KB の中', 15)}`,
  );
  for (const p of pieces) {
    const ranges = spreadRanges(length, edge, p);
    const read = ranges.reduce((n, r) => n + (r.to - r.from), 0);
    const want = await digestOfRanges(body, ranges);
    console.log(
      `${pad(`${p} 個`, 14)}${rpad(`${(read / KB).toFixed(0)}KB`, 9)}${rpad(pct(read / length), 8)}` +
        `${rpad(pct(await hitRate(ranges, want, one, 1)), 10)}${rpad(pct(await hitRate(ranges, want, blocks, 4 * KB)), 11)}` +
        `${rpad(pct(await hitRate(ranges, want, headSpots, 1)), 15)}${rpad(pct(await hitRate(ranges, want, tailSpots, 1)), 15)}`,
    );
  }
  console.log('\n**全域に散らした化けは、覆いが同じなら見つかり方も同じ**（散らし方では変わらない）。');
  console.log('4KB のブロックのほうが高いのは、読む所との「重なりしろ」が 4KB ぶん広いからで、');
  console.log('散らすほど（＝1 つの読み所が短くなるほど）その分け前が増える。**覆いの話ではない。**');
  console.log('');
  console.log('**右の 2 列が、散らす案を潰しにいった所。** 容器の見出しは実体の頭にあるので、');
  console.log('「開けない壊れ方」はそこに集中しやすい。端だけはそこを丸ごと見るが、散らすと薄くなる——');
  console.log('**どちらも一方が他方を覆わない。** 端は端に賭け、散らすのは全域へ薄く賭ける。');
}

// ---------- 4. 両端が決まり文句の素材（意地悪） ----------

console.log('\n## 4. 意地悪：両端が「決まり文句」の実体で、入れ替わりを見つけられるか\n');

{
  const length = 12 * MB;
  const kinds = [
    { name: '全域が乱数（いまの素材）', make: (seed) => pseudoBytes(length, seed) },
    { name: '頭 256KB が同じ', make: (seed) => boilerplateBytes(length, seed, { head: 256 * KB }) },
    { name: '尻 256KB が零', make: (seed) => boilerplateBytes(length, seed, { tail: 256 * KB }) },
    { name: '頭 256KB＋尻 256KB', make: (seed) => boilerplateBytes(length, seed, { head: 256 * KB, tail: 256 * KB }) },
    { name: '頭 2MB＋尻 2MB', make: (seed) => boilerplateBytes(length, seed, { head: 2 * MB, tail: 2 * MB }) },
  ];
  // 幅を広げる道（左）と、幅を動かさずに散らす道（右）を並べる。
  // **右はどれも読む量 128KB で同じ**（端 64KB と 1 バイトも変わらない）。
  const widths = [4 * KB, 64 * KB, 256 * KB, MB];
  const spreads = [3, 4, 16];

  console.log(`同じ長さの実体を 2 本作って入れ替える。○ が「違うと言えた」\n`);
  console.log(
    `${pad('素材', 24)}${widths.map((w) => rpad(w >= MB ? `端 ${w / MB}MB` : `端 ${w / KB}KB`, 11)).join('')}` +
      `${spreads.map((p) => rpad(`散らす ${p}`, 11)).join('')}${rpad('丸ごと', 8)}`,
  );
  for (const kind of kinds) {
    const a = kind.make(11);
    const b = kind.make(22);
    const differs = async (ranges) => (await digestOfRanges(a, ranges)) !== (await digestOfRanges(b, ranges));
    const row = [];
    for (const w of widths) row.push((await differs(edgeRanges(length, w, EDGE_ONLY))) ? '○' : '×');
    for (const p of spreads) row.push((await differs(spreadRanges(length, DEFAULT_EDGE_BYTES, p))) ? '○' : '×');
    const all = (await differs([{ from: 0, to: length }])) ? '○' : '×';
    console.log(`${pad(kind.name, 24)}${row.map((r) => rpad(r, 11)).join('')}${rpad(all, 8)}`);
  }
  console.log('\n**右の 3 列は、端 64KB と読む量が 1 バイトも同じ**（128KB）。');
  console.log('端は「幅が決まり文句より広いか」でしか破れないが、**決まり文句の長さは書く側に分からない。**');
  console.log('散らすと幅を広げずに中へ届く。**3 個でもう届く**——読み所を 1 つ真ん中へ置くだけでよい。');
}

// ---------- 5. 費用 ----------

console.log('\n## 5. 費用（読む回数と、幅）\n');

{
  const length = 12 * MB;
  const body = pseudoBytes(length, 5);

  console.log('### 5.1 メモリの上（切り出すだけ）\n');
  const spreadCases = [2, 3, 4, 16, 64, 256].map((p) => ({
    name: `128KB を ${p} 個に分けて読む`,
    run: async () => digestOfRanges(body, spreadRanges(length, DEFAULT_EDGE_BYTES, p)),
  }));
  const t = await interleaved(spreadCases);
  console.log(`${pad('やること', 30)}${rpad('ms', 9)}   （最小〜最大）`);
  for (const [name, v] of t) {
    console.log(`${pad(name, 30)}${rpad(v.mid.toFixed(3), 9)}   ${v.lo.toFixed(3)}〜${v.hi.toFixed(3)}`);
  }
  const two = t.get('128KB を 2 個に分けて読む').mid;
  console.log(
    `\nメモリの上では**回数はほとんど効かない**（16 個で ${(t.get('128KB を 16 個に分けて読む').mid / two).toFixed(2)} 倍・` +
      `256 個で ${(t.get('128KB を 256 個に分けて読む').mid / two).toFixed(2)} 倍）。` +
      '\n**ただしこれは測り方の限界**——subarray は写しを作らないので、ここには読む手間が無い。',
  );

  // ---- ファイルの上 ----
  // **ここが本番。** ブラウザの `Blob.slice(…).arrayBuffer()` に当たるのは
  // 「読む口を 1 回叩く」ほうで、メモリの切り出しではない。
  // 9/29（1 回目）の「100 分の 1 は読む量では当たり、時間では 4 倍外れた」も、
  // 1 本あたりの手間がここに乗っていた。
  console.log('\n### 5.2 ファイルの上（範囲ごとに読む口を叩く）\n');
  await mkdir(OUT, { recursive: true });
  const path = join(OUT, 'width-probe.bin');
  const fh0 = await open(path, 'w');
  await fh0.write(Buffer.from(body));
  await fh0.close();
  const fh = await open(path, 'r');
  const readRanges = async (ranges) => {
    const parts = [];
    for (const r of ranges) {
      const buf = Buffer.allocUnsafe(r.to - r.from);
      await fh.read(buf, 0, buf.length, r.from);
      parts.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    }
    return digestOfParts(parts);
  };
  const fileCases = [
    ...[2, 3, 4, 16, 64, 256].map((p) => ({
      name: `128KB を ${p} 個に分けて読む`,
      run: async () => readRanges(spreadRanges(length, DEFAULT_EDGE_BYTES, p)),
    })),
    { name: '丸ごと 12MB を 1 回で読む', run: async () => readRanges([{ from: 0, to: length }]) },
  ];
  const tf = await interleaved(fileCases);
  console.log(`${pad('やること', 30)}${rpad('ms', 9)}${rpad('読む量', 10)}   （最小〜最大）`);
  for (const [name, v] of tf) {
    const read = name.startsWith('丸ごと') ? '12.00MB' : '128KB';
    console.log(`${pad(name, 30)}${rpad(v.mid.toFixed(3), 9)}${rpad(read, 10)}   ${v.lo.toFixed(3)}〜${v.hi.toFixed(3)}`);
  }
  const f2 = tf.get('128KB を 2 個に分けて読む').mid;
  const f16 = tf.get('128KB を 16 個に分けて読む').mid;
  const f64 = tf.get('128KB を 64 個に分けて読む').mid;
  console.log(
    `\n**回数の代価はここに出る**——16 個で ${(f16 / f2).toFixed(2)} 倍・64 個で ${(f64 / f2).toFixed(2)} 倍。` +
      `\n1 回あたりの手間は **${(((f64 - f2) / 62)).toFixed(4)}ms**（64 個と 2 個の差 ÷ 62 回）。` +
      `丸ごと（${tf.get('丸ごと 12MB を 1 回で読む').mid.toFixed(2)}ms）と比べれば、` +
      `\n**16 個に散らしても、丸ごとの ${(f16 / tf.get('丸ごと 12MB を 1 回で読む').mid * 100).toFixed(1)}% で済む。**`,
  );
  await fh.close();
  await rm(path, { force: true });

  // ---- 幅を振る ----
  console.log('\n### 5.3 幅を広げる費用（メモリの上。量にそのまま比例する）\n');
  const widthCases = [4 * KB, 64 * KB, 256 * KB, MB, 6 * MB].map((n) => ({
    name: `端 ${n >= MB ? `${n / MB}MB` : `${n / KB}KB`}（読む ${(edgeReadBytes(length, n, EDGE_ONLY) / MB).toFixed(2)}MB）`,
    run: async () => digestOfRanges(body, edgeRanges(length, n, EDGE_ONLY)),
  }));
  const tw = await interleaved(widthCases);
  console.log(`${pad('幅', 30)}${rpad('ms', 9)}   （最小〜最大）`);
  for (const [name, v] of tw) {
    console.log(`${pad(name, 30)}${rpad(v.mid.toFixed(3), 9)}   ${v.lo.toFixed(3)}〜${v.hi.toFixed(3)}`);
  }
  console.log('\n**幅を広げる費用は量にそのまま比例する**（1 本あたりの手間は最初の数 KB で飽きる）。');
  console.log('つまり「覆いを買う」と「散らし方を買う」は値段が違う——覆いは量で、散らし方は回数で払う。');
}

console.log('');
