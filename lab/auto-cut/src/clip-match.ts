/**
 * クリップごとの音量を、互いに揃える。
 *
 * `lufs.ts` が「タイムライン全体をどれくらいの大きさで出すか」を決めるのに対して、
 * こちらは**その中でクリップどうしの大きさを揃える**。別撮りのカットを並べたとき、
 * 1 本ごとにマイクとの距離も録音レベルも違うので、**全体の倍率をいくら正しく決めても
 * カットが変わるたびに音量が跳ねる。** そこを先に潰しておくための処理。
 *
 * 順番は必ず「クリップごとに揃える → 繋ぐ → 全体を目標へ（`lufs.ts`）→ 均す（`limiter.ts`）」。
 * 逆にすると、全体の倍率をクリップごとのばらつきが決めてしまう。
 *
 * ここが決めるのは**倍率だけ**（音は作らない）。当てた音が要るのは検算と試聴のときだけなので、
 * それは `applyClipGains` に分けてある。DOM にも WebAudio にも依存しない。
 *
 * ## 測る場所について（2026-09-20・2 回目に測って決めた）
 *
 * 「クリップ全体で測る」のと「自動カットが残した区間だけで測る」のを、
 * 発話区間の正解（`spec.mjs`）と突き合わせて比べた。揃えたあとに残る**声**のずれは
 * **全体 2.21 LU 対 残した区間 2.14 LU で、0.07 LU しか違わない。**
 * カットの結果を持ってくると `clip-match` が `silence.ts` に依存することになるが、
 * **その代価に見合う差が出なかった**ので、ここはクリップ全体を測る。
 * （区間を指定したいときのために `concatRanges` は置いてある。使うかは呼ぶ側の判断。）
 */

import type { AudioLike, BlockSource } from './loudness.ts';
import type { ClipEdit } from './edits.ts';
import {
  measureLoudness,
  measureLoudnessStream,
  summarizeSubBlockSums,
  truePeakAcrossJoin,
  STEP_SECONDS,
  TP_TAPS,
  type LoudnessMeasurement,
  type StreamLoudnessOptions,
  type SubBlockCarry,
} from './lufs.ts';

/** 揃える対象 1 本。`group` が同じものは**ひとまとめに測って、同じ倍率を当てる**。 */
export interface ClipSource {
  /** 表示用の名前。`group` を省いたときはこれが群の鍵になる。 */
  id: string;
  buffer: AudioLike;
  /**
   * 同じ撮影から切り出したもの同士をまとめる鍵。
   *
   * **自動カットが 1 本の素材を刻んだ「かけら」には、必ず同じ鍵を渡すこと。**
   * かけらごとに別の倍率を当てると、切れ目のたびに部屋の音が段になる。
   * しかも揃えて得られるものが無い——同じ撮影の中でのかけらどうしの開きは
   * 測ったところ **0.03〜1.68 LU** しかなく（2026-09-20・2 回目）、
   * そこに残っているのは揃えるべきばらつきではなく**しゃべり方の抑揚**のほう。
   */
  group?: string;
}

/** 1 本（または 1 群）の測定結果。 */
export interface ClipLoudness {
  id: string;
  group: string;
  /** ラウドネス（LUFS）。ゲートを通る窓が無ければ null。 */
  lufs: number | null;
  /** 尺（秒）。基準を決めるときの重みになる。 */
  duration: number;
  /** ゲートを通った 0.4 秒窓の数。群をまとめるときの重みに使う。 */
  gatedBlocks: number;
  /** 測るのに使った生の結果（真のピークなどを見たいとき用）。群をまとめた行では null。 */
  measurement: LoudnessMeasurement | null;
}

