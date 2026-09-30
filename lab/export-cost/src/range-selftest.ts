/**
 * 「要る範囲だけを起こす」側の検算（ブラウザ不要）。
 *
 * ここで押さえるのは 2 つだけ。
 *
 * 1. **組んだ区間が、鳴らす置き方を全部覆っているか。** 覆えていない区間で起こすと、
 *    そのクリップは無音になるか（断れば）、別の場所を鳴らす（断らなければ）。
 *    なので窓の並びから置き方を全部引き出して、1 つずつ区間に載せてみる。
 * 2. **区間が窓の切り方に依らないか。** 区間は `Sound`（タイムライン上の 1 本）から
 *    組んでいるので、窓 1 秒でも一括でも同じでなければならない。ここが崩れると
 *    「窓を変えたら起こす量も変わる」になり、9/26（3 回目）の結論と噛み合わなくなる。
 *
 * 実際にそのバイト数で済むか・波が同じかは `testkit/audio-range.ts` が本物の WebM で測る。
 * **中を読んだ根拠と出口で測った根拠は別物**なので両方置く。
 */

import {
  planAudioWindows,
  soundsOf,
  splitAudioSequence,
  type LabAudioClip,
  type LabAudioSequence,
} from './audio-mix.ts';
import {
  DEFAULT_MERGE_GAP_SECONDS,
  DEFAULT_PREROLL_SECONDS,
  DEFAULT_TAIL_SECONDS,
  jetCutSequence,
  mergeRanges,
  offsetInParts,
  partsOf,
  planAssetDecodes,
  readRangeOf,
  summarizeRangeCost,
  type DecodePlanOptions,
} from './audio-ranges.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * 窓に割った置き方を全部、区間に載せてみる。
 *
 * 窓の幅を何通りも試すのは、**窓の境目が区間の境目と揃った瞬間**だけ落ちる形を
 * 取りこぼさないため（9/26・3 回目に折れ線の出口で同じ形を踏んでいる）。
 */
function coverAll(
  sequence: LabAudioSequence,
  options: DecodePlanOptions = {},
  windowWidths: number[] = [0.37, 1, 5, Number.POSITIVE_INFINITY],
): { checked: number; missed: number; worstOffset: number } {
  const parts = partsOf(planAssetDecodes(sequence, options));
  let checked = 0;
  let missed = 0;
  let worstOffset = 0;
  for (const width of windowWidths) {
    const windowSeconds = Number.isFinite(width) ? width : Math.max(sequence.duration, 1e-6);
    for (const window of planAudioWindows(sequence, { windowSeconds })) {
      for (const placement of window.placements) {
        checked += 1;
        const hit = offsetInParts(parts, placement.mediaId, placement);
        if (!hit) {
          missed += 1;
          continue;
        }
        // 移した位置は、必ず起こしたものの中を指している。
        if (hit.offset < -1e-9) missed += 1;
        worstOffset = Math.max(worstOffset, hit.offset);
      }
    }
  }
  return { checked, missed, worstOffset };
}

