/**
 * **打点の時刻を、何の秒として持つか。** 4 つの時間軸 × 2 つの付け替え方針を編集に当てて測る。
 *
 *   npm run lab:keyframe:probe
 *
 * ## なぜ測るところから始めるのか
 *
 * キーフレームは「曲線を引く所」が本題のように見えるが、曲線の引き方は
 * どの持ち方でも同じ（`value.ts` は時間軸を知らない）。**編集したときに初めて差が出る。**
 * 掴んで動かす・頭を詰める・割る・速さを変える——このどれかで打点が中身から剥がれると、
 * 使う人には「たまに動かない」「なぜか位置がずれる」として出る。
 * つまみを回して直せる類ではないので、**持ち方を決める前に当てておく。**
 *
 * ## 測るもの
 *
 *   1. **編集前は 4 通りとも同じ**（同じ見た目から作っているので、ここが違ったら測定の穴）
 *   2. **時間軸 × 操作**（付け替えあり）——期待とのずれの最大
 *   3. **付け替えをしない場合**——時間軸そのものが、どの期待に付いていくか
 *   4. **素材ごと**——どこで落ちるか
 *   5. **本体に入る傷**——打点の付け替えが要る操作の数
 *   6. **往復**——頭を詰めて戻したら元に戻るか（打点を刈る形と比べる）
 *
 * **2 だけを見ないこと。** 付け替えを全部書けばどの時間軸でもずれは 0 に近づく。
 * 3 と 5 が「その付け替えが本当に要るのか / 書き損じたらどうなるか」を見る段で、
 * ここがこの測定の本体。
 */

const { SCENARIOS, clipInBase, intendedValue, scoreClip, worstError, EXACT } = await import('./src/scenarios.ts');
const { applyOp, editOps, keyTimeAt, rebaseSites, TIME_BASES } = await import('./src/timebase.ts');
const { sampleAnimated } = await import('./src/value.ts');

const FPS = 30;
const INTENTS = ['content', 'head', 'stretch'];
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 4) => (v <= EXACT ? '0' : v.toFixed(n));

const opsFor = (s) =>
  editOps({
    moveBy: s.edits.moveBy,
    trimHead: s.edits.trimHead,
    trimTail: s.edits.trimTail,
    splitAt: () => s.edits.splitAt,
    speedTo: s.edits.speedTo,
    rippleBy: s.edits.rippleBy,
  });

/**
 * 1 つの（素材・時間軸・方針・操作）での最悪のずれ。
 *
 * **式は `scenarios.ts` に置いてある**（画面も同じものを呼ぶ）。ここは引数の順を
 * この表の読み順（素材 → 時間軸 → 方針 → 操作）に合わせているだけ。
 */
const worstErrorFor = (s, base, policy, op) => worstError(s, base, op, policy, FPS);

// --- 1. 編集前は 4 通りとも同じか ------------------------------------------------
console.log('## 1. 編集前（同じ見た目から作った打点が、4 通りとも同じ値を返すか）\n');
let sanityWorst = 0;
for (const s of SCENARIOS) {
  const row = TIME_BASES.map((base) => {
    const clip = clipInBase(s, base);
    let worst = 0;
    const frames = Math.round(clip.duration * FPS);
    for (let i = 0; i <= frames; i += 1) {
      const t = clip.start + Math.min(clip.duration, i / FPS);
      const got = sampleAnimated(clip.value, keyTimeAt(base, clip, t), s.fallback);
      worst = Math.max(worst, Math.abs(got - intendedValue(s, clip, t)));
    }
    sanityWorst = Math.max(sanityWorst, worst);
    return `${base} ${num(worst, 6)}`;
  });
  console.log(`  ${pad(s.name, 16)} ${row.join(' / ')}`);
}
console.log(`\n  最悪 ${num(sanityWorst, 6)}（0 でなければ以降の表は読めない）\n`);

