/**
 * **打点を持つと、1 コマあたりどれだけ高くつくか。**
 *
 *   npm run lab:keyframe
 *
 * ## なぜ測るのか
 *
 * 読み出しは**毎コマ × 出ているクリップ × 動かす値**の数だけ呼ばれる。
 * 60 秒・30fps・3 本重なり・1 本に 4 つ動かす値があれば 1 本の書き出しで 21,600 回。
 * ここが重ければ「打点を置くと書き出しが遅くなる」になるので、
 * **持ち方を決めた回のうちに桁を押さえておく**（あとで遅いと分かってから直すのがいちばん高い）。
 *
 * ## 測るもの
 *
 *   1. **1 回あたりの費用**——素の数 / 打点 2・8・64・512 個
 *   2. **書き出し 1 本ぶんの上乗せ**——上の数を実際のコマ数に掛けたもの
 *   3. **二分探索と線形探索**——打点が増えたときの差（探し方を選んだ根拠）
 *   4. **保存の太り**——JSON の実バイト数（素のクリップ / 打点つき / 30 本のプロジェクト）
 *
 * ## 測り方
 *
 * **設定を交互に回す**（`export-cost` が 2026-09-26 に確定させた形）。
 * 固めて測ると 1.5 倍くらい平気で化けるので、1 巡ずつ順番に回して**中央値**を取る。
 * ここは効きが数 % 〜 数倍の話なので、固めて測ると読み違える。
 */

const { sampleAnimated, normalizeKeys, easeAt } = await import('./src/value.ts');
const { sampleClipValue, kenBurns } = await import('./src/track.ts');

const pad = (s, n) => String(s).padEnd(n);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

const clip = { kind: 'video', start: 2, duration: 60, sourceIn: 10, speed: 1 };

/** 打点を n 個持つ値（時刻は素材の秒で、60 秒ぶんに散らす）。 */
function keyed(n) {
  const keys = [];
  for (let i = 0; i < n; i += 1) {
    keys.push({ t: 10 + (i * 60) / Math.max(1, n - 1), v: i % 2 === 0 ? 1 : 0.4, ease: 'easeInOut' });
  }
  return { base: 'source', keys: normalizeKeys(keys) };
}

/**
 * 線形に探す版（比べる相手）。
 *
 * **繋ぎ方の計算（`easeAt`）まで同じに通してある。** 最初はここを素の線形補間で書いていて、
 * 線形探索が 5 倍速いという数字が出た。測っていたのは探し方ではなく `easeAt` の呼び出しだった。
 */
