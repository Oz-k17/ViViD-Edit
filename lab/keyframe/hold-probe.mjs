/**
 * **既定でない時間軸を、打点の外のどこに持つか。** 4 通りを操作に当てて測る。
 *
 *   npm run lab:keyframe:hold
 *
 * ## なぜ測るのか
 *
 * 2026-09-27 の 1 回目に「時間軸は値と一緒に持つ」と決め、2 回目に画面を作ったら
 * **打点が 0 個の値には軸が残っていない**ことが出た（`removeKeyAt()` が素の数へ畳むため）。
 * 画面は自分で覚えて逃げているが、覚えているのが画面なら**保存も複製もコピーも運べない。**
 *
 * 直し方は 4 つある。**「軸が生き残るか」だけでは選べない**——持つ場所を変えると、
 * 落ちる操作が入れ替わるだけのことがある。なので**操作 × 持ち方**で、
 * 消えたのが**軸か値か**を分けて数える。
 *
 * ## 測るもの
 *
 *   0. **素材の確かめ**——選んだ軸が、その素材の期待を素で満たすか（ここが崩れたら以降は読めない）
 *   1. **何が生き残るか**——操作 6 つ × 持ち方 4 つ（軸 / 値）
 *   2. **被害**——軸が消えたあと、編集すると期待から何本外れるか（`probe.mjs` と同じ物差し）
 *   3. **打点の立つ所**——軸が消えた瞬間に、打点はタイムラインで何秒動くか
 *   4. **費用**——JSON のバイト数と、読み出しのナノ秒
 *   5. **本体に入る傷**——手を入れる箇所（数えたもの。測ってはいない）
 */

const {
  HOLDS,
  HOLD_NOTE,
  OFF_DEFAULTS,
  asLabClip,
  baseOf,
  bytesOf,
  chooseBase,
  clearAll,
  copyValueOnly,
  duplicateClip,
  keyStandsAt,
  keysIn,
  otherClip,
  putAt,
  readAt,
  saveLoad,
  slotFor,
  splitRight,
} = await import('./src/hold.ts');
const { defaultTrackBase, sampleClipValue, timeAtKeyTime } = await import('./src/track.ts');
const { intendedOf, scoreAgainst, EXACT } = await import('./src/scenarios.ts');
const { applyOp, editOps } = await import('./src/timebase.ts');
const { normalizeKeys } = await import('./src/value.ts');

const FPS = 30;
const pad = (s, n) => String(s).padEnd(n);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const mark = (ok) => (ok ? '○' : '✗');

const opsFor = (s) =>
  editOps({
    moveBy: s.edits.moveBy,
    trimHead: s.edits.trimHead,
    trimTail: s.edits.trimTail,
    splitAt: () => s.edits.splitAt,
    speedTo: s.edits.speedTo,
    rippleBy: s.edits.rippleBy,
  });

/** その `Slot` を編集 6 操作に当てて、期待どおりだった数と最悪のずれ。 */
function scoreSlot(hold, s, slot) {
  const want = intendedOf(s);
  const base = baseOf(hold, slot);
  let exact = 0;
  let worst = 0;
  const ops = opsFor(s);
  for (const op of ops) {
    const before = asLabClip(hold, slot, s.fallback, s.name);
    let bad = 0;
    for (const after of applyOp(op, base, before, 'raw')) {
      if (after.duration <= 0) continue;
      bad = Math.max(bad, scoreAgainst(want, base, after, FPS).max);
    }
    if (bad <= EXACT) exact += 1;
    worst = Math.max(worst, bad);
  }
  return { exact, total: ops.length, worst };
}

// --- 0. 素材の確かめ ------------------------------------------------------------
console.log('## 0. 素材の確かめ（選んだ軸が、その素材の期待を素で満たすか）\n');
console.log(`  ${pad('素材', 18)}${pad('種類', 7)}${pad('既定', 10)}${pad('選ぶ軸', 10)}${pad('期待', 9)}素で通る`);
let sane = true;
for (const s of OFF_DEFAULTS) {
  const slot = slotFor('stillValue', s);
  const { exact, total, worst } = scoreSlot('stillValue', s, slot);
  if (exact !== total) sane = false;
  console.log(
    `  ${pad(s.name, 18)}${pad(s.kind, 7)}${pad(defaultTrackBase(s.kind), 10)}${pad(s.want, 10)}` +
      `${pad(s.intent, 9)}${exact}/${total}（最悪 ${worst <= EXACT ? '0' : worst.toFixed(4)}）`,
  );
}
console.log(
  `\n  4 本とも既定から外した軸で、${sane ? 'すべて素で通る' : '**通らないものがある**'}。\n` +
    '  （通らなければ「軸が消えた被害」と「軸の選び間違い」が混ざるので、以降の表は読めない）\n',
);

// --- 1. 何が生き残るか ----------------------------------------------------------
console.log('## 1. 何が生き残るか（操作 × 持ち方。軸 / 値）\n');

