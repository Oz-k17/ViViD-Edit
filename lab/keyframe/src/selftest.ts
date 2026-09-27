/**
 * 打点の持ち方の検算。合成した値だけを見るので、ブラウザも素材も要らない。
 *
 *   npm run lab:test   （ほかの試作のぶんと続けて走る）
 *
 * 見るのは 3 段:
 *
 *   1. **並べ方と取り出し方**（`value.ts`）——境界、空の列、同時刻、二分探索
 *   2. **持っていく形**（`track.ts`）——既定の時間軸、打点を置く / 消す、保存に載るか
 *   3. **編集を通した不変条件**（`scenarios.ts` の素材と正解を使う）——
 *      「絵に付く」は `source`、「頭に付く」は `local`、「尺に伸びる」は `fraction` で、
 *      **付け替えを 1 行も書かずに**保たれること
 *
 * 3 段目は `probe.mjs` と同じ素材・同じ正解を使う。**別の物差しを書かないのは、
 * 食い違ったときに「判定が変わったのか物差しが変わったのか」を読めなくしないため**
 * （`reframe/score.mjs` と同じ立場）。
 */

import {
  easeAt,
  findSegment,
  keyRange,
  keysOf,
  normalizeKeys,
  putKey,
  sampleAnimated,
  scaleKeys,
  shiftKeys,
  type Animated,
  type Keyframe,
} from './value.ts';
import {
  defaultTrackBase,
  isStillTrack,
  kenBurns,
  keyTimeIn,
  keyTimeInUnclamped,
  keysOfTrack,
  putKeyAtTime,
  removeKeyAt,
  sampleClipValue,
  setTrackBase,
  sourceTimeAt,
  timeAtKeyTime,
  trackBaseOf,
  type AnimatedTrack,
  type ClipTiming,
  type TrackBase,
} from './track.ts';
import { composeAt } from './compose.ts';
import { applyOp, editOps, TIME_BASES, type LabClip, type TimeBase } from './timebase.ts';
import { clipInBase, scoreClip, SCENARIOS, EXACT } from './scenarios.ts';
import { clearAll, keysIn, OFF_DEFAULTS, readAt, slotFor } from './hold.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: TestResult[] = [];
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
}

const clip = (over: Partial<ClipTiming> = {}): ClipTiming => ({
  kind: 'video',
  start: 2,
  duration: 4,
  sourceIn: 10,
  speed: 1,
  ...over,
});

