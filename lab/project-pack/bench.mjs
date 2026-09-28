/**
 * **プロジェクトを 1 ファイルにまとめると、いくらかかるか。**
 *
 *   npm run lab:pack
 *   LAB_PACK_WALL=1 npm run lab:pack   # base64 の壁に実際にぶつける（400MB 確保する）
 *
 * ## なぜ測るのか
 *
 * いまの本体（`src/engine/project-file.ts`）は**参照素材の在り処だけ**を畳んでいて、
 * 取り込んだ素材は「運べません」と名前を出して落としている。実体を入れるかどうかは
 * 決まっていない。決めるのに要るのは「入れたらどうなるか」の数字なので、それを出す。
 *
 * 比べるのは 3 通り。
 *
 *   1. **参照だけ**（いまの本体）
 *   2. **JSON に base64 で埋める**（いまの形からいちばん近い。`JSON.stringify` を通す）
 *   3. **二進の入れ物**（`container.ts`。見出しの後ろに実体を並べる）
 *
 * ## 測り方
 *
 * 時間は**設定を交互に回して中央値**（`export-cost` が 2026-09-26 に確定させた形。
 * 固めて測ると 1.5 倍くらい平気で化ける）。
 * メモリは「作り終えた時点でまだ生きている量」を見る。これが**ブラウザで落ちる／落ちない**を
 * 決める量で、速さより先に効く。
 */

import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const { layoutPack: layoutAny, openPack, readBody, readerFromBytes, realizePack, PACK_PREAMBLE } = await import(
  './src/container.ts'
);

/**
 * ここは**ハッシュを入れない形**で測る（既定は `header`）。
 *
 * この段の表は「JSON に埋める 対 二進」を並べるためのもので、2026-09-28 の 1 回目に測った。
 * ハッシュを混ぜると大きさも時間もその表と比べられなくなる。
 * ハッシュの費用（書く段が 2.4 倍になる）は `npm run lab:pack:digest` が別に出す。
 */
const layoutPack = (project, assets, bodies, options = {}) =>
  layoutAny(project, assets, bodies, { digests: 'none', ...options });
const { base64Length, buildJsonPack, jsonPackBody, parseJsonPack } = await import('./src/json-pack.ts');
const { planPack } = await import('./src/plan.ts');
const { memoryBodies, scenarioCount, scenarios } = await import('./src/scenarios.ts');

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const MEM_PROBE = join(HERE, 'mem-probe.mjs');
const OUT = join(HERE, '..', 'fixtures', 'out', 'pack');
const MB = 1024 * 1024;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const mb = (n) => `${(n / MB).toFixed(2)}`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** Node の速い base64。測る相手は「素直に書いたらどうなるか」なので、ここは本気の実装を使う。 */
const toBase64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
const fromBase64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

/** ファイルの要る所だけを読む口。ブラウザの `Blob.slice` と同じ役。 */
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