/** 操作の一覧。`run` は（持ち方・素材）から「操作後の Slot と、読める値の期待」を返す。 */
const CARRIES = [
  {
    name: '保存して読み直す',
    run: (hold, s) => ({ after: saveLoad(slotFor(hold, s)), wantValue: null }),
  },
  {
    name: 'クリップを複製する',
    run: (hold, s) => ({ after: duplicateClip(slotFor(hold, s)), wantValue: null }),
  },
  {
    name: 'クリップを割る',
    run: (hold, s) => ({ after: splitRight(slotFor(hold, s), s.edits.splitAt), wantValue: null }),
  },
  {
    name: '打点を全部消す',
    run: (hold, s) => {
      const slot = slotFor(hold, s);
      const last = keysIn(slot.value).at(-1).v;
      return { after: clearAll(hold, slot), wantValue: last };
    },
  },
  {
    // 一度も打点を置いていない値に、軸だけ先に決める（「尺に伸ばしたい」を先に選ぶ）。
    name: '打点を置く前に軸を選ぶ',
    run: (hold, s) => {
      const bare = { ...slotFor(hold, s), value: 0.8 };
      const after = chooseBase(hold, bare, s.want);
      return { after, wantValue: 0.8 };
    },
  },
  {
    name: '値だけ別のクリップへ写す',
    run: (hold, s) => ({ after: copyValueOnly(slotFor(hold, s), otherClip(s)), wantValue: null }),
  },
];

const survived = new Map();
console.log(`  ${pad('', 26)}${HOLDS.map((h) => pad(h, 13)).join('')}`);
for (const carry of CARRIES) {
  const cells = HOLDS.map((hold) => {
    let baseOk = true;
    let valueOk = true;
    for (const s of OFF_DEFAULTS) {
      const { after, wantValue } = carry.run(hold, s);
      if (after === null) {
        baseOk = false;
        continue;
      }
      if (baseOf(hold, after) !== s.want) baseOk = false;
      if (wantValue !== null) {
        const got = readAt(hold, after, after.clip.start, s.fallback);
        if (Math.abs(got - wantValue) > EXACT) valueOk = false;
      }
    }
    survived.set(`${carry.name}|${hold}`, { baseOk, valueOk });
    return pad(`軸 ${mark(baseOk)} 値 ${mark(valueOk)}`, 13);
  });
  console.log(`  ${pad(carry.name, 26)}${cells.join('')}`);
}
console.log(
  '\n  `inKeys` の「軸を選ぶ」が ✗ なのは間違えたからではなく、**書く場所が無い**から\n' +
    '  （打点が 0 個の値は素の数で、`base` を置く所がどこにもない）。\n' +
    '  上の 3 つはクリップごと運ぶ操作なので 4 通りとも通る。**分かれるのは下の 3 つだけ。**\n',
);

// --- 2. 被害（軸が消えたあとに編集する） -----------------------------------------
console.log('## 2. 被害（打点を全部消して、同じ所に置き直してから編集する）\n');
console.log(`  ${pad('素材', 18)}${pad('期待', 9)}${HOLDS.map((h) => pad(h, 15)).join('')}`);
const totals = new Map(HOLDS.map((h) => [h, { exact: 0, total: 0 }]));
for (const s of OFF_DEFAULTS) {
  const cells = HOLDS.map((hold) => {
    const slot = slotFor(hold, s);
    // 人が打点を全部消して、**タイムラインの同じ所に**同じ値で置き直す。
    const stands = keyStandsAt(hold, slot).map((at, i) => ({ at, ...keysIn(slot.value)[i] }));
    let out = clearAll(hold, slot);
    for (const k of stands) out = putAt(hold, out, k.at, s.fallback, k.v, k.ease);
    const { exact, total, worst } = scoreSlot(hold, s, out);
    const acc = totals.get(hold);
    acc.exact += exact;
    acc.total += total;
    return pad(`${exact}/${total} ${worst <= EXACT ? '0' : worst.toFixed(3)}`, 15);
  });
  console.log(`  ${pad(s.name, 18)}${pad(s.intent, 9)}${cells.join('')}`);
}
console.log('');
console.log(
  `  ${pad('合計', 27)}${HOLDS.map((h) => {
    const a = totals.get(h);
    return pad(`${a.exact}/${a.total}`, 15);
  }).join('')}`,
);
console.log(
  '\n  置き直した直後は**どの持ち方でも 1 コマも違わない**（タイムラインの同じ所に置くので）。\n' +
    '  差が出るのは、そのあと編集したとき。**「置き直して動かしてみたら合っている」では気づけない。**\n',
);

// --- 3. 打点の立つ所 ------------------------------------------------------------
console.log('## 3. 軸が消えた瞬間、打点はタイムラインで何秒動くか\n');
console.log(`  ${pad('素材', 18)}${pad('選ぶ軸', 10)}${pad('消えると', 10)}打点のずれ（最大）`);
for (const s of OFF_DEFAULTS) {
  const slot = slotFor('stillValue', s);
  const to = otherClip(s);
  const fell = defaultTrackBase(s.kind);
  let worst = 0;
  for (const k of keysIn(slot.value)) {
    worst = Math.max(worst, Math.abs(timeAtKeyTime(s.want, to, k.t) - timeAtKeyTime(fell, to, k.t)));
  }
  console.log(
    `  ${pad(s.name, 18)}${pad(s.want, 10)}${pad(fell, 10)}${worst.toFixed(2)} 秒`,
  );
}
console.log(
  '\n  写し先のクリップ（頭 +3 秒・尺 1.5 倍）で測っている。**打点の列はそのまま残るので、\n' +
    '  値は正しいまま曲線だけが別の所に立つ**——「値が合っているか」を見る検査では出ない形。\n',
);