function sampleLinear(value, t) {
  const keys = value.keys;
  if (keys.length === 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i += 1;
  const a = keys[i];
  const b = keys[i + 1];
  return a.v + (b.v - a.v) * easeAt(a.ease, (t - a.t) / (b.t - a.t));
}

const CALLS = 200_000;

/** 交互に回して中央値を取る。返すのは 1 回あたりのナノ秒。 */
function runInterleaved(cases, rounds = 7) {
  const times = new Map(cases.map((c) => [c.name, []]));
  // 1 巡ぶん空回しして、最初の最適化ぶんを落とす。
  for (const c of cases) c.run(CALLS / 10);
  for (let r = 0; r < rounds; r += 1) {
    for (const c of cases) {
      const t0 = process.hrtime.bigint();
      const sink = c.run(CALLS);
      const t1 = process.hrtime.bigint();
      if (!Number.isFinite(sink)) throw new Error(`${c.name} が数を返していない`);
      times.get(c.name).push(Number(t1 - t0) / CALLS);
    }
  }
  return cases.map((c) => ({ name: c.name, ns: median(times.get(c.name)) }));
}

/** 標本化を CALLS 回。時刻は毎回変える（同じ時刻だと分岐が読まれてしまう）。 */
const sampler = (value) => (n) => {
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += sampleClipValue(clip, value, 2 + (i % 1800) / 30, 1);
  return acc;
};

console.log('## 1. 1 回あたりの費用（交互に 7 巡・中央値）\n');
const cases = [
  { name: '素の数（いまの本体）', run: sampler(0.8) },
  { name: '打点 2 個', run: sampler(keyed(2)) },
  { name: '打点 8 個', run: sampler(keyed(8)) },
  { name: '打点 64 個', run: sampler(keyed(64)) },
  { name: '打点 512 個', run: sampler(keyed(512)) },
  { name: 'ケンバーンズ（割合・打点 2 個）', run: sampler(kenBurns()) },
];
const one = runInterleaved(cases);
const plain = one[0].ns;
for (const r of one) {
  console.log(`  ${pad(r.name, 30)} ${r.ns.toFixed(1)} ns  （素の数の ${(r.ns / plain).toFixed(1)} 倍）`);
}

console.log('\n## 2. 書き出し 1 本ぶんの上乗せ（60 秒・30fps・3 本重なり・1 本に 4 値）\n');
const CALLS_PER_EXPORT = 60 * 30 * 3 * 4;
for (const r of one) {
  const ms = (r.ns * CALLS_PER_EXPORT) / 1e6;
  console.log(`  ${pad(r.name, 30)} ${ms.toFixed(2)} ms / ${CALLS_PER_EXPORT} 回`);
}
console.log(
  '\n  比べる相手: `export-cost` が測った 1024×576 の書き出しは 390 コマで decode 878〜2519ms\n' +
    '  （1 コマあたり 2.3〜6.5ms）。上の数字はその 1 コマぶんにも届かない。',
);

console.log('\n## 3. 二分探索と線形探索（打点が増えたとき）\n');
console.log('  探し方だけを入れ替えて比べる（時刻の作り方も、呼ぶ深さも同じにしてある）。\n');
for (const n of [2, 8, 16, 32, 64, 512]) {
  const value = keyed(n);
  const [bin, lin] = runInterleaved([
    {
      name: 'binary',
      run: (calls) => {
        let acc = 0;
        for (let i = 0; i < calls; i += 1) acc += sampleAnimated(value, 10 + (i % 1800) / 30, 1);
        return acc;
      },
    },
    {
      name: 'linear',
      run: (calls) => {
        let acc = 0;
        for (let i = 0; i < calls; i += 1) acc += sampleLinear(value, 10 + (i % 1800) / 30);
        return acc;
      },
    },
  ]);
  console.log(
    `  打点 ${pad(n, 4)} 二分 ${bin.ns.toFixed(1)} ns / 線形 ${lin.ns.toFixed(1)} ns  （線形は ${(
      lin.ns / bin.ns
    ).toFixed(2)} 倍）`,
  );
}

console.log('\n## 4. 保存の太り（JSON の実バイト数）\n');
const bare = {
  id: 'cl_1', kind: 'video', mediaId: 'md_1', start: 0, duration: 6, sourceIn: 0,
  speed: 1, volume: 1, muted: false, loop: false, opacity: 1, scale: 1, x: 0, y: 0,
  rotate: 0, fit: 'cover', fadeIn: 0, fadeOut: 0,
};
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const tidyKeys = (n) => ({
  base: 'source',
  keys: Array.from({ length: n }, (_, i) => ({ t: i * 0.5, v: i % 2 === 0 ? 1 : 0.4 })),
});
const withKeys = { ...bare, scale: tidyKeys(2), opacity: tidyKeys(4) };
console.log(`  打点なしのクリップ 1 個        ${bytes(bare)} バイト`);
console.log(
  `  scale に 2 個・opacity に 4 個  ${bytes(withKeys)} バイト  （+${bytes(withKeys) - bytes(bare)}）`,
);
console.log(
  `  打点 1 個ぶん                  ${bytes({ t: 1.5, v: 0.4 })} バイト` +
    `（繋ぎ方まで書くと ${bytes({ t: 1.5, v: 0.4, ease: 'easeInOut' })} バイト）`,
);
const project30 = { clips: Array.from({ length: 30 }, (_, i) => ({ ...bare, id: `cl_${i}` })) };
const project30k = {
  clips: project30.clips.map((c, i) => (i % 10 === 0 ? { ...c, scale: tidyKeys(6) } : c)),
};
console.log(
  `  30 本のプロジェクト            ${bytes(project30)} → ${bytes(project30k)} バイト` +
    `（3 本に打点 6 個: +${((bytes(project30k) / bytes(project30) - 1) * 100).toFixed(1)}%）`,
);
console.log(
  '\n  `normalizeKeys()` が繋ぎ方 `linear` を書かずに畳むので、既定の繋ぎ方のままなら 1 個 15 バイト。',
);

console.log('\n## 5. 打点を整える費用（書き込む側で 1 回だけ通る所）\n');
for (const n of [8, 64, 512]) {
  // わざと逆順の列を渡す（並べ替えが効く最悪の側）。
  const keys = keyed(n).keys.slice().reverse();
  const rounds = [];
  for (let r = 0; r < 7; r += 1) {
    const loops = 2000;
    const t0 = process.hrtime.bigint();
    let sink = 0;
    for (let i = 0; i < loops; i += 1) sink += normalizeKeys(keys).length;
    const t1 = process.hrtime.bigint();
    if (sink !== loops * n) throw new Error('整えた列の長さが合わない');
    rounds.push(Number(t1 - t0) / loops);
  }
  console.log(`  打点 ${pad(n, 4)} ${median(rounds).toFixed(0)} ns / 1 回`);
}
console.log(
  '\n  打点を動かすたびに 1 回通るだけなので、512 個でも人の手の速さ（数十 ms）には桁で届かない。\n' +
    '  読み出しの側（毎コマ）に並べ替えを置かない、という分け方の根拠がこれ。\n',
);