export interface ClipMatchOptions {
  /**
   * 何に合わせるか。
   * - `median`（既定）… クリップの**尺で重みを付けた中央値**。外れ値に引きずられない。
   * - `mean` … 尺で重みを付けた平均（パワーで平均するので、繋いで測った値とほぼ同じ）。
   * - `loudest` … いちばん大きいクリップ。
   * - 数値 … その LUFS を直に基準にする。
   *
   * **既定が中央値なのは、平均が外れ値 1 本で動くから。** ただし
   * **引きずるのは静かな外れ値ではなく、大きいほうだった**（2026-09-20・2 回目に測って、
   * 書く前の見込みが外れた）。43 本から 1 本抜いたときに基準が動く幅は:
   *
   * | 抜いたもの | median | mean | loudest |
   * | --- | --- | --- | --- |
   * | `room-tone`（-49.1 LUFS・静かな外れ値） | 0.00 | 0.10 | 0.00 |
   * | `speech-loud-clipped`（-4.7 LUFS・大きい外れ値） | -0.06 | **-1.86** | **-6.14** |
   *
   * パワーで平均する以上、**30dB 下の 1 本は和にほとんど足されない**（0.1% 未満）。
   * 一方で 15dB 上の 1 本は和の 3 割を持っていく。
   * 「声の無いクリップが混じると平均が下がる」は、**dB の見かけから来る思い込み**だった。
   *
   * **ただし中央値が守ってくれるのは「まともなクリップが過半数」のときだけ。**
   * 3 本のうち 2 本が外れ値だと、**中央値そのものが外れ値に乗る**
   * （画面の検算で踏んだ。ふつうの声 1 本・小さい声 1 本・部屋の音 1 本を並べたら、
   * 基準が小さい声になってふつうの声が 18dB 下げられた）。
   * **どの基準を選んでも同じで、直す手は無い。** 見分けが要るので、凍結した壁と同じ。
   * 代わりに「半分以上が上限に当たったら基準のほうを疑う」を画面から知らせている。
   */
  reference?: 'median' | 'mean' | 'loudest' | number;
  /**
   * 上げてよい上限（dB）。既定 12。
   *
   * **下げる側より狭いのは、上げる側にだけ代価があるから。** 持ち上げれば部屋鳴りも
   * ヒスも一緒に上がるが、下げるほうは何も増えない。
   * そして上限がいちばん効くのは**声の入っていないクリップ**で、そこは素直に揃えにいくと
   * 30dB 以上持ち上げる（`room-tone.wav` は -49.1 LUFS）。
   * **「声の入っていないクリップ」を見分ける手は無い**（見分けの追い込みは 2026-09-19 に凍結）。
   * なので上限で被害を止め、当たったことを `limitedBy: 'cap'` で外へ出す。
   */
  maxBoostDb?: number;
  /** 下げてよい上限（dB）。既定 24。 */
  maxCutDb?: number;
  /**
   * これより短いクリップは測らずに 0dB のままにする（秒）。既定 0.4。
   *
   * 0.4 秒は LUFS の窓 1 つぶん。**これを下回ると窓が 1 つも立たないので、
   * `measureLoudness` は null を返す**（＝どのみち測れない）。そのぶん
   * **この線の判定は `lufs === null` より先に置いてある**（順番が逆だと、短いクリップが
   * 「測れなかった」に落ちて、見た人が録音の失敗を疑いにいってしまう）。
   * 窓が 1〜2 個しか立たない長さでも値は暴れるので、そこは `minGatedBlocks` で見る。
   */
  minDuration?: number;
  /**
   * 倍率を当てるのに必要な窓の数。既定 4（＝ 0.4 秒窓が 4 つ＝実質 0.7 秒ぶん）。
   *
   * **短いクリップを無理に揃えないための線。** 相づち 1 つぶんのクリップは、
   * 中身が「あ」だけなので測った値が素材の大きさを表さない。
   */
  minGatedBlocks?: number;
}

export const DEFAULT_CLIP_MATCH: Required<Omit<ClipMatchOptions, 'reference'>> & {
  reference: NonNullable<ClipMatchOptions['reference']>;
} = {
  reference: 'median',
  maxBoostDb: 12,
  maxCutDb: 24,
  minDuration: 0.4,
  minGatedBlocks: 4,
};

/** 1 本ぶんの結果。 */
export interface ClipGain {
  id: string;
  group: string;
  gain: number;
  gainDb: number;
  /** 測った値（群の値）。 */
  lufs: number | null;
  /** 当てたあとのラウドネス（LUFS）。上限に当たったならここが基準からずれる。 */
  resultLufs: number | null;
  /**
   * 何に止められたか。
   * - `none` … 基準ちょうどに揃った
   * - `cap` … 上限に当たった（**中身を確かめたほうがよい印**。声の無いクリップはここに出る）
   * - `tooShort` … 短すぎるので触らなかった
   * - `unmeasurable` … ゲートを通る窓が無く測れなかった（無音のクリップなど）
   */
  limitedBy: 'none' | 'cap' | 'tooShort' | 'unmeasurable';
  /** 上限が無ければ当てていた倍率（dB）。`cap` のときだけ `gainDb` と食い違う。 */
  wantedDb: number;
}

export interface ClipMatchPlan {
  /** 合わせにいった値（LUFS）。測れるクリップが 1 本も無ければ null。 */
  referenceLufs: number | null;
  gains: ClipGain[];
  /** 揃える前のクリップどうしの開き（LU）。測れたものだけで見る。 */
  spreadBefore: number;
  /** 揃えたあとの開き（LU）。上限に当たったクリップが残るので 0 にはならないことがある。 */
  spreadAfter: number;
}

/** 区間の並びを繋いだ音を作る（測る場所を絞りたいとき用）。範囲外と長さ 0 は落とす。 */
export function concatRanges(buffer: AudioLike, ranges: { start: number; end: number }[]): AudioLike | null {
  const sr = buffer.sampleRate;
  const spans: [number, number][] = [];
  for (const r of ranges) {
    const from = Math.max(0, Math.min(buffer.length, Math.round(r.start * sr)));
    const to = Math.max(0, Math.min(buffer.length, Math.round(r.end * sr)));
    if (to > from) spans.push([from, to]);
  }
  const total = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (total === 0) return null;

  const planes: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    const out = new Float32Array(total);
    let k = 0;
    for (const [a, b] of spans) for (let i = a; i < b; i += 1) out[k++] = src[i];
    planes.push(out);
  }
  return {
    sampleRate: sr,
    numberOfChannels: buffer.numberOfChannels,
    length: total,
    getChannelData: (c: number) => planes[c],
  };
}

// ---------- 長尺（クリップごとに流す形。2026-10-03） ----------
//
// 一括の道（`measureClips` → `concatRanges` → `applyClipGains`）は、**どれも
// 「標本の列が丸ごと手元にある」ことを前提にしている。** とくに `measureClips` は
// 引数が `ClipSource[]` なので、**測り始める前に全部のクリップが同時に起きている。**
// 測ってみると山は「いちばん長い 1 本」ではなく**同時に抱えている合計**で決まる。
// 合計 120 秒を固定して 1 本から 16 本まで刻んでも山は動かず、本数を固定して合計を振ると
// そのまま比例した（README の表）。**刻み方では逃げられない。**
//
// 下の道は `BlockSource`（`loudness.ts`）の上に乗せ替えたもので、**標本の列をどこにも持たない。**
// 入り口も出口も `BlockSource` なので、繋ぎ合わせても列は生えない。