// --- 2 と 3. 時間軸 × 操作（方針ごと） -------------------------------------------
const OPS = opsFor(SCENARIOS[0]).map((o) => o.name);
const titles = {
  follow: '## 2. 付け替えあり（どの時間軸でも「絵に付く」ようにした場合）',
  raw: '## 3. 付け替えなし（時間軸そのものが、何に付いていくか）',
};
for (const policy of ['follow', 'raw']) {
  console.log(`${titles[policy]}\n`);
  console.log(`  ${pad('', 10)}${OPS.map((o) => pad(o, 14)).join('')}`);
  for (const base of TIME_BASES) {
    const cells = OPS.map((name) => {
      let max = 0;
      let exact = 0;
      for (const s of SCENARIOS) {
        const op = opsFor(s).find((o) => o.name === name);
        const err = worstErrorFor(s, base, policy, op);
        if (err <= EXACT) exact += 1;
        max = Math.max(max, err);
      }
      return pad(`${num(max)} ${exact}/${SCENARIOS.length}`, 14);
    });
    console.log(`  ${pad(base, 10)}${cells.join('')}`);
  }
  // 期待の形ごとの内訳
  console.log('');
  for (const intent of INTENTS) {
    const targets = SCENARIOS.filter((s) => s.intent === intent);
    const cells = TIME_BASES.map((base) => {
      let exact = 0;
      let total = 0;
      for (const s of targets) {
        for (const op of opsFor(s)) {
          if (worstErrorFor(s, base, policy, op) <= EXACT) exact += 1;
          total += 1;
        }
      }
      return pad(`${base} ${exact}/${total}`, 18);
    });
    console.log(`  ${pad(intent, 10)}${cells.join('')}`);
  }
  console.log('');
}

// --- 4. 素材ごと ---------------------------------------------------------------
console.log('## 4. 素材ごと（付け替えなし。その時間軸が素で何に付くか）\n');
for (const s of SCENARIOS) {
  console.log(`  ${s.name}（期待: ${s.intent}）— ${s.note}`);
  const ops = opsFor(s);
  console.log(`    ${pad('', 10)}${ops.map((o) => pad(o.name, 12)).join('')}`);
  for (const base of TIME_BASES) {
    const cells = ops.map((op) => pad(num(worstErrorFor(s, base, 'raw', op), 3), 12));
    console.log(`    ${pad(base, 10)}${cells.join('')}`);
  }
  console.log('');
}

// --- 5. 本体に入る傷 -----------------------------------------------------------
console.log('## 5. 打点の付け替えが要る操作（＝本体の操作に手を入れる箇所）\n');
for (const base of TIME_BASES) {
  const sites = rebaseSites(base, opsFor(SCENARIOS[0]), 'follow');
  console.log(`  ${pad(base, 10)} ${sites.length} 箇所${sites.length ? `  :: ${sites.join(', ')}` : ''}`);
}
console.log(
  '\n  本体は `structuredClone` でクリップを丸ごと写すので、0 箇所なら操作に 1 行も足さずに打点が付いてくる。',
);

// --- 6. 往復 -------------------------------------------------------------------
console.log('\n## 6. 往復（頭を 1 回詰めて、同じだけ戻す。付け替えありの場合）\n');
console.log(`  ${pad('', 10)}${pad('打点を残す', 16)}見えない打点を刈る`);
for (const base of TIME_BASES) {
  let worstKeep = 0;
  let worstPrune = 0;
  for (const s of SCENARIOS) {
    const trim = opsFor(s).find((o) => o.name === 'trimLeft');
    const back = editOps({
      moveBy: 0,
      trimHead: -s.edits.trimHead,
      trimTail: 0,
      splitAt: () => 0,
      speedTo: s.speed,
      rippleBy: 0,
    }).find((o) => o.name === 'trimLeft');
    for (const prune of [false, true]) {
      let mid = applyOp(trim, base, clipInBase(s, base), 'follow')[0];
      if (prune) {
        const head = keyTimeAt(base, mid, mid.start);
        const keys = (mid.value.keys ?? []).filter((k) => k.t >= head - EXACT);
        mid = { ...mid, value: { keys } };
      }
      const after = applyOp(back, base, mid, 'follow')[0];
      const worst = scoreClip(s, base, after, FPS).max;
      if (prune) worstPrune = Math.max(worstPrune, worst);
      else worstKeep = Math.max(worstKeep, worst);
    }
  }
  console.log(`  ${pad(base, 10)}${pad(num(worstKeep), 16)}${num(worstPrune)}`);
}

// --- まとめ --------------------------------------------------------------------
console.log('\n## まとめ（付け替えなしで、期待どおりになった割合）\n');
for (const intent of INTENTS) {
  const targets = SCENARIOS.filter((s) => s.intent === intent);
  const best = TIME_BASES.map((base) => {
    let exact = 0;
    let total = 0;
    let max = 0;
    for (const s of targets) {
      for (const op of opsFor(s)) {
        const err = worstErrorFor(s, base, 'raw', op);
        if (err <= EXACT) exact += 1;
        max = Math.max(max, err);
        total += 1;
      }
    }
    return { base, exact, total, max };
  });
  const win = best.filter((b) => b.exact === b.total).map((b) => b.base);
  console.log(
    `  ${pad(intent, 10)}${best.map((b) => pad(`${b.base} ${b.exact}/${b.total}`, 18)).join('')}`,
  );
  console.log(`  ${pad('', 10)}→ 素で取れるのは: ${win.length ? win.join(', ') : 'なし'}\n`);
}