export function runSelfTest(): TestResult[] {
  results.length = 0;

  // --- 1. 並べ方と取り出し方 ---------------------------------------------------
  check('素の数はそのまま返る（打点を持たないクリップの道）', sampleAnimated(0.8, 123) === 0.8, '0.8');

  const one: Animated = { keys: [{ t: 5, v: 0.4 }] };
  check(
    '打点が 1 つなら、どの時刻でもその値',
    sampleAnimated(one, -100) === 0.4 && sampleAnimated(one, 1e6) === 0.4,
  );

  check(
    '打点が空なら、呼ぶ側の既定（0 を決め打ちにしない）',
    sampleAnimated({ keys: [] }, 3, 1) === 1 && sampleAnimated({ keys: [] }, 3, 0.25) === 0.25,
    '不透明度で 0 を決め打ちにすると、打点を消した瞬間に絵が消える',
  );

  const ramp: Animated = { keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }] };
  check('線形の真ん中は 0.5', near(sampleAnimated(ramp, 1), 0.5), sampleAnimated(ramp, 1).toFixed(6));
  check(
    '端の外は保つ（伸ばさない・折り返さない）',
    sampleAnimated(ramp, -5) === 0 && sampleAnimated(ramp, 5) === 1,
  );

  const held: Animated = { keys: [{ t: 0, v: 0.2, ease: 'hold' }, { t: 1, v: 0.9 }] };
  check(
    'hold は次の打点の直前まで前の値、打点そのものでは次の値',
    sampleAnimated(held, 0.999) === 0.2 && sampleAnimated(held, 1) === 0.9,
  );

  check(
    'easeOut は本体のテロップと同じ形（1-(1-u)^3）',
    near(easeAt('easeOut', 0.5), 0.875) && near(easeAt('easeOut', 0), 0) && near(easeAt('easeOut', 1), 1),
    `u=0.5 で ${easeAt('easeOut', 0.5)}`,
  );
  check(
    'easeInOut は真ん中で 0.5・両端で 0/1（段が出ない）',
    near(easeAt('easeInOut', 0.5), 0.5) &&
      near(easeAt('easeInOut', 0), 0) &&
      near(easeAt('easeInOut', 1), 1),
  );

  // 単調な打点列なら、どの繋ぎ方でも値は単調（行き過ぎる繋ぎ方を入れていないことの確認）
  let monotone = true;
  for (const ease of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
    const v: Animated = { keys: [{ t: 0, v: 0, ease }, { t: 1, v: 1 }] };
    let prev = -Infinity;
    for (let i = 0; i <= 100; i += 1) {
      const got = sampleAnimated(v, i / 100);
      if (got < prev - 1e-12 || got < -1e-12 || got > 1 + 1e-12) monotone = false;
      prev = got;
    }
  }
  check('単調な打点列は、どの繋ぎ方でも行き過ぎない（0〜1 を出ない）', monotone);

  const messy: Keyframe[] = [
    { t: 2, v: 0.2 },
    { t: 0, v: 0 },
    { t: Number.NaN, v: 1 },
    { t: 1, v: 0.9 },
    { t: 2, v: 0.5 },
    { t: 3, v: Number.POSITIVE_INFINITY },
  ];
  const tidy = normalizeKeys(messy);
  check(
    '並べ替え・数でない打点を捨てる・同時刻は後勝ち',
    tidy.length === 3 && tidy[0].t === 0 && tidy[2].t === 2 && tidy[2].v === 0.5,
    tidy.map((k) => `${k.t}:${k.v}`).join(' '),
  );
  check(
    '整えるのは冪等（2 回通しても同じ）',
    JSON.stringify(normalizeKeys(tidy)) === JSON.stringify(tidy),
  );
  check(
    '同時刻の打点を置き直すと差し替わる（増えない）',
    keysOf(putKey({ keys: tidy }, { t: 2, v: 0.77 })).length === 3 &&
      sampleAnimated(putKey({ keys: tidy }, { t: 2, v: 0.77 }), 2) === 0.77,
  );

  // 二分探索が、素直な線形探索と全時刻で一致するか（種を固定した乱数で）
  let seed = 20260927;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const many = normalizeKeys(
    Array.from({ length: 64 }, () => ({ t: Math.round(rnd() * 2000) / 100, v: rnd() })),
  );
  let searchOk = true;
  for (let i = 0; i < 500; i += 1) {
    const t = rnd() * 25 - 2.5;
    let linear = -1;
    for (let k = 0; k < many.length; k += 1) if (many[k].t <= t) linear = k;
    if (findSegment(many, t) !== linear) searchOk = false;
  }
  check('二分探索は線形探索と全時刻で一致（打点 64・500 点）', searchOk);

  check(
    '時刻が NaN なら最初の打点、±無限なら両端（比べられない値を端の判定へ流さない）',
    sampleAnimated(ramp, Number.NaN) === 0 &&
      sampleAnimated(ramp, Number.POSITIVE_INFINITY) === 1 &&
      sampleAnimated(ramp, Number.NEGATIVE_INFINITY) === 0,
  );
  const dup: Animated = { keys: [{ t: 1, v: 0.1 }, { t: 1, v: 0.6 }, { t: 2, v: 1 }] };
  check(
    '同時刻の打点が畳まれずに残っていても、落ちず打点の値から外れない',
    [0.1, 0.6].includes(sampleAnimated(dup, 1)) &&
      Number.isFinite(sampleAnimated(dup, 1.5)) &&
      sampleAnimated({ keys: normalizeKeys(keysOf(dup)) }, 1) === 0.6,
    `畳む前 ${sampleAnimated(dup, 1)} / 畳んだ後 0.6`,
  );

  const range = keyRange(ramp);
  check('打点の範囲が読める', range !== null && range.from === 0 && range.to === 2);
  check('打点が無ければ範囲は null（素の数も同じ）', keyRange({ keys: [] }) === null && keyRange(1) === null);
  check(
    'ずらす / 伸縮するは往復で戻る',
    JSON.stringify(shiftKeys(shiftKeys(ramp, 3), -3)) === JSON.stringify(ramp) &&
      JSON.stringify(scaleKeys(scaleKeys(ramp, 4), 0.25)) === JSON.stringify(ramp),
  );
  check(
    '伸縮の倍率に 0 や負を渡したら黙って通さない（列を壊さない）',
    JSON.stringify(scaleKeys(ramp, 0)) === JSON.stringify(ramp) &&
      JSON.stringify(scaleKeys(ramp, -2)) === JSON.stringify(ramp),
  );

  // --- 2. 持っていく形 ---------------------------------------------------------
  check(
    '時間軸を省いたら source（保存済みのプロジェクトと同じ読み方）',
    trackBaseOf({ keys: [{ t: 0, v: 1 }] }) === 'source' && trackBaseOf(0.5) === 'source',
  );
  check(
    '既定の時間軸は種類で決まる（映像と音は素材の秒、静止画とテロップは頭からの秒）',
    defaultTrackBase('video') === 'source' &&
      defaultTrackBase('audio') === 'source' &&
      defaultTrackBase('text') === 'local' &&
      defaultTrackBase('image') === 'local',
  );

  const c = clip();
  check(
    '素材の秒は本体の sourceTimeAt と同じ（速さを掛ける・頭より前は 0 止め）',
    sourceTimeAt(clip({ speed: 2 }), 4) === 14 && sourceTimeAt(c, 0) === 10,
    `${sourceTimeAt(clip({ speed: 2 }), 4)}`,
  );
  check(
    '尺が 0 のクリップでも割合は落ちない',
    keyTimeIn('fraction', clip({ duration: 0 }), 5) === 0,
  );
  check(
    '速さ 0 は 1 として読む（本体の `speed || 1` と同じ）',
    sourceTimeAt(clip({ speed: 0 }), 4) === 12,
  );

  const placed = putKeyAtTime(c, 0.8, 4);
  check(
    '打点を置いた瞬間に絵が飛ばない（値を省いたら今の値が入る）',
    near(sampleClipValue(c, placed, 4, 1), 0.8),
    `置いた直後 ${sampleClipValue(c, placed, 4, 1)}`,
  );
  const twoKeys = putKeyAtTime(c, placed, 5, 0.2);
  check(
    '2 つ目を置くと、その間が繋がる',
    near(sampleClipValue(c, twoKeys, 4.5, 1), 0.5),
    `真ん中 ${sampleClipValue(c, twoKeys, 4.5, 1)}`,
  );
  check(
    'テロップに打点を置くと、頭からの秒で入る',
    trackBaseOf(putKeyAtTime(clip({ kind: 'text', sourceIn: 0 }), 1, 3)) === 'local',
  );
  {
    // テロップの既定は `local` なので、覚えるものが無い＝素の数へ畳む。
    const textC = clip({ kind: 'text', sourceIn: 0 });
    check(
      '既定の時間軸なら、打点を消して空になったら素の数へ戻す（毎コマ既定を通らせない）',
      removeKeyAt(textC, { base: 'local', keys: [{ t: 1, v: 0.3 }] }, 1, 1) === 0.3,
    );
    // 映像の既定は `source` なので、`local` は人が外した軸＝覚えておく。
    const kept = removeKeyAt(c, { base: 'local', keys: [{ t: 1, v: 0.3 }] }, 1, 1);
    check(
      '既定でない時間軸なら、畳んでも軸と値を両方残す（{ base, v }）',
      isStillTrack(kept) && trackBaseOf(kept) === 'local' && near(sampleClipValue(c, kept, 99, 1), 0.3),
      `${JSON.stringify(kept)}`,
    );
  }

  // テロップに `source` で打点が入っている値（既定と違う持ち方）へ 2 つ目を足す。
  const textClip = clip({ kind: 'text', sourceIn: 0 });
  const explicit = putKeyAtTime(textClip, { base: 'source', keys: [{ t: 1, v: 0.2 }] }, 5, 0.9);
  check(
    'すでに打点があるなら、2 つ目を足しても時間軸は変わらない（1 つ目が飛ばない）',
    trackBaseOf(explicit) === 'source' &&
      near(sampleClipValue(textClip, explicit, 3, 0), 0.2) &&
      near(sampleClipValue(textClip, explicit, 5, 0), 0.9),
    `時間軸 ${trackBaseOf(explicit)} / 頭から 1 秒で ${sampleClipValue(textClip, explicit, 3, 0)}`,
  );
  check(
    '知らない時間軸が保存から来ても NaN を返さない（source として読む）',
    Number.isFinite(
      sampleClipValue(c, { base: 'bogus' as unknown as 'source', keys: [{ t: 11, v: 0.3 }] }, 4, 1),
    ),
  );
  check(
    '数でない値を置こうとしても列が壊れない（黙って増えない）',
    keysOfTrack(putKeyAtTime(c, twoKeys, 5.5, Number.NaN)).length === keysOfTrack(twoKeys).length,
  );

  const kb = kenBurns();
  check(
    'ケンバーンズは尺を変えても寄り切る（割合で持っているため）',
    near(sampleClipValue(clip({ kind: 'image', duration: 4 }), kb, 6), 1.2) &&
      near(sampleClipValue(clip({ kind: 'image', duration: 9 }), kb, 11), 1.2),
  );

  const saved: AnimatedTrack = JSON.parse(JSON.stringify(twoKeys)) as AnimatedTrack;
  check(
    'JSON を通しても同じ値（保存・履歴・テンプレートに載る形）',
    near(sampleClipValue(c, saved, 4.5, 1), sampleClipValue(c, twoKeys, 4.5, 1)),
  );
  check(
    '打点を持たない値は JSON で 1 文字も増えない',
    JSON.stringify({ opacity: 0.8 }) === JSON.stringify({ opacity: 0.8 as AnimatedTrack }),
  );

  // --- 2.5 本体の操作を写せているか -------------------------------------------
  // ここが食い違うと、測定はぜんぶ「別の編集ソフト」の話になる。
  // 写し元は `src/model/ops.ts` の `splitOne()` / `trimClip()`。
  const opsOf = (over: Partial<Parameters<typeof editOps>[0]> = {}) =>
    editOps({ moveBy: 0, trimHead: 0, trimTail: 0, splitAt: () => 0, speedTo: 1, rippleBy: 0, ...over });
  const labClip = (over: Partial<LabClip> = {}): LabClip => ({
    id: 'c', kind: 'video', start: 2, duration: 4, sourceIn: 10, speed: 1, value: 1, ...over,
  });

  const [, right] = opsOf({ splitAt: () => 4 })
    .find((o) => o.name === 'split')!
    .apply(labClip({ speed: 2 }));
  check(
    '割ると右側の素材のイン点は sourceIn + 経過 × 速さ（本体と同じ式）',
    right.start === 4 && right.sourceIn === 14 && right.duration === 2,
    `start ${right.start} / sourceIn ${right.sourceIn}`,
  );

  const [tooFar] = opsOf({ trimHead: 99 })
    .find((o) => o.name === 'trimLeft')!
    .apply(labClip());
  check(
    '頭を詰めすぎても尺 0.1 秒で止まる（本体の最小と同じ）',
    near(tooFar.duration, 0.1),
    `尺 ${tooFar.duration}`,
  );
  const [beforeHead] = opsOf({ trimHead: -99 })
    .find((o) => o.name === 'trimLeft')!
    .apply(labClip({ sourceIn: 1 }));
  check(
    '素材の頭より前へは詰め戻せない（映像・音だけ）',
    near(beforeHead.sourceIn, 0) && near(beforeHead.start, 1),
    `sourceIn ${beforeHead.sourceIn} / start ${beforeHead.start}`,
  );
  const [textHead] = opsOf({ trimHead: 1 })
    .find((o) => o.name === 'trimLeft')!
    .apply(labClip({ kind: 'text', sourceIn: 0 }));
  check(
    'テロップと静止画は頭を詰めても素材のイン点が動かない（本体がそう分けている）',
    textHead.sourceIn === 0 && textHead.start === 3,
  );

  // --- 3. 編集を通した不変条件 -------------------------------------------------
  const wants: Record<string, TimeBase> = { content: 'source', head: 'local', stretch: 'fraction' };
  for (const intent of ['content', 'head', 'stretch'] as const) {
    const base = wants[intent];
    const targets = SCENARIOS.filter((s) => s.intent === intent);
    let worst = 0;
    let worstAt = '';
    for (const s of targets) {
      const ops = editOps({
        moveBy: s.edits.moveBy,
        trimHead: s.edits.trimHead,
        trimTail: s.edits.trimTail,
        splitAt: () => s.edits.splitAt,
        speedTo: s.edits.speedTo,
        rippleBy: s.edits.rippleBy,
      });
      for (const op of ops) {
        // 付け替えは一切しない（本体の操作に手を入れない、という設計そのものの検算）
        for (const after of applyOp(op, base, clipInBase(s, base), 'raw')) {
          if (after.duration <= 0) continue;
          const err = scoreClip(s, base, after).max;
          if (err > worst) {
            worst = err;
            worstAt = `${s.name}/${op.name}`;
          }
        }
      }
    }
    check(
      `「${intent}」は ${base} で、付け替え無しでも編集 6 通りを通る`,
      worst <= EXACT,
      worst <= EXACT ? `${targets.length} 本 × 6 操作` : `最悪 ${worst.toFixed(4)} @ ${worstAt}`,
    );
  }

  // 見えない打点を刈ると往復で戻らない（「刈らない」という決まりの根拠を検算に残す）
  const pruneVictim = SCENARIOS.find((s) => s.name === 'video-fade-in');
  if (pruneVictim) {
    const s = pruneVictim;
    const mk = (head: number) =>
      editOps({
        moveBy: 0,
        trimHead: head,
        trimTail: 0,
        splitAt: () => 0,
        speedTo: s.speed,
        rippleBy: 0,
      }).find((o) => o.name === 'trimLeft')!;
    const before = clipInBase(s, 'source');
    const mid = applyOp(mk(s.edits.trimHead), 'source', before, 'raw')[0];
    const pruned: LabClip = {
      ...mid,
      value: { keys: keysOf(mid.value).filter((k) => k.t >= mid.sourceIn - EXACT) },
    };
    const backKept = applyOp(mk(-s.edits.trimHead), 'source', mid, 'raw')[0];
    const backPruned = applyOp(mk(-s.edits.trimHead), 'source', pruned, 'raw')[0];
    const errKept = scoreClip(s, 'source', backKept).max;
    const errPruned = scoreClip(s, 'source', backPruned).max;
    check(
      '頭を詰めて戻すと元に戻る（打点を残す限り）',
      errKept <= EXACT,
      `ずれ ${errKept.toFixed(6)}`,
    );
    check(
      '見えない打点を刈ると戻らない（刈らない決まりの根拠）',
      errPruned > 0.1,
      `刈ると ${errPruned.toFixed(4)} ずれる`,
    );
  }

  // 素材を入れ替えても「編集前は 4 通りとも同じ」が成り立つか（測定の土台）
  let sameBefore = 0;
  for (const s of SCENARIOS) {
    for (const base of TIME_BASES) {
      sameBefore = Math.max(sameBefore, scoreClip(s, base, clipInBase(s, base)).max);
    }
  }
  check(
    '編集前は 4 通りとも同じ値（比べているのが持ち方の差であること）',
    sameBefore <= EXACT,
    `最悪 ${sameBefore.toExponential(1)}`,
  );


  // ---------------------------------------------------------------------------
  // 4 段目: **画面のために要った所**（2026-09-27 の 2 回目に足した）
  //
  // 読むだけなら片道（タイムラインの秒 → 打点の秒）で足りるので、ここは
  // 「つまむ側」で初めて要る。**画面にしか関係が無い計算も、判定と同じ所に置いて検算する**
  // ——画面の中に書くと `npm run lab:test` の外へ落ち、壊れても気づけない。
  // ---------------------------------------------------------------------------

  // 逆向きの写しは、クリップの外でも往復する（つまんだ先が飛ばないことの根拠）
  {
    const cases: { base: TrackBase; clip: ClipTiming }[] = [
      { base: 'source', clip: clip({ start: 2, duration: 6, sourceIn: 3, speed: 1 }) },
      { base: 'source', clip: clip({ start: 1, duration: 5, sourceIn: 4, speed: 2 }) },
      { base: 'local', clip: clip({ kind: 'text', start: 3, duration: 4, sourceIn: 0, speed: 1 }) },
      { base: 'fraction', clip: clip({ kind: 'image', start: 0, duration: 5, sourceIn: 0, speed: 1 }) },
    ];
    let worst = 0;
    let worstAt = '';
    for (const c of cases) {
      // クリップの外（頭より 2 秒前・尻より 2 秒後ろ）まで含めて往復させる
      for (let time = c.clip.start - 2; time <= c.clip.start + c.clip.duration + 2; time += 0.25) {
        const t = keyTimeInUnclamped(c.base, c.clip, time);
        const back = timeAtKeyTime(c.base, c.clip, t);
        if (Math.abs(back - time) > worst) {
          worst = Math.abs(back - time);
          worstAt = `${c.base}/${time.toFixed(2)}s`;
        }
      }
    }
    check(
      '打点の秒 ↔ タイムラインの秒が、クリップの外でも往復する',
      worst <= 1e-9,
      worst <= 1e-9 ? `4 通り × 頭の前後 2 秒まで` : `最悪 ${worst.toExponential(1)} @ ${worstAt}`,
    );
  }

  // 丸めた写し（本体の `sourceTimeAt`）では、頭より前をつまめない
  {
    const c = clip({ start: 2, duration: 5, sourceIn: 3, speed: 1 });
    const before = c.start - 1;
    const clamped = keyTimeIn('source', c, before);
    const raw = keyTimeInUnclamped('source', c, before);
    check(
      '丸めた写しでは、クリップの頭より前に打点を置けない（つまむ側が丸めない理由）',
      Math.abs(clamped - c.sourceIn) <= 1e-9 && Math.abs(raw - (c.sourceIn - 1)) <= 1e-9,
      `1 秒前を指すと 丸め ${clamped.toFixed(2)}s（頭に張り付く） / 丸めない ${raw.toFixed(2)}s`,
    );
  }

  // 打点を全部消しても時間軸が残るか（2026-09-27 の 3 回目に持ち方を足した所）
  {
    const kb = kenBurns(1, 1.2);
    const image: ClipTiming = { kind: 'image', start: 0, duration: 5, sourceIn: 0, speed: 1 };
    const emptied = removeKeyAt(image, removeKeyAt(image, kb, 0, 1), 1, 1);
    const wentBack = putKeyAtTime(image, emptied, 2.5);
    check(
      '打点を全部消しても時間軸が残る（畳んだ形が軸を持つ）',
      isStillTrack(emptied) && trackBaseOf(emptied) === 'fraction' && trackBaseOf(wentBack) === 'fraction',
      `${JSON.stringify(emptied)} / 置き直すと ${trackBaseOf(wentBack)}`,
    );
    check(
      '畳んでも値が既定へ跳ねない（空の列を残す形との違い）',
      near(sampleClipValue(image, emptied, 3, 0.5), 1.2) &&
        near(sampleClipValue(image, { base: 'fraction', keys: [] }, 3, 0.5), 0.5),
      `畳んだ形 ${sampleClipValue(image, emptied, 3, 0.5)} / 空の列 ${sampleClipValue(image, { base: 'fraction', keys: [] }, 3, 0.5)}`,
    );
    check(
      '軸を渡さなくても元の軸で置き直せる（画面が覚えておく必要が無くなった）',
      trackBaseOf(putKeyAtTime(image, emptied, 2.5)) === 'fraction',
    );
    // 既定の軸（静止画なら local）は覚えない。覚えると JSON が打点を消すたびに太る。
    const plainBase = removeKeyAt(image, { base: 'local', keys: [{ t: 1, v: 0.7 }] }, 1, 1);
    check(
      '既定と同じ軸は覚えない（素の数へ畳む）',
      typeof plainBase === 'number' && plainBase === 0.7,
      `${JSON.stringify(plainBase)}`,
    );
    // 打点を置く前に軸だけ決める口（`inKeys` では書く場所が無かった所）。
    const seated = setTrackBase(image, 0.9, 'fraction');
    check(
      '打点が 0 個でも時間軸だけ先に選べる（setTrackBase）',
      isStillTrack(seated) &&
        trackBaseOf(seated) === 'fraction' &&
        near(sampleClipValue(image, seated, 2, 0), 0.9) &&
        trackBaseOf(putKeyAtTime(image, seated, 2.5)) === 'fraction',
      `${JSON.stringify(seated)}`,
    );
    check(
      '既定へ戻すと素の数へ畳む（覚えるものが無い）',
      setTrackBase(image, seated, 'local') === 0.9,
    );
    // 軸を替えると、見た目が変わらないように打点の時刻を写し替える（画面にあった式を寄せた）
    {
      let worst = 0;
      const withKeys = kenBurns(1, 1.2);
      for (const to of ['source', 'local', 'fraction'] as TrackBase[]) {
        const moved = setTrackBase(image, withKeys, to);
        for (let i = 0; i <= 50; i += 1) {
          const time = image.start + (i / 50) * image.duration;
          worst = Math.max(
            worst,
            Math.abs(sampleClipValue(image, withKeys, time, 1) - sampleClipValue(image, moved, time, 1)),
          );
        }
      }
      check(
        '時間軸を替えても、編集していなければ 1 コマも変わらない（setTrackBase の写し替え）',
        worst <= 1e-9,
        `最悪 ${worst.toExponential(1)}`,
      );
    }
    // **読む軸と畳む軸が食い違わないこと。** `base` を省いた列は `sampleClipValue()` が
    // `source` と読むので、畳むときも `source` として覚えなければ、保存を通した値だけが壊れる。
    {
      const baseless: AnimatedTrack = { keys: [{ t: 0.5, v: 0.3 }] };
      const clips: ClipTiming[] = [
        { kind: 'text', start: 1, duration: 4, sourceIn: 0, speed: 1 },
        { kind: 'image', start: 1, duration: 4, sourceIn: 0, speed: 1 },
        { kind: 'video', start: 1, duration: 4, sourceIn: 2, speed: 1 },
      ];
      const ok2 = clips.every((cc) => {
        const folded = removeKeyAt(cc, baseless, 0.5, 1);
        // 畳んで、また打点を置いたときに、読み方が変わっていないこと。
        const again = putKeyAtTime(cc, folded, cc.start + 1, 0.4);
        return trackBaseOf(again) === 'source';
      });
      check(
        '時間軸を省いた列は、畳んでも source のまま（読む所と畳む所を食い違わせない）',
        ok2,
        clips.map((cc) => `${cc.kind} ${JSON.stringify(removeKeyAt(cc, baseless, 0.5, 1))}`).join(' / '),
      );
    }

    // 壊れた形が保存から来たときに落ちないか（`base` も `v` も外から来る値）
    {
      const broken: AnimatedTrack[] = [
        { base: 'fraction', v: Number.NaN },
        { base: 'fraction', v: undefined as unknown as number },
        { base: 'fraction', keys: [] },
        { base: 'bogus' as unknown as TrackBase, v: 0.3 },
      ];
      const reads = broken.map((v) => sampleClipValue(image, v, 2, 0.6));
      check(
        '壊れた畳んだ形が保存から来ても、数を返す（絵を消さない）',
        reads.every((r) => Number.isFinite(r)) &&
          near(reads[0], 0.6) &&
          near(reads[1], 0.6) &&
          near(reads[2], 0.6) &&
          near(reads[3], 0.3),
        reads.map((r) => r.toFixed(2)).join(' / '),
      );
      check(
        '値の無い畳んだ形に打点を置いても、列は壊れない',
        keysOfTrack(putKeyAtTime(image, { base: 'fraction', v: Number.NaN }, 2, 0.5)).length === 1,
      );
    }

    // 保存・複製・値だけのコピーで軸が付いてくるか（`hold-probe.mjs` の 1 段目の要点）
    {
      const roundTrip = JSON.parse(JSON.stringify(emptied)) as AnimatedTrack;
      const other: ClipTiming = { kind: 'image', start: 3, duration: 7.5, sourceIn: 0, speed: 1 };
      check(
        '畳んだ形は保存を通り、値だけ別のクリップへ写しても軸が付いてくる',
        trackBaseOf(roundTrip) === 'fraction' &&
          trackBaseOf(putKeyAtTime(other, roundTrip, 5)) === 'fraction',
      );
    }
    // 消えるとどれだけずれるか。尺 5 秒の静止画で、割合 1.0 の打点は尻（5.00s）に立つが、
    // 秒として読まれると 1.00s に立つ。
    const drift =
      timeAtKeyTime('fraction', image, 1) - timeAtKeyTime('local', image, 1);
    check(
      '時間軸が既定へ戻ると、同じ打点の立つ所が動く（消えたときの被害）',
      Math.abs(drift - 4) <= 1e-9,
      `割合 1.0 の打点が 5.00s → 1.00s（${drift.toFixed(2)} 秒ずれる）`,
    );
  }

  // 絵にする式（本体の写し）。値が合っていても、差す場所が違えば絵だけが変わる
  {
    const c = { kind: 'video' as const, start: 0, duration: 4, sourceIn: 0, speed: 1, fadeIn: 0, fadeOut: 0 };
    const canvas = { width: 270, height: 480 };
    const media = { width: 1280, height: 720 };
    const plain = composeAt(c, { scale: 1, x: 0, y: 0, opacity: 1 }, 1, canvas, media);
    // cover なので、9:16 の画角に 16:9 を入れると**縦がちょうど埋まり、横がはみ出す**
    check(
      '拡大 1 倍・位置 0 では、画角の真ん中に cover で収まる（本体の fitRect と同じ）',
      near(plain.rect.h, canvas.height) &&
        plain.rect.w > canvas.width &&
        near(plain.rect.x + plain.rect.w / 2, canvas.width / 2) &&
        near(plain.rect.y + plain.rect.h / 2, canvas.height / 2),
      `${plain.rect.w.toFixed(1)}×${plain.rect.h.toFixed(1)} @ ${plain.rect.x.toFixed(1)},${plain.rect.y.toFixed(1)}`,
    );
    const zoomed = composeAt(c, { scale: 2, x: 0, y: 0, opacity: 1 }, 1, canvas, media);
    check(
      '拡大は真ん中から効く（幅が 2 倍・中心は動かない）',
      Math.abs(zoomed.rect.w - plain.rect.w * 2) < 1e-9 &&
        Math.abs(zoomed.rect.x + zoomed.rect.w / 2 - canvas.width / 2) < 1e-9,
      `幅 ${plain.rect.w.toFixed(1)} → ${zoomed.rect.w.toFixed(1)}`,
    );
    const moved = composeAt(c, { scale: 1, x: 0.25, y: -0.5, opacity: 1 }, 1, canvas, media);
    check(
      '位置は画角に対する割合（本体と同じ単位）',
      Math.abs(moved.rect.x - (plain.rect.x + 0.25 * canvas.width)) < 1e-9 &&
        Math.abs(moved.rect.y - (plain.rect.y - 0.5 * canvas.height)) < 1e-9,
      `x +0.25 で ${(moved.rect.x - plain.rect.x).toFixed(1)}px / y -0.5 で ${(moved.rect.y - plain.rect.y).toFixed(1)}px`,
    );
  }

  // 打点とフェードは掛け算で重なる（どちらを打点で置き換えるかを決める前の確かめ）
  {
    const c = { kind: 'video' as const, start: 0, duration: 4, sourceIn: 0, speed: 1, fadeIn: 1, fadeOut: 0 };
    const half: AnimatedTrack = { base: 'local', keys: [{ t: 0, v: 0.5 }] };
    const withFade = composeAt(c, { scale: 1, x: 0, y: 0, opacity: half }, 0.5, { width: 270, height: 480 }, { width: 1280, height: 720 });
    const without = composeAt(c, { scale: 1, x: 0, y: 0, opacity: half }, 0.5, { width: 270, height: 480 }, { width: 1280, height: 720 }, false);
    check(
      '打点 × フェードは掛け算（0.5 × 0.5 = 0.25）',
      near(withFade.alpha, 0.25) && near(without.alpha, 0.5) && near(withFade.fade, 0.5),
      `掛ける ${withFade.alpha.toFixed(3)} / 掛けない ${without.alpha.toFixed(3)}`,
    );
  }

  // 画面が時間軸を替えるときの写し替え（見た目を保つ）
  {
    let worst = 0;
    for (const s of SCENARIOS) {
      const from = clipInBase(s, 'source');
      for (const to of ['source', 'local', 'fraction'] as TrackBase[]) {
        // 打点をタイムラインの秒へ戻し、別の時間軸へ入れ直す（画面の `kf-base` がやっていること）
        const timeline = keysOf(from.value).map((k) => ({ ...k, at: timeAtKeyTime('source', from, k.t) }));
        const moved: LabClip = {
          ...from,
          value: {
            keys: normalizeKeys(timeline.map((k) => ({ t: keyTimeInUnclamped(to, from, k.at), v: k.v, ease: k.ease }))),
          },
        };
        const frames = Math.round(moved.duration * 30);
        for (let i = 0; i <= frames; i += 1) {
          const time = moved.start + Math.min(moved.duration, i / 30);
          const a = sampleAnimated(from.value, keyTimeIn('source', from, time), s.fallback);
          const b = sampleAnimated(moved.value, keyTimeIn(to, moved, time), s.fallback);
          worst = Math.max(worst, Math.abs(a - b));
        }
      }
    }
    check(
      '時間軸を替えても、編集していなければ 1 コマも変わらない（画面の写し替え）',
      worst <= 1e-9,
      `最悪 ${worst.toExponential(1)}`,
    );
  }

  // 測る側（`hold.ts`）の `stillValue` が、持っていく形（`track.ts`）と同じ道を通るか。
  // **ここが食い違うと、`hold-probe.mjs` の表は「本体がどうなるか」を語れない。**
  {
    let worstRead = 0;
    let sameShape = true;
    for (const s of OFF_DEFAULTS) {
      const slot = slotFor('stillValue', s);
      const track: AnimatedTrack = { base: s.want, keys: keysIn(slot.value) };
      const frames = Math.round(slot.clip.duration * 30);
      for (let i = 0; i <= frames; i += 1) {
        const time = slot.clip.start + Math.min(slot.clip.duration, i / 30);
        worstRead = Math.max(
          worstRead,
          Math.abs(
            readAt('stillValue', slot, time, s.fallback) -
              sampleClipValue(slot.clip, track, time, s.fallback),
          ),
        );
      }
      // 打点を全部消したあとの形も、両方の道で同じであること。
      const byHold = clearAll('stillValue', slot).value;
      let byTrack: AnimatedTrack = track;
      for (const k of keysIn(slot.value)) byTrack = removeKeyAt(slot.clip, byTrack, k.t, s.fallback);
      if (JSON.stringify(byHold) !== JSON.stringify(byTrack)) sameShape = false;
    }
    check(
      '測る側の stillValue は、持っていく形と 1 コマも違わない（物差しを 2 本置かないため）',
      worstRead <= 1e-9 && sameShape,
      `読みの最悪 ${worstRead.toExponential(1)} / 畳んだ形 ${sameShape ? '一致' : '**食い違う**'}`,
    );
  }

  return [...results];
}