/** 揃える対象 1 本（流す形）。`ClipSource` の `buffer` が `source` に変わっただけ。 */
export interface ClipStreamSource {
  id: string;
  source: BlockSource;
  /** `ClipSource.group` と同じ意味。かけらには必ず同じ鍵を渡すこと。 */
  group?: string;
}

/** 繋ぐ材料 1 つ。`[from, to)` は `source` の中の絶対位置。 */
interface JoinPiece {
  source: BlockSource;
  from: number;
  to: number;
}

/**
 * 「これは何の入り口を包んだものか」の印。
 *
 * **後ろ向きの読みを見つけるのに、包んだ相手の正体が要る。** `gainSource` で包むと
 * 別のものになるので、同じ素材を 2 回並べても気づけなくなる（倍率が 1 倍かどうかで
 * 落ちたり落ちなかったりする、といういちばん嫌な形になる）。
 * **位置をずらさない包み**だけがこの印を引き継ぐ。繋いだ入り口（`joinPieces`）は
 * 座標が変わるので引き継がない。
 */
const SOURCE_ROOT = Symbol('包む前の入り口');

const rootOf = (source: BlockSource): unknown =>
  (source as unknown as Record<symbol, unknown>)[SOURCE_ROOT] ?? source;

/**
 * 断片を順に繋いだ `BlockSource` を作る。**列は作らない**（読まれたときに元から取り出す）。
 *
 * ## 「繋ぐ順」と「読む向き」は同じではない
 *
 * `BlockSource.read` は**前へ進む方向にしか呼ばれない**約束（`loudness.ts`）なので、
 * 繋いだ側が前へ進んでも、**同じ元から後ろ向きに取りにいく並びは作れない。**
 * 一括の `concatRanges` は列を作るので逆順でも平気で、ここだけが狭い。
 * なので**同じ元を続けて使うときは、前の終わり以降から始まること**を要求して、
 * 破っていたらその場で落とす（黙って並べ替えると、繋ぎ目の位置が変わって値が変わる）。
 * 逆順で繋ぎたいときは一括の `concatRanges` を使うこと。
 *
 * 元が違えばこの縛りは無い（それぞれが自分の中で前へ進む）。
 */