/** 交互に回して中央値を取る。返すのは 1 回あたりのミリ秒。 */
async function interleaved(cases, rounds = 5) {
  const times = new Map(cases.map((c) => [c.name, []]));
  for (let r = 0; r < rounds; r += 1) {
    for (const c of cases) {
      const t = process.hrtime.bigint();
      await c.run();
      times.get(c.name).push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  return new Map([...times].map(([k, v]) => [k, median(v)]));
}

console.log('プロジェクトの持ち出し／取り込み — 1 ファイルにまとめる費用\n');
console.log(`node ${process.version} / 文字列の上限 ${bufferConstants.MAX_STRING_LENGTH.toLocaleString()} 文字\n`);

// ---------- 0. メモリの測りは、いちばん最初にやる ----------
//
// 子プロセスの `ru_maxrss` は fork した時点の親の常駐量を引き継ぐ（`mem-probe.mjs` に経緯）。
// 引き算で床は落とせるが、**子自身の山が床より低いと差が 0 に潰れる**。
// なので親がまだ何も抱えていないこの時点で回してしまう。
// 素材（117MB）を積んでから回して、床に潰されて全部 0.00 と出たのを 1 度踏んだ。

const memory = [];
for (let index = 0; index < scenarioCount(); index += 1) {
  const one = async (mode) => {
    const { stdout } = await execFile(process.execPath, [MEM_PROBE, String(index), mode]);
    return JSON.parse(stdout);
  };
  memory.push({ baseline: await one('baseline'), json: await one('json'), pack: await one('pack') });
}

// ---------- 1. 大きさ ----------

console.log('## 1. ファイルの大きさ\n');
console.log(
  `${pad('構成', 26)}${rpad('実体 MB', 9)}${rpad('参照だけ', 10)}${rpad('JSON MB', 9)}${rpad('二進 MB', 9)}${rpad('JSON/二進', 11)}`,
);
console.log('-'.repeat(74));

const sizes = [];
for (const s of scenarios()) {
  const bodies = memoryBodies(s.bodies);
  const layout = layoutPack(s.project, s.assets, bodies);

  // 参照だけ（いまの本体）。実体を入れないので、見出しだけの大きさになる。
  const refOnly = JSON.stringify({
    app: 'vivid-edit',
    version: 1,
    savedAt: 0,
    project: s.project,
    assets: [...s.assets.values()].filter((a) => a.src),
    localOnly: [...s.assets.values()].filter((a) => !a.src).map((a) => a.name),
  }).length;

  const json = await buildJsonPack(s.project, s.assets, bodies, toBase64);
  const jsonBytes = Buffer.byteLength(json.text);

  sizes.push({ s, layout, jsonBytes });
  console.log(
    pad(s.name, 26) +
      rpad(mb(s.rawBytes), 9) +
      rpad(`${refOnly} B`, 10) +
      rpad(mb(jsonBytes), 9) +
      rpad(mb(layout.totalBytes), 9) +
      rpad(`${(jsonBytes / layout.totalBytes).toFixed(3)} 倍`, 11),
  );
}
console.log('\n（「参照だけ」はいまの本体の形。実体を運ばないので何 MB あっても数百バイト）');

// ---------- 2. 作るときの時間とメモリ ----------

console.log('\n## 2. 作る（組んで、ファイルへ書くまで。時間は交互 5 巡の中央値）\n');
console.log(
  `${pad('構成', 26)}${rpad('JSON 組む', 11)}${rpad('二進 組む', 11)}${rpad('JSON 書く', 11)}${rpad('二進 書く', 11)}${rpad('JSON 計', 10)}${rpad('二進 計', 10)}`,
);
console.log('-'.repeat(80));

await mkdir(OUT, { recursive: true });

for (const [index, { s }] of sizes.entries()) {
  const bodies = memoryBodies(s.bodies);
  const jsonPath = join(OUT, `bench-${index}.json`);
  const packPath = join(OUT, `bench-${index}.vividpack`);

  const build = await interleaved([
    { name: 'json', run: async () => void (await buildJsonPack(s.project, s.assets, bodies, toBase64)) },
    {
      name: 'pack',
      run: async () => {
        const layout = layoutPack(s.project, s.assets, bodies);
        await realizePack(layout, bodies);
      },
    },
  ]);

  // 書く時間も測る。**組む時間だけを並べると二進が不当に有利に見える**
  // （二進は写しを作らないので「組む」がほぼ 0 で、仕事はディスクへ出す所に残っている）。
  const text = (await buildJsonPack(s.project, s.assets, bodies, toBase64)).text;
  const parts = await realizePack(layoutPack(s.project, s.assets, bodies), bodies);
  const write = await interleaved(
    [
      {
        name: 'json',
        run: async () => {
          const h = await open(jsonPath, 'w');
          await h.write(text);
          await h.close();
        },
      },
      {
        name: 'pack',
        run: async () => {
          const h = await open(packPath, 'w');
          for (const part of parts) await h.write(part);
          await h.close();
        },
      },
    ],
    3,
  );
  await rm(jsonPath, { force: true });
  await rm(packPath, { force: true });

  const jsonTotal = build.get('json') + write.get('json');
  const packTotal = build.get('pack') + write.get('pack');
  console.log(
    pad(s.name, 26) +
      rpad(build.get('json').toFixed(1), 11) +
      rpad(build.get('pack').toFixed(1), 11) +
      rpad(write.get('json').toFixed(1), 11) +
      rpad(write.get('pack').toFixed(1), 11) +
      rpad(jsonTotal.toFixed(1), 10) +
      rpad(packTotal.toFixed(1), 10),
  );
}
console.log('\n（単位 ms。「組む」は二進では写しを作らないのでほぼ 0——仕事は「書く」に残る）');

console.log('\n### メモリの山（別プロセス・親が空のうちに測ったもの）\n');
console.log(
  `${pad('構成', 26)}${rpad('実体 MB', 9)}${rpad('素材だけ', 10)}${rpad('JSON MB', 9)}${rpad('二進 MB', 9)}${rpad('JSON 上乗せ', 12)}`,
);
console.log('-'.repeat(75));

for (const [index, { s }] of sizes.entries()) {
  const m = memory[index];
  console.log(
    pad(s.name, 26) +
      rpad(mb(s.rawBytes), 9) +
      rpad(mb(m.baseline.peak), 10) +
      rpad(mb(m.json.peak), 9) +
      rpad(mb(m.pack.peak), 9) +
      rpad(s.rawBytes > 0 ? `${((m.json.peak - m.baseline.peak) / s.rawBytes).toFixed(1)} 倍` : '—', 12),
  );
}
console.log('\n「素材だけ」は実体を用意しただけのプロセスの山。「JSON 上乗せ」は');
console.log('（JSON の山 − 素材だけの山）÷ 実体。**実体の何倍を余分に積むか**。');
console.log('\nJSON は base64 の文字列（実体の 1.33 倍）と `JSON.stringify` の結果（同じく 1.33 倍）を');
console.log('**同時に**抱え、そこへ写しが乗る。二進は実体への参照を並べるだけなので、');
console.log('素材を用意しただけの山とほとんど変わらない。');
console.log('ブラウザなら実体は `Blob` のままなので、二進の側の上乗せは本当に 0 になる。');

// ---------- 3. 開いて実体 1 つを取り出す ----------

console.log('\n## 3. 開いて、実体 1 つを取り出す\n');

const target = sizes.find((x) => x.s.name === '動画 8 本');
{
  const { s, layout } = target;
  const bodies = memoryBodies(s.bodies);
  const path = join(OUT, 'eight.vividpack');

  // 実体を順に書き足していく（ブラウザが Blob を 1 本のファイルへ流すのと同じ形）。
  const handle = await open(path, 'w');
  for (const part of await realizePack(layout, bodies)) await handle.write(part);
  await handle.close();

  const reader = await fileReader(path);
  let bytesRead = 0;
  const counted = {
    size: reader.size,
    read: async (start, end) => {
      bytesRead += Math.max(0, end - start);
      return reader.read(start, end);
    },
  };

  const t0 = process.hrtime.bigint();
  const opened = await openPack(counted);
  const headerMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const headerRead = bytesRead;

  const t1 = process.hrtime.bigint();
  const got = await readBody(counted, opened, 'a5');
  const oneMs = Number(process.hrtime.bigint() - t1) / 1e6;
  await reader.close();

  const built = await buildJsonPack(s.project, s.assets, bodies, toBase64);
  const t2 = process.hrtime.bigint();
  const parsed = parseJsonPack(built.text);
  const parseMs = Number(process.hrtime.bigint() - t2) / 1e6;
  const t3 = process.hrtime.bigint();
  const jsonGot = jsonPackBody(parsed, 'a5', fromBase64);
  const decodeMs = Number(process.hrtime.bigint() - t3) / 1e6;

  console.log(`素材 8 本・${mb(s.rawBytes)}MB のファイルから 6 本目の実体だけを取り出す\n`);
  console.log(`${pad('やること', 34)}${rpad('ms', 9)}${rpad('読んだ MB', 12)}`);
  console.log('-'.repeat(55));
  console.log(pad('二進：見出しを読む', 34) + rpad(headerMs.toFixed(2), 9) + rpad(mb(headerRead), 12));
  console.log(pad('二進：実体 1 つを切り出す', 34) + rpad(oneMs.toFixed(2), 9) + rpad(mb(bytesRead - headerRead), 12));
  console.log(pad('JSON：全体を JSON.parse する', 34) + rpad(parseMs.toFixed(2), 9) + rpad(mb(Buffer.byteLength(built.text)), 12));
  console.log(pad('JSON：base64 を 1 つ戻す', 34) + rpad(decodeMs.toFixed(2), 9) + rpad(mb(0), 12));
  console.log(
    `\n合計  二進 ${(headerMs + oneMs).toFixed(2)}ms（${mb(bytesRead)}MB）` +
      ` / JSON ${(parseMs + decodeMs).toFixed(2)}ms（${mb(Buffer.byteLength(built.text))}MB）` +
      ` = ${((parseMs + decodeMs) / (headerMs + oneMs)).toFixed(1)} 倍`,
  );
  console.log(`取り出した実体が一致: 二進 ${got?.length === 12 * MB} / JSON ${jsonGot?.length === 12 * MB}`);
  await rm(path, { force: true });
}

// ---------- 4. 壁 ----------

console.log('\n## 4. JSON に埋める形の天井\n');
const maxString = bufferConstants.MAX_STRING_LENGTH;
const ceilingBytes = Math.floor(maxString / 4) * 3;
console.log(`文字列の上限            ${maxString.toLocaleString()} 文字`);
console.log(`base64 の太り方          ${(base64Length(MB) / MB).toFixed(4)} 倍`);
console.log(`入れられる実体の合計     ${mb(ceilingBytes)}MB`);
console.log(`\n**1 本ごとではなく合計。** \`JSON.stringify\` はファイルぜんたいを 1 本の文字列にする。`);
console.log(`12MB の動画なら ${Math.floor(ceilingBytes / (12 * MB))} 本、100MB なら ${Math.floor(ceilingBytes / (100 * MB))} 本で天井。`);
console.log(`二進の入れ物には同じ壁が無い（文字列を通らない）。`);

if (process.env.LAB_PACK_WALL === '1') {
  console.log('\n実際にぶつける（LAB_PACK_WALL=1）:');
  for (const sizeMb of [380, 420]) {
    const buf = Buffer.allocUnsafe(sizeMb * MB);
    try {
      const s = buf.toString('base64');
      console.log(`  ${sizeMb}MB → base64 できた（${s.length.toLocaleString()} 文字）`);
    } catch (error) {
      console.log(`  ${sizeMb}MB → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} else {
  console.log('（LAB_PACK_WALL=1 を付けると実際にぶつける。400MB 確保する）');
}

// ---------- 5. 壊れを見つける値を入れるか ----------

console.log('\n## 5. 壊れを見つける値（ハッシュ）を入れるか\n');
{
  const { s } = target;
  const all = Buffer.concat([...s.bodies.values()].map((b) => Buffer.from(b)));
  const t = process.hrtime.bigint();
  const digest = createHash('sha256').update(all).digest('hex').slice(0, 12);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${mb(all.length)}MB の sha256: ${ms.toFixed(1)}ms（${(all.length / MB / (ms / 1000)).toFixed(0)}MB/s）… ${digest}`);
  console.log('\n速さは問題にならない。**入れない理由は速さではない。**');
  console.log('ブラウザの `crypto.subtle.digest` は BufferSource を丸ごと受け取る形しか無く、');
  console.log('少しずつ食わせる口が無い。つまりハッシュを入れると、');
  console.log('**「実体をメモリに乗せない」という二進の入れ物のいちばんの利点が消える。**');
  console.log('入れるなら素材ごとに分けて、開くときではなく「確かめる」ときだけ計算する形になる。');
}

// ---------- 6. 見出しの大きさ ----------

console.log('\n## 6. 見出しはどこまで大きくなるか\n');
{
  const s = scenarios().reduce((a, b) => (b.assets.size > a.assets.size ? b : a), scenarios()[0]);
  const bodies = memoryBodies(s.bodies);
  const layout = layoutPack(s.project, s.assets, bodies);
  const plan = planPack(s.project, s.assets, bodies);
  console.log(`素材 ${s.assets.size} 個で見出し ${layout.prefix.length - PACK_PREAMBLE} バイト`);
  console.log(`1 素材あたり約 ${Math.round((layout.prefix.length - PACK_PREAMBLE) / s.assets.size)} バイト`);
  console.log(`（実体 ${plan.entries.filter((e) => e.disposition === 'embed').length} 個 / 参照 ${plan.entries.filter((e) => e.disposition === 'ref').length} 個）`);
  console.log('\n（ここにサムネイルは入っていない。2026-09-28・2 回目に見出しの外へ出した——');
  console.log('本体と同じ規則で焼くと 1 枚 2.3〜6.4KB あり、素材 1000 個で見出しが 6.2MB になる。');
  console.log('置き所とその数字は `npm run lab:pack:thumbs` と `npm run lab:pack:thumbsize`）。');
}

console.log('');