export function runRangeSelfTest(): TestResult[] {
  const out: TestResult[] = [];
  const ok = (name: string, condition: boolean, detail = '') => out.push({ name, ok: condition, detail });

  // ---------- 何を読むか ----------

  {
    const sound = soundsOf(splitAudioSequence({ seconds: 13, assetSeconds: 13 }))[0];
    const range = readRangeOf(sound)!;
    ok(
      '素材を丸ごと使うクリップは、素材ぜんたいを読む',
      near(range.from, 0) && near(range.to, 13),
      `[${range.from}, ${range.to})`,
    );
  }

  {
    // 1 時間の素材から 10 秒。いまの本体はここで 1318MB 抱える。
    const sequence = splitAudioSequence({ seconds: 10, assetSeconds: 3600 });
    const stats = summarizeRangeCost(sequence);
    ok(
      '1 時間の素材から 10 秒だけ使う形で、起こすバイトが 2 桁以上小さくなる',
      stats.ratio > 100 && stats.rangeSeconds < 11,
      `丸ごと ${mib(stats.wholeBytes)} → 範囲 ${mib(stats.rangeBytes)}（${stats.ratio.toFixed(0)} 分の 1・起こす ${stats.rangeSeconds.toFixed(2)}s）`,
    );
  }

  {
    // 速さは読む長さを変える。2 倍速の 5 秒クリップは素材を 10 秒読む。
    const sequence = splitAudioSequence({ seconds: 5, assetSeconds: 60, speed: 2 });
    const range = readRangeOf(soundsOf(sequence)[0])!;
    ok('速いクリップは素材を長く読む（尺 × 速さ）', near(range.to - range.from, 10), `${(range.to - range.from).toFixed(3)}s`);
  }

  {
    // 素材の端を越える読みは端で切る（本体もそこから先は無音）。
    const sequence: LabAudioSequence = {
      duration: 10,
      clips: [{ id: 'a', mediaId: 'm', kind: 'audio', start: 0, duration: 10, sourceIn: 55, assetDuration: 60 }],
    };
    const range = readRangeOf(soundsOf(sequence)[0])!;
    ok('素材の端を越える読みは端で切る', near(range.from, 55) && near(range.to, 60), `[${range.from}, ${range.to})`);
  }

  {
    // 端を越えて読む置き方も、区間が端まで届いていれば載せる。
    // ここを断ると、本体では鳴っているクリップを丸ごと落とすことになる。
    const sequence: LabAudioSequence = {
      duration: 10,
      clips: [{ id: 'a', mediaId: 'm', kind: 'audio', start: 0, duration: 10, sourceIn: 55, assetDuration: 60 }],
    };
    const covered = coverAll(sequence);
    ok(
      '素材の端を越えて読む置き方も、区間が端まで届いていれば載る',
      covered.missed === 0 && covered.checked > 0,
      `${covered.checked} 件中 ${covered.missed} 件が載らなかった`,
    );
  }

  {
    // ループ。折り返しの周期に届けば素材の端まで要る。
    const short: LabAudioSequence = {
      duration: 1,
      clips: [{ id: 'a', mediaId: 'm', kind: 'audio', start: 0, duration: 1, sourceIn: 10, assetDuration: 60, loop: true }],
    };
    const long: LabAudioSequence = {
      duration: 120,
      clips: [{ id: 'a', mediaId: 'm', kind: 'audio', start: 0, duration: 120, sourceIn: 10, assetDuration: 60, loop: true }],
    };
    const a = readRangeOf(soundsOf(short)[0])!;
    const b = readRangeOf(soundsOf(long)[0])!;
    ok(
      'ループは、折り返しの周期に届いたときだけ素材の端まで要る',
      near(a.to, 11) && near(b.from, 10) && near(b.to, 60),
      `短い [${a.from}, ${a.to}) / 長い [${b.from}, ${b.to})`,
    );
  }

  {
    // ループで開始が終わり際だと、本体の loopStart が手前へ動く。数えるのをやめて丸ごと。
    const sequence: LabAudioSequence = {
      duration: 30,
      clips: [
        { id: 'a', mediaId: 'm', kind: 'audio', start: 0, duration: 30, sourceIn: 59.99, assetDuration: 60, loop: true },
      ],
    };
    const range = readRangeOf(soundsOf(sequence)[0])!;
    ok(
      'ループの開始が素材の終わり際なら、丸ごと起こす側へ倒す（loopStart が手前へ動くので）',
      near(range.from, 0) && near(range.to, 60),
      `[${range.from}, ${range.to})`,
    );
  }

  {
    // ループする置き方は載せない（loopEnd が起こしたものの末尾に化けるので）。
    const sequence: LabAudioSequence = {
      duration: 5,
      clips: [{ id: 'a', mediaId: 'm', kind: 'audio', start: 0, duration: 5, sourceIn: 0, assetDuration: 60, loop: true }],
    };
    const parts = partsOf(planAssetDecodes(sequence));
    const placement = planAudioWindows(sequence, { windowSeconds: 5 })[0].placements[0];
    ok('ループする置き方は範囲では受けない（丸ごとの道へ落とす）', offsetInParts(parts, 'm', placement) === null);
  }

  {
    // トランジションの引き延ばしは前のクリップの続きを読む。区間として繋がること。
    const sequence = splitAudioSequence({ seconds: 12, assetSeconds: 60, pieces: 3, fade: 0, transition: 0.5 });
    const plans = planAssetDecodes(sequence, { prerollSeconds: 0, tailSeconds: 0, mergeGapSeconds: 0 });
    const covered = coverAll(sequence, { prerollSeconds: 0, tailSeconds: 0, mergeGapSeconds: 0 });
    ok(
      'トランジションの引き延ばしも区間に入る（前のクリップの続きを読むので繋がる）',
      covered.missed === 0 && plans[0].reads.length === 5,
      `読む区間 ${plans[0].reads.length} 本 → 起こす ${plans[0].ranges.length} 本 ・ 載らなかった ${covered.missed} / ${covered.checked}`,
    );
  }

  // ---------- 消したクリップ ----------

  {
    const sequence = jetCutSequence({ assetSeconds: 60, takeSeconds: 2, keepRatio: 0.5, mutedMediaId: 'silent' });
    const stats = summarizeRangeCost(sequence);
    ok(
      '消したクリップだけが使う素材は、範囲の形なら 1 バイトも起こさない',
      stats.mutedAssets === 1 && stats.assets === 2,
      `素材 ${stats.assets} 個中 ${stats.mutedAssets} 個は起こさない（丸ごとの側は ${stats.wholeSeconds.toFixed(0)}s 数える）`,
    );
  }

  // ---------- 畳み方 ----------

  {
    const ranges = mergeRanges([{ from: 10, to: 12 }, { from: 13, to: 15 }], 60, { mergeGapSeconds: 1 });
    const apart = mergeRanges([{ from: 10, to: 12 }, { from: 13.5, to: 15 }], 60, { mergeGapSeconds: 1 });
    ok(
      '隙間がちょうど上限なら畳む。越えたら畳まない',
      ranges.length === 1 && near(ranges[0].to, 15) && apart.length === 2,
      `隙間 1.0 → ${ranges.length} 本 / 隙間 1.5 → ${apart.length} 本`,
    );
  }

  {
    const ranges = mergeRanges([{ from: 0.1, to: 1 }, { from: 59.5, to: 60 }], 60, { prerollSeconds: 0.5, tailSeconds: 0.5 });
    ok(
      '助走と後ろの余裕は素材の端で切る（負にも、尺より後ろにもならない）',
      ranges.length === 2 && near(ranges[0].from, 0) && near(ranges[1].to, 60),
      ranges.map((r) => `[${r.from.toFixed(2)}, ${r.to.toFixed(2)})`).join(' '),
    );
  }

  {
    // 素材が短いと、助走だけで丸ごとになる。そこは「丸ごと」と言えること。
    const sequence = splitAudioSequence({ seconds: 0.5, assetSeconds: 0.6 });
    const plan = planAssetDecodes(sequence, { prerollSeconds: 1, tailSeconds: 1 })[0];
    ok('助走と余裕で素材ぜんたいを覆ったら「丸ごと」と数える', plan.whole && plan.ranges.length === 1, `${plan.seconds.toFixed(2)}s`);
  }

  {
    // 素材が空・区間が空・逆順。落ちないこと。
    const empty = mergeRanges([], 60);
    const zero = mergeRanges([{ from: 5, to: 5 }], 60);
    const flipped = mergeRanges([{ from: 12, to: 10 }], 60, { prerollSeconds: 0, tailSeconds: 0 });
    ok(
      '空の区間・長さ 0 の区間・逆順の区間を渡しても落ちない',
      empty.length === 0 && zero.length === 0 && flipped.length === 1 && near(flipped[0].from, 10),
      `${empty.length} / ${zero.length} / [${flipped[0]?.from}, ${flipped[0]?.to})`,
    );
  }

  {
    const clip: LabAudioClip = { id: 'a', mediaId: 'm', kind: 'audio', start: 0, duration: 5, sourceIn: 0, assetDuration: 0 };
    const plans = planAssetDecodes({ duration: 5, clips: [clip] });
    ok('尺 0 の素材は区間を作らない（起こすものが無い）', plans.length === 0);
  }

  // ---------- 位置の移し替え ----------

  {
    const parts = [{ mediaId: 'm', from: 100, to: 110, assetDuration: 600 }];
    const hit = offsetInParts(parts, 'm', { offset: 103, seconds: 2, speed: 1, loop: false });
    ok('起こした区間の座標へ移すとき、区間の頭ぶん引く', hit !== null && near(hit.offset, 3), `${hit?.offset}`);
  }

  {
    const parts = [{ mediaId: 'm', from: 100, to: 110, assetDuration: 600 }];
    const before = offsetInParts(parts, 'm', { offset: 99, seconds: 1, speed: 1, loop: false });
    const after = offsetInParts(parts, 'm', { offset: 108, seconds: 5, speed: 1, loop: false });
    const other = offsetInParts(parts, 'x', { offset: 103, seconds: 1, speed: 1, loop: false });
    const fast = offsetInParts(parts, 'm', { offset: 103, seconds: 5, speed: 2, loop: false });
    ok(
      '載らない置き方は null を返す（黙って 0 にしない）',
      before === null && after === null && other === null && fast === null,
      '手前・後ろ・別の素材・速さで長くなる形の 4 つとも',
    );
  }

  // ---------- 窓に依らないこと ----------

  {
    const sequence = splitAudioSequence({ seconds: 13, assetSeconds: 60, pieces: 5, fade: 0.5, transition: 0.4 });
    const covered = coverAll(sequence);
    ok(
      '窓の幅を 0.37 / 1 / 5 秒・一括に振っても、置き方は全部同じ区間に載る',
      covered.missed === 0 && covered.checked > 0,
      `${covered.checked} 件中 ${covered.missed} 件が載らなかった`,
    );
  }

  {
    // 区間そのものが窓に依らないこと（上は「載るか」。ここは「同じか」）。
    const sequence = splitAudioSequence({ seconds: 13, assetSeconds: 60, pieces: 5, fade: 0.5 });
    const a = JSON.stringify(planAssetDecodes(sequence).map((p) => p.ranges));
    // 窓の並びを先に作っても、区間は Sound から組むので動かない。
    planAudioWindows(sequence, { windowSeconds: 0.37 });
    const b = JSON.stringify(planAssetDecodes(sequence).map((p) => p.ranges));
    ok('起こす区間は窓の切り方に依らない（Sound から組んでいるので）', a === b, a.slice(0, 60));
  }

  {
    // 助走 0 でも、計算の上では全部載る。**助走が要る理由は計算では出ない**
    // （デコーダが温まっていないという話なので、実測でしか出ない）。ここはそれを固定しておく。
    const sequence = splitAudioSequence({ seconds: 13, assetSeconds: 60, pieces: 5, fade: 0.5, transition: 0.4 });
    const covered = coverAll(sequence, { prerollSeconds: 0, tailSeconds: 0, mergeGapSeconds: 0 });
    ok(
      '助走 0 でも計算の上では全部載る（助走が要るのはデコーダが温まらないため。実測でしか出ない）',
      covered.missed === 0,
      `${covered.checked} 件中 ${covered.missed} 件`,
    );
  }

  // ---------- ジェットカットした形（自分の手を潰す側） ----------

  {
    const sequence = jetCutSequence({ assetSeconds: 600, takeSeconds: 2, keepRatio: 0.5 });
    const loose = summarizeRangeCost(sequence, { prerollSeconds: 0, tailSeconds: 0, mergeGapSeconds: 0 });
    const merged = summarizeRangeCost(sequence, { prerollSeconds: 0, tailSeconds: 0, mergeGapSeconds: 5 });
    ok(
      'ジェットカットした形では、区間が散る（畳む幅を広げると 1 本に戻る）',
      loose.parts > 100 && merged.parts === 1,
      `畳まない ${loose.parts} 本（${loose.rangeSeconds.toFixed(0)}s） → 隙間 5 秒まで畳む ${merged.parts} 本（${merged.rangeSeconds.toFixed(0)}s）`,
    );
  }

  {
    // **余分に起こす取り分は 1 山の長さで決まる。** 山が短いと、助走のほうが大きくなる。
    const short = summarizeRangeCost(jetCutSequence({ assetSeconds: 600, takeSeconds: 0.2, keepRatio: 0.1 }), {
      prerollSeconds: 0.25,
      tailSeconds: 0.25,
      mergeGapSeconds: 0,
    });
    const long = summarizeRangeCost(jetCutSequence({ assetSeconds: 600, takeSeconds: 5, keepRatio: 0.1 }), {
      prerollSeconds: 0.25,
      tailSeconds: 0.25,
      mergeGapSeconds: 0,
    });
    ok(
      '余分に起こす取り分は 1 山の長さで決まる（短い山ほど損をする）',
      short.rangeSeconds / short.readSeconds > 3 && long.rangeSeconds / long.readSeconds < 1.2,
      `0.2 秒の山 ${(short.rangeSeconds / short.readSeconds).toFixed(2)} 倍 / 5 秒の山 ${(long.rangeSeconds / long.readSeconds).toFixed(2)} 倍`,
    );
  }

  {
    const sequence = jetCutSequence({ assetSeconds: 600, takeSeconds: 2, keepRatio: 0.25 });
    const covered = coverAll(sequence, {}, [0.37, 1, 5]);
    ok(
      'ジェットカットした形でも、置き方は全部区間に載る',
      covered.missed === 0 && covered.checked > 200,
      `${covered.checked} 件中 ${covered.missed} 件が載らなかった`,
    );
  }

  {
    // 残す割合を振ると、起こす秒がそれに比例する（畳まない形で）。
    const quarter = summarizeRangeCost(jetCutSequence({ assetSeconds: 600, takeSeconds: 2, keepRatio: 0.25 }), {
      prerollSeconds: 0,
      tailSeconds: 0,
      mergeGapSeconds: 0,
    });
    const half = summarizeRangeCost(jetCutSequence({ assetSeconds: 600, takeSeconds: 2, keepRatio: 0.5 }), {
      prerollSeconds: 0,
      tailSeconds: 0,
      mergeGapSeconds: 0,
    });
    ok(
      '残す割合が起こす秒にそのまま出る（4 分の 1 と 2 分の 1 で 2 倍）',
      near(half.rangeSeconds / quarter.rangeSeconds, 2, 0.05),
      `${quarter.rangeSeconds.toFixed(0)}s / ${half.rangeSeconds.toFixed(0)}s`,
    );
  }

  // ---------- 渡された値がおかしいとき ----------

  {
    let threw = 0;
    for (const bad of [-1, Number.NaN]) {
      for (const key of ['prerollSeconds', 'tailSeconds', 'mergeGapSeconds'] as const) {
        try {
          planAssetDecodes(splitAudioSequence({ seconds: 2 }), { [key]: bad });
        } catch {
          threw += 1;
        }
      }
    }
    ok('助走・後ろの余裕・畳む幅に負の数や NaN を渡したら黙って通さない', threw === 6, `${threw} / 6 件で止まった`);
  }

  {
    // 素材が 1 山ぶんも無いと、山が 1 つも取れない。落ちずに空のタイムラインを返すこと
    // （区間の並びも空。ここで throw すると、測る側が素材の尺を振れなくなる）。
    const sequence = jetCutSequence({ assetSeconds: 1, takeSeconds: 5, keepRatio: 0.5 });
    const stats = summarizeRangeCost(sequence);
    ok(
      '素材が 1 山ぶんも無いときは、空のタイムラインを返す（落ちない）',
      sequence.clips.length === 0 && sequence.duration === 0 && stats.parts === 0 && stats.ratio === 0,
      `クリップ ${sequence.clips.length} 本 / 区間 ${stats.parts} 本`,
    );
  }

  {
    let threw = 0;
    for (const bad of [{ takeSeconds: 0 }, { keepRatio: 0 }, { keepRatio: 1.5 }, { speed: 0 }]) {
      try {
        jetCutSequence(bad);
      } catch {
        threw += 1;
      }
    }
    ok('山の長さ 0・残す割合 0 や 1 超え・速さ 0 は黙って通さない', threw === 4, `${threw} / 4 件で止まった`);
  }

  {
    // **前後で足す量が違う。** 助走は「捨てるつもりで起こす秒」で、後ろは覆いの余裕。
    // 対称にすると、後ろにも助走ぶん足すので 1 山が短い素材で取り分が倍になる。
    const wide = mergeRanges([{ from: 10, to: 12 }], 60, { prerollSeconds: 0.5, tailSeconds: 0.05 });
    ok(
      '前後で足す量が違う（前は助走・後ろは覆いの余裕。理由が違うので対称にしない）',
      near(wide[0].from, 9.5) && near(wide[0].to, 12.05),
      `[${wide[0].from}, ${wide[0].to})`,
    );
  }

  {
    ok(
      '既定は 助走 0.5 秒 ・ 後ろ 0.05 秒 ・ 畳む幅 1 秒（`lab:export:range` で測って決めた）',
      near(DEFAULT_PREROLL_SECONDS, 0.5) && near(DEFAULT_TAIL_SECONDS, 0.05) && near(DEFAULT_MERGE_GAP_SECONDS, 1),
      `${DEFAULT_PREROLL_SECONDS}s / ${DEFAULT_TAIL_SECONDS}s / ${DEFAULT_MERGE_GAP_SECONDS}s`,
    );
  }

  return out;
}