function joinPieces(pieces: JoinPiece[]): BlockSource | null {
  const kept = pieces.filter((p) => p.to > p.from);
  if (kept.length === 0) return null;

  const first = kept[0].source;
  for (const p of kept) {
    if (p.source.sampleRate !== first.sampleRate || p.source.numberOfChannels !== first.numberOfChannels) {
      throw new Error(
        `繋ぐ材料の形が揃っていません（${first.sampleRate}Hz ${first.numberOfChannels}ch と ` +
          `${p.source.sampleRate}Hz ${p.source.numberOfChannels}ch）`,
      );
    }
  }
  for (let i = 1; i < kept.length; i += 1) {
    if (rootOf(kept[i].source) === rootOf(kept[i - 1].source) && kept[i].from < kept[i - 1].to) {
      throw new Error(
        `同じ元を後ろ向きに読む並びは流せません（${kept[i - 1].to} の次が ${kept[i].from}）。` +
          '逆順や重なりのある並びは一括の concatRanges を使ってください。',
      );
    }
  }

  // 繋いだ座標での各断片の先頭。読むたびに探すので、昇順の列として持つ。
  const starts: number[] = [];
  let total = 0;
  for (const p of kept) {
    starts.push(total);
    total += p.to - p.from;
  }

  /** 繋いだ座標 `at` を含む断片の番号。 */
  const pieceAt = (at: number) => {
    let lo = 0;
    let hi = kept.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const channels = first.numberOfChannels;
  return {
    sampleRate: first.sampleRate,
    numberOfChannels: channels,
    length: total,
    read(from: number, to: number) {
      const n = to - from;
      if (n <= 0) return new Array(channels).fill(null).map(() => new Float32Array(0));
      // **外へはみ出した読みは、その場で落とす。** 黙って断片の列から落ちると
      // `undefined` を触って落ちるので、どこで間違えたかが分からなくなる。
      if (from < 0 || to > total) {
        throw new Error(`繋いだ入り口の外を読もうとしています（[${from}, ${to}) / 長さ ${total}）`);
      }
      let si = pieceAt(from);
      // 断片 1 つに収まるなら、写さずにそのまま渡す（**ここが効く**。
      // 既定の区間 5 秒に対して繋ぎ目は数えるほどしかないので、ほとんどの読みがこちら）。
      const inPiece = from - starts[si];
      if (inPiece + n <= kept[si].to - kept[si].from) {
        return kept[si].source.read(kept[si].from + inPiece, kept[si].from + inPiece + n);
      }
      const out: Float32Array[] = [];
      for (let c = 0; c < channels; c += 1) out.push(new Float32Array(n));
      let k = 0;
      let at = from;
      while (k < n) {
        const p = kept[si];
        const off = at - starts[si];
        const take = Math.min(n - k, p.to - p.from - off);
        const got = p.source.read(p.from + off, p.from + off + take);
        for (let c = 0; c < channels; c += 1) out[c].set(got[c], k);
        k += take;
        at += take;
        si += 1;
      }
      return out;
    },
  };
}

/**
 * 区間の並びを繋いだ入り口を作る（`concatRanges` の、列を作らない版）。
 *
 * 範囲外の切り詰めと「長さ 0 は落とす」は一括と同じ。拾えるものが無ければ `null`。
 * **逆順・重なりのある並びは流せない**（`joinPieces` の注）ので、そこだけ振る舞いが違う。
 */
export function concatRangesSource(source: BlockSource, ranges: { start: number; end: number }[]): BlockSource | null {
  const sr = source.sampleRate;
  const pieces: JoinPiece[] = [];
  for (const r of ranges) {
    const from = Math.max(0, Math.min(source.length, Math.round(r.start * sr)));
    const to = Math.max(0, Math.min(source.length, Math.round(r.end * sr)));
    if (to > from) pieces.push({ source, from, to });
  }
  return joinPieces(pieces);
}

/**
 * クリップを順に繋いだ入り口を作る（＝タイムライン 1 本ぶん）。
 *
 * 「クリップごとに揃える → **繋ぐ** → 全体を目標へ → 均す」の 2 番目。
 * ここで列を作ってしまうと、せっかく流した測りの得がその場で消える。
 */
export function concatSources(sources: BlockSource[]): BlockSource | null {
  return joinPieces(sources.map((source) => ({ source, from: 0, to: source.length })));
}

/**
 * 倍率を当てた入り口を返す（`applyClipGains` の、列を作らない版の 1 本ぶん）。
 *
 * **返ってきた列をその場で書き換えてはいけない。** `blockSourceOf` は元の
 * `Float32Array` の `subarray` を返すので、`a[i] *= gain` と書くと**元の素材が静かに育つ。**
 * 2 回測ると 2 回掛かる、という壊れ方をする（検算で固定してある）。
 * なので新しい列へ写す。区間ぶんしか作らないので、尺には比例しない。
 */
export function gainSource(source: BlockSource, gain: number): BlockSource {
  // **1 倍でも包む。** 素通りさせると、倍率がたまたま 1 倍のときだけ
  // 「同じ入り口を 2 回並べた」が見つかる／見つからないが変わる。
  const wrapped: BlockSource = {
    sampleRate: source.sampleRate,
    numberOfChannels: source.numberOfChannels,
    length: source.length,
    read(from: number, to: number) {
      const got = source.read(from, to);
      const out: Float32Array[] = [];
      for (const a of got) {
        const b = new Float32Array(a.length);
        for (let i = 0; i < a.length; i += 1) b[i] = a[i] * gain;
        out.push(b);
      }
      return out;
    },
  };
  (wrapped as unknown as Record<symbol, unknown>)[SOURCE_ROOT] = rootOf(source);
  return wrapped;
}

/**
 * クリップを 1 本ずつ測る（流す形）。`measureClips` と同じ `ClipLoudness` を返す。
 *
 * `carryForTimeline` を立てると、**この並びでそのまま繋ぐ前提**で 0.1 秒ごとの二乗和も持ち出す
 * （`measurement.carry`）。`lead` はここで数えるので、呼ぶ側が数え間違える余地が無い。
 */
export function measureClipsStream(clips: ClipStreamSource[], options: ClipMeasureOptions = {}): ClipLoudness[] {
  const leads = timelineLeads(clips.map((c) => ({ length: c.source.length, sampleRate: c.source.sampleRate })), options);
  return clips.map((clip, i) => {
    const m = measureLoudnessStream(clip.source, leads === null ? options : { ...options, carryLead: leads[i] });
    return {
      id: clip.id,
      group: clip.group ?? clip.id,
      lufs: m.integratedLufs,
      duration: clip.source.length / clip.source.sampleRate,
      gatedBlocks: m.gatedBlocks,
      measurement: m,
    };
  });
}

/**
 * 決めた倍率を当てた入り口を返す（`applyClipGains` の、列を作らない版）。
 *
 * 引き方は一括と同じ——**並びで引き、合わないときだけ id に落とす。**
 * id で引くと、同じ id のクリップが 2 本あったときに黙って片方の倍率が両方へ当たる。
 */
export function applyClipGainSources(clips: ClipStreamSource[], plan: ClipMatchPlan): BlockSource[] {
  const byId = new Map(plan.gains.map((g) => [g.id, g]));
  return clips.map((clip, i) => {
    const decided = plan.gains.length === clips.length ? plan.gains[i] : byId.get(clip.id);
    return gainSource(clip.source, decided?.gain ?? 1);
  });
}

// ---------- 1 周減らす（0.1 秒ごとの二乗和を持ち出して繋ぐ。2026-10-03・2 回目） ----------
//
// 流す形の道すじは素材を **3 周**読む（クリップごとに測る → 揃えて繋ぐ → 全体を測る → 均す）。
// 3 周めを「クリップごとの **LUFS** の足し算」で代われないことは 1 回目に測って確定した
// （相対ゲートがぜんたいを見るので、ゲートを通したあとの値からは組み立て直せない）。
//
// **ゲートの手前なら持ち出せる。** 0.1 秒ごとの二乗和（`SubBlockCarry`）を繋いでから
// 窓とゲートを掛け直せば、ゲートは一括と同じ仕事をする。倍率は K 特性が線形なので後から g² 倍でよい。
// 費用は 0.1 秒あたり 8 バイト ＝ **1 時間で 288KB**。
//
// **ただし一致はしない。** 残るのは K 特性の履歴で、繋いだ列なら前のクリップの終わりが
// IIR の履歴として入ってくるのに、クリップごとに測ると毎回 0 から始まる。
// 履歴に乗る倍率と、いま掛ける倍率が違うので**原理的に埋められない**。
// どれくらい違うかは `npm run lab:clipmatch:carry` で測ってある（README の表）。

/**
 * クリップの並びから、それぞれの `carryLead`（繋いだ格子の最初の切れ目までの標本数）を出す。
 *
 * **ここを間違えると升が 1 つずれる**（それでいて測りはもっともらしい値を返す）ので、
 * 呼ぶ側に数えさせずに道具にしてある。
 */
export function clipCarryLeads(lengths: number[], stepSamples: number): number[] {
  const leads: number[] = [];
  let offset = 0;
  for (const length of lengths) {
    leads.push((stepSamples - (offset % stepSamples)) % stepSamples);
    offset += length;
  }
  return leads;
}

/** `measureClips` / `measureClipsStream` の選べること。 */
export interface ClipMeasureOptions extends StreamLoudnessOptions {
  /**
   * クリップを**この並びでそのまま繋ぐ**前提で、0.1 秒ごとの二乗和も一緒に持ち出す。
   *
   * 立てると `measurement.carry` が埋まり、`measureTimelineFromClips` でタイムライン全体の
   * 測りを**素材を読み直さずに**組み立てられる（道すじが 3 周 → 2 周になる）。
   * `carryLead` を自分で渡すときは立てないこと（こちらが上書きする）。
   */
  carryForTimeline?: boolean;
}

/** `carryForTimeline` が立っていれば、並びから `lead` を数えて返す。立っていなければ null。 */
function timelineLeads(shapes: { length: number; sampleRate: number }[], options: ClipMeasureOptions): number[] | null {
  if (options.carryForTimeline !== true || shapes.length === 0) return null;
  const sampleRate = shapes[0].sampleRate;
  for (const shape of shapes) {
    if (shape.sampleRate !== sampleRate) {
      throw new Error(`標本化周波数が違うクリップは同じ格子に載せられません（${sampleRate}Hz と ${shape.sampleRate}Hz）`);
    }
  }
  return clipCarryLeads(shapes.map((shape) => shape.length), Math.max(1, Math.round(STEP_SECONDS * sampleRate)));
}

/** 繋ぐ材料 1 本。 */
export interface ClipCarryPart {
  /** `carryLead` を渡して測ったときに返ってくる列。 */
  carry: SubBlockCarry;
  /** このクリップへ当てる倍率（線形）。 */
  gain: number;
  /** そのクリップの測り（ピークとチャンネル数をここから拾う）。 */
  measurement: LoudnessMeasurement;
}

export interface CombineCarryOptions {
  /**
   * 繋ぎ目をまたぐ窓の真のピーク（線形）。`joinTruePeak` で出せる。
   *
   * **渡さないと、真のピークは低く出る。** クリップごとの最大には繋ぎ目の段差が入らないので、
   * 位相差 0.5π の例で **1.07dB** 低かった（2026-10-03・1 回目）。
   * 書き出しの倍率を決めるのに使うなら、必ず渡すこと。
   */
  joinTruePeak?: number;
}

/**
 * クリップごとの `carry` を繋いで、タイムライン全体の測りを組み立てる。
 *
 * **素材を読み直さない。** 窓・ゲート・分位点は `summarizeSubBlockSums` がやるので、
 * 繋いで測り直したときと**同じ取り決め**が当たる。
 *
 * 並びは `clipCarryLeads` が出した `lead` と揃っていること（違えば落ちる）。
 * **黙って 1 升ずれるほうが、落ちるより悪い。**
 */
export function combineClipCarries(parts: ClipCarryPart[], options: CombineCarryOptions = {}): LoudnessMeasurement {
  if (parts.length === 0) {
    throw new Error('繋ぐ材料がありません');
  }
  const step = parts[0].carry.stepSamples;
  const channels = parts[0].measurement.channels;
  let total = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const c = parts[i].carry;
    if (c.stepSamples !== step) {
      throw new Error(`升の大きさが揃っていません（${step} と ${c.stepSamples}）。標本化周波数が違う素材は繋げません。`);
    }
    const want = (step - (total % step)) % step;
    if (c.lead !== want) {
      throw new Error(`${i} 本目の carryLead が並びと合いません（要 ${want} / 渡された ${c.lead}）`);
    }
    total += c.length;
  }

  const subBlocks = Math.floor(total / step);
  const sums = new Float64Array(subBlocks);
  let k = 0;
  // 升の途中（倍率と重みは掛け済み・`step` で割る前）。**切れ目をまたぐ升はここで左右が出会う。**
  let open = 0;
  let samplePeak = 0;
  let truePeak = 0;
  let duration = 0;
  for (const part of parts) {
    const g2 = part.gain * part.gain;
    const c = part.carry;
    open += g2 * c.head;
    // 先頭の端数が升を閉じるのは、**その切れ目までクリップが届いているときだけ**。
    // 1 升より短いクリップは升を閉じずに、次のクリップへ持ち越す。
    if (c.lead > 0 && c.length >= c.lead) {
      if (k < subBlocks) sums[k] = open / step;
      k += 1;
      open = 0;
    }
    for (let b = 0; b < c.full.length; b += 1) {
      if (k < subBlocks) sums[k] = (g2 * c.full[b]) / step;
      k += 1;
    }
    open += g2 * c.tail;

    const db = 20 * Math.log10(part.gain > 0 ? part.gain : Number.MIN_VALUE);
    samplePeak = Math.max(samplePeak, Math.pow(10, (part.measurement.samplePeakDb + db) / 20));
    truePeak = Math.max(truePeak, Math.pow(10, (part.measurement.truePeakDb + db) / 20));
    duration += part.measurement.duration;
  }
  if (k !== subBlocks) {
    throw new Error(`升の数が合いません（組み立て ${k} / 繋いだ長さから ${subBlocks}）`);
  }
  // 最後に残った `open` は、タイムラインの末尾の端切れ。一括も数えていないので捨てる。

  return summarizeSubBlockSums(sums, subBlocks, {
    samplePeak,
    truePeak: Math.max(truePeak, options.joinTruePeak ?? 0),
    skipTruePeak: false,
    carry: null,
    duration,
    channels,
  });
}