// --- 4. 費用 -------------------------------------------------------------------
console.log('## 4. 費用\n');
const kb = { base: 'fraction', keys: normalizeKeys([{ t: 0, v: 1, ease: 'easeInOut' }, { t: 1, v: 1.2 }]) };
console.log('  畳んだあとの JSON（既定でない軸を持つ値 1 本ぶん）\n');
const forms = [
  ['inKeys', 1.2, null],
  ['emptyKeys', { base: 'fraction', keys: [] }, null],
  ['stillValue', { base: 'fraction', v: 1.2 }, null],
  ['onClip', 1.2, { scale: 'fraction' }],
];
for (const [name, value, memo] of forms) {
  const total = bytesOf(value) + (memo ? bytesOf({ baseMemo: memo }) - bytesOf({}) : 0);
  console.log(
    `  ${pad(name, 12)}${pad(JSON.stringify(value), 30)}${memo ? `＋クリップに ${JSON.stringify({ baseMemo: memo })}` : ''}  ${total} バイト`,
  );
}
console.log(
  `  ${pad('（打点 2 個のまま）', 12)}${pad(JSON.stringify(kb), 30)}  ${bytesOf(kb)} バイト\n`,
);
console.log(
  '  **既定の軸なら素の数へ畳む**ので、この形が出るのは人が軸を外した値だけ。\n' +
    '  ふつうのクリップ（打点なし・既定の軸）の JSON は 1 文字も増えない。\n',
);

console.log('  読み出し（交互に 7 巡・中央値）\n');
const clip = { kind: 'image', start: 0, duration: 5, sourceIn: 0, speed: 1 };
const CALLS = 200_000;
function runInterleaved(cases, rounds = 7) {
  const times = new Map(cases.map((c) => [c.name, []]));
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
const sampler = (value) => (n) => {
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += sampleClipValue(clip, value, (i % 150) / 30, 1);
  return acc;
};
const read = runInterleaved([
  { name: '素の数', run: sampler(1.2) },
  { name: '畳んだ形 { base, v }', run: sampler({ base: 'fraction', v: 1.2 }) },
  { name: '打点 2 個', run: sampler(kb) },
]);
const plain = read[0].ns;
for (const r of read) {
  console.log(`  ${pad(r.name, 22)}${r.ns.toFixed(1)} ns  （素の数の ${(r.ns / plain).toFixed(1)} 倍）`);
}
console.log(
  '\n  畳んだ形は**打点を探さない**ので、打点ありより速く素の数より遅い所に入る。\n' +
    '  書き出し 1 本ぶん（21,600 回）に直すと素の数との差は 1ms に届かない（`npm run lab:keyframe` の 2 段目）。\n',
);

// --- 5. 本体に入る傷 -----------------------------------------------------------
console.log('## 5. 本体に入る傷（数えたもの。測ってはいない）\n');
const SITES = {
  inKeys: ['（増えない。ただし既定でない軸を人が選ぶ口が作れない）'],
  emptyKeys: ['読む所（空の列を fallback にしない）'],
  stillValue: [
    '型（`AnimatedTrack` に 1 つ形が増える）',
    '読む所（`sampleClipValue`）',
    '畳む所（`removeKeyAt` → `collapseTrack`）',
    '置く所（`putKeyAtTime`）',
    '軸を選ぶ口（`setTrackBase`）',
  ],
  onClip: [
    '型（`Clip` に値の名前ごとの表を足す）',
    '軸を読む所（値ではなくクリップを見る）',
    '**値を持ち出す口すべて**（コピー / プリセット / テンプレート。書き忘れると黙って軸が落ちる）',
  ],
};
for (const hold of HOLDS) {
  console.log(`  ${pad(hold, 12)}${SITES[hold].length} 箇所  :: ${SITES[hold].join(' / ')}`);
}
console.log(
  '\n  **編集の操作（`src/model/ops.ts`）は 4 通りとも 0 箇所。** クリップを丸ごと写すので、\n' +
    '  値でもクリップでも、そこに書いてあるものは黙って付いてくる。\n',
);

// --- まとめ --------------------------------------------------------------------
console.log('## まとめ\n');
for (const hold of HOLDS) {
  const lost = CARRIES.filter((c) => {
    const r = survived.get(`${c.name}|${hold}`);
    return !r.baseOk || !r.valueOk;
  }).map((c) => c.name);
  const acc = totals.get(hold);
  console.log(
    `  ${pad(hold, 12)}${pad(HOLD_NOTE[hold], 34)}落ちる操作 ${lost.length}（${
      lost.length ? lost.join('・') : 'なし'
    }）／消して置き直したあと ${acc.exact}/${acc.total}`,
  );
}