/**
 * `carryForTimeline` で測ったクリップの列から、タイムライン全体の測りを組み立てる。
 *
 * **素材を読み直さない。** 倍率は `plan` のものを当てる（並びで引く。`planClipMatch` は
 * 渡した `measured` と同じ並び・同じ数で返すので、ここは並びだけで足りる）。
 */
export function measureTimelineFromClips(
  measured: ClipLoudness[],
  plan: ClipMatchPlan,
  options: CombineCarryOptions = {},
): LoudnessMeasurement {
  if (plan.gains.length !== measured.length) {
    throw new Error(`倍率の数がクリップの数と合いません（倍率 ${plan.gains.length} / クリップ ${measured.length}）`);
  }
  return combineClipCarries(
    measured.map((m, i) => {
      if (m.measurement === null || m.measurement.carry === null) {
        throw new Error(`${i} 本目に carry がありません（carryForTimeline を立てて測ってください）`);
      }
      return { carry: m.measurement.carry, gain: plan.gains[i].gain, measurement: m.measurement };
    }),
    options,
  );
}

/**
 * 繋ぎ目をまたぐ窓だけを打ち直して、真のピークを返す（線形）。
 *
 * クリップの中に収まる窓は、クリップごとの測りがもう数えている。
 * **足りないのは繋ぎ目をまたぐ窓だけ**なので、前後 11 標本ずつ読めば済む
 * （1 か所あたり 22 標本。1 周読み直すのとは桁が違う）。
 *
 * 受けるのは**倍率を当てる前**の入り口（倍率は `gains` でここで掛ける）。
 *
 * ## 2 つ、気をつけること
 *
 * **これは `BlockSource` を後ろ向きに読む。** 読む向きの約束（前へ進むだけ）の外なので、
 * クリップごとに測り終えたあとに**末尾へ戻って 11 標本を読む**ことになる。
 * すでに起こしてある素材（`blockSourceOf`）なら何も起きないが、
 * **デコーダに `read` を実装する側では、ここだけ戻りの読みが来る**（1 か所 22 標本）。
 * 本体へ持っていくときに決める話として、ここに書いておく。
 *
 * **11 標本より短いクリップがあると、そこを挟む窓を数え落とす。**
 * `clip-match` は 0.4 秒より短いクリップを触らない（`minDuration`）ので実際には起きないが、
 * 数え落としは黙って小さい値になるため、ここに書いておく。
 */
export function joinTruePeak(sources: BlockSource[], gains: number[]): number {
  let peak = 0;
  for (let i = 1; i < sources.length; i += 1) {
    const left = sources[i - 1];
    const right = sources[i];
    const n = TP_TAPS - 1;
    const a = left.read(Math.max(0, left.length - n), left.length)[0];
    const b = right.read(0, Math.min(n, right.length))[0];
    const gl = gains[i - 1] ?? 1;
    const gr = gains[i] ?? 1;
    const la = new Float32Array(a.length);
    for (let j = 0; j < a.length; j += 1) la[j] = a[j] * gl;
    const rb = new Float32Array(b.length);
    for (let j = 0; j < b.length; j += 1) rb[j] = b[j] * gr;
    const p = truePeakAcrossJoin(la, rb);
    if (p > peak) peak = p;
  }
  return peak;
}

/** LUFS ↔ パワー。群をまとめるときに「dB のまま足さない」ためだけに要る。 */
const toPower = (lufs: number) => Math.pow(10, (lufs + 0.691) / 10);
const fromPower = (power: number) => (power > 0 ? -0.691 + 10 * Math.log10(power) : null);

/** クリップを 1 本ずつ測る。`carryForTimeline` の意味は `measureClipsStream` と同じ。 */
export function measureClips(clips: ClipSource[], options: ClipMeasureOptions = {}): ClipLoudness[] {
  const leads = timelineLeads(clips.map((c) => ({ length: c.buffer.length, sampleRate: c.buffer.sampleRate })), options);
  return clips.map((clip, i) => {
    const m = measureLoudness(clip.buffer, leads === null ? options : { ...options, carryLead: leads[i] });
    return {
      id: clip.id,
      group: clip.group ?? clip.id,
      lufs: m.integratedLufs,
      duration: clip.buffer.length / clip.buffer.sampleRate,
      gatedBlocks: m.gatedBlocks,
      measurement: m,
    };
  });
}

/**
 * すでに測ってある結果から `ClipLoudness` を組む。
 *
 * 画面のように**読み込んだときに 1 回だけ測る**作りだと、揃えるたびに測り直すのは無駄
 * （13 秒で 1 秒近くかかる）。ラウドネスも真のピークも基準には依らないので、
 * 測り直す必要があるのは素材そのものが変わったときだけ。
 */
export function clipLoudnessFrom(
  id: string,
  measurement: LoudnessMeasurement,
  group = id,
): ClipLoudness {
  return {
    id,
    group,
    lufs: measurement.integratedLufs,
    duration: measurement.duration,
    gatedBlocks: measurement.gatedBlocks,
    measurement,
  };
}

/**
 * 同じ群のクリップを 1 つの値にまとめる。
 *
 * **dB のまま平均してはいけない**ので、パワーへ戻し、ゲートを通った窓の数で重みを付けて平均する
 * （＝その群を繋いで測り直したのとほぼ同じ値になる。どれだけ同じかは検算で押さえてある）。
 * 完全に同じにならないのは、2 段目のゲートが群ぜんたいの平均から引き直されるため。
 */
export function groupClips(measured: ClipLoudness[]): ClipLoudness[] {
  const order: string[] = [];
  const byGroup = new Map<string, ClipLoudness[]>();
  for (const m of measured) {
    if (!byGroup.has(m.group)) {
      byGroup.set(m.group, []);
      order.push(m.group);
    }
    byGroup.get(m.group)!.push(m);
  }

  return order.map((group) => {
    const members = byGroup.get(group)!;
    const duration = members.reduce((sum, m) => sum + m.duration, 0);
    const gatedBlocks = members.reduce((sum, m) => sum + m.gatedBlocks, 0);
    let power = 0;
    for (const m of members) {
      if (m.lufs === null || m.gatedBlocks <= 0) continue;
      power += toPower(m.lufs) * m.gatedBlocks;
    }
    return {
      id: members.length === 1 ? members[0].id : `${group}（${members.length} 本）`,
      group,
      lufs: gatedBlocks > 0 ? fromPower(power / gatedBlocks) : null,
      duration,
      gatedBlocks,
      // 群としての真のピークは「members の最大」だが、いまそれを使う場面が無いので持たない。
      measurement: members.length === 1 ? members[0].measurement : null,
    };
  });
}

/** 重み付きの中央値。重みの合計の半分を跨いだところの値を返す。 */
function weightedMedian(values: { value: number; weight: number }[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, v) => sum + v.weight, 0);
  // 重みが全部 0 のときは重みの無い中央値へ落とす（尺 0 のクリップだけ、という形）。
  if (total <= 0) return sorted[Math.floor((sorted.length - 1) / 2)].value;
  let acc = 0;
  for (const v of sorted) {
    acc += v.weight;
    if (acc >= total / 2) return v.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * 測った結果から、クリップごとの倍率を決める。
 *
 * **群ごとに 1 つの倍率**を決めて、その群のクリップ全部に同じものを配る。
 * 触らないと決めたクリップ（短すぎる・測れない）は 0dB で、理由が `limitedBy` に出る。
 *
 * ここで絶対の目標（-14 LUFS など）へ合わせないのは、そこは `lufs.ts` の仕事だから。
 * **こちらは「互いに揃える」だけに閉じている**ので、あとから目標を変えても
 * クリップどうしの関係は変わらない。
 */
export function planClipMatch(measured: ClipLoudness[], options: ClipMatchOptions = {}): ClipMatchPlan {
  const opts = { ...DEFAULT_CLIP_MATCH, ...options };
  const grouped = groupClips(measured);

  // 基準を決めるのに数えてよいのは「触る対象になる群」だけ。
  // 短すぎる群や測れない群を数えると、基準そのものが引きずられる。
  const usable = grouped.filter(
    (g) => g.lufs !== null && g.duration >= opts.minDuration && g.gatedBlocks >= opts.minGatedBlocks,
  );

  let referenceLufs: number | null = null;
  if (typeof opts.reference === 'number') {
    referenceLufs = opts.reference;
  } else if (usable.length > 0) {
    if (opts.reference === 'loudest') {
      referenceLufs = Math.max(...usable.map((g) => g.lufs as number));
    } else if (opts.reference === 'mean') {
      const totalWeight = usable.reduce((sum, g) => sum + g.duration, 0);
      let power = 0;
      for (const g of usable) power += toPower(g.lufs as number) * g.duration;
      referenceLufs = totalWeight > 0 ? fromPower(power / totalWeight) : null;
    } else {
      referenceLufs = weightedMedian(usable.map((g) => ({ value: g.lufs as number, weight: g.duration })));
    }
  }

  // 群ごとに倍率を決めてから、メンバーへ配る。
  const perGroup = new Map<string, { gainDb: number; wantedDb: number; limitedBy: ClipGain['limitedBy']; lufs: number | null }>();
  for (const g of grouped) {
    // **順番に意味がある。** 3 つの理由は重なって立つので、
    // 「見た人が次にすることが違う」順に並べてある（検算で 2 回踏んだ）。
    //   ① 尺が足りない → 短すぎる。中身は関係ない。
    //   ② 尺はあるのに測れない → 無音。録音の失敗を疑う先。
    //   ③ 尺はあり音もあるが窓が足りない → 短すぎる（相づち 1 つぶんなど）。
    // ①と③を先にまとめると、**無音の 4 秒まで「短すぎる」になる**（窓が 0 個なので）。
    if (g.duration < opts.minDuration) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'tooShort', lufs: g.lufs });
      continue;
    }
    if (g.lufs === null) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'unmeasurable', lufs: null });
      continue;
    }
    if (g.gatedBlocks < opts.minGatedBlocks) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'tooShort', lufs: g.lufs });
      continue;
    }
    if (referenceLufs === null) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'unmeasurable', lufs: g.lufs });
      continue;
    }
    const wantedDb = referenceLufs - g.lufs;
    const gainDb = Math.min(opts.maxBoostDb, Math.max(-opts.maxCutDb, wantedDb));
    // 浮動小数の端で `cap` が立たないように、丸め誤差ぶんの遊びを持たせる。
    const limitedBy: ClipGain['limitedBy'] = Math.abs(gainDb - wantedDb) > 1e-9 ? 'cap' : 'none';
    perGroup.set(g.group, { gainDb, wantedDb, limitedBy, lufs: g.lufs });
  }

  const gains: ClipGain[] = measured.map((m) => {
    const decided = perGroup.get(m.group)!;
    return {
      id: m.id,
      group: m.group,
      gain: Math.pow(10, decided.gainDb / 20),
      gainDb: decided.gainDb,
      // 群の値を見せる（そのクリップ単体の値ではない）。同じ倍率が当たる理由がここに出る。
      lufs: decided.lufs,
      resultLufs: decided.lufs === null ? null : decided.lufs + decided.gainDb,
      limitedBy: decided.limitedBy,
      wantedDb: decided.wantedDb,
    };
  });

  // 開きは**触る対象になった群**だけで見る。測れない群を混ぜると、
  // 「揃えたのに開きが縮まない」が触れないものを数えているせいなのか分からなくなる。
  const before = usable.map((g) => g.lufs as number);
  const after = usable.map((g) => (g.lufs as number) + (perGroup.get(g.group)?.gainDb ?? 0));
  const spread = (xs: number[]) => (xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0);

  return { referenceLufs, gains, spreadBefore: spread(before), spreadAfter: spread(after) };
}

/**
 * 決めた倍率を当てた音を返す（元は壊さない）。
 *
 * **ここでピークの天井は見ていない。** 見るべき場所は繋いだあとの `lufs.ts` と `limiter.ts` で、
 * ここで先に抑えると「揃える」と「歪ませない」が同じつまみになる（`lufs.ts` と同じ理由）。
 */
export function applyClipGains(clips: ClipSource[], plan: ClipMatchPlan): AudioLike[] {
  const byId = new Map(plan.gains.map((g) => [g.id, g]));
  return clips.map((clip, i) => {
    // **並びで引く。** `plan.gains` は `measureClips` の並びをそのまま保っているので index が正しい。
    // id で引くと、同じ id のクリップが 2 本あったときに**黙って片方の倍率が両方へ当たる。**
    // 並びが合わない渡し方をされたときだけ id に落とす。
    const decided = plan.gains.length === clips.length ? plan.gains[i] : byId.get(clip.id);
    const gain = decided?.gain ?? 1;
    const planes: Float32Array[] = [];
    for (let c = 0; c < clip.buffer.numberOfChannels; c += 1) {
      const src = clip.buffer.getChannelData(c);
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 1) out[i] = src[i] * gain;
      planes.push(out);
    }
    return {
      sampleRate: clip.buffer.sampleRate,
      numberOfChannels: clip.buffer.numberOfChannels,
      length: clip.buffer.length,
      getChannelData: (c: number) => planes[c],
    };
  });
}

/**
 * 自動カットが刻んだかけら 1 つと、そこへ当てる倍率。
 *
 * `ClipEdit`（`edits.ts`）に倍率を足しただけのもの。本体のタイムラインへ置くとき、
 * **分割したかけらそれぞれに、その素材ぶんの倍率を 1 つ持たせる**のがここの形。
 */
export interface MatchedClipEdit extends ClipEdit {
  group: string;
  gain: number;
  gainDb: number;
  limitedBy: ClipGain['limitedBy'];
}

/**
 * 群ごとに決めた倍率を、`toClipEdits` が返したかけらへ配る。
 *
 * **ここが `clip-match` と `edits`（＝本体への継ぎ目）を繋ぐ 1 本**です。
 * 1 本の素材から出たかけらは**全部が同じ群**なので、受け取る倍率も 1 つになります。
 * かけらごとに測り直さないのがこの形の肝で、そうしないと切れ目のたびに
 * 部屋の音が段になります（README の「かけらごとに揃えてはいけません」）。
 *
 * **その群が計画に無ければ 1 倍にして `unmeasurable` を立てます。**
 * 黙って別の群の倍率を当てると、画面では揃ったように見えて音だけが違う、という壊れ方をします。
 */
export function attachClipGains(edits: ClipEdit[], group: string, plan: ClipMatchPlan): MatchedClipEdit[] {
  const decided = plan.gains.find((g) => g.group === group);
  return edits.map((edit) => ({
    ...edit,
    group,
    gain: decided?.gain ?? 1,
    gainDb: decided?.gainDb ?? 0,
    limitedBy: decided?.limitedBy ?? 'unmeasurable',
  }));
}
