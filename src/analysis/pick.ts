/**
 * 表紙（サムネイル）の候補を何枚か選ぶ。
 *
 * 選ぶ手順は 3 段:
 *   1. コマごとに点を付ける（**細かさ × 写りの良さ**）
 *   2. 点の高い順に取る
 *   3. すでに取ったものと**近すぎる／似すぎている**ものは飛ばす
 *
 * 実際に絵を書き出すのは呼び出し側。ここは秒と点を返すだけなので、
 * `ImageData` を作る経路（`scene-cut/src/decode.ts`）が変わっても使い回せる。
 *
 * ## なぜ固定の線ではなく、素材の中で比べるのか（2026-09-23 に測って決めた）
 *
 * 細かさの高さは**素材ごとにまるで違う**。10 本で測った `grad` の中央値は
 * 0.017（溶ける素材）〜0.036（文字帯の乗った素材）と 2 倍以上開いていて、
 * そのうえ文字帯が乗っているだけで底上げされる（帯の字はいつも鮮明なので）。
 * 「0.02 を超えたら鮮明」のような線を素材の外から引くと、
 * **帯のある素材では全コマが鮮明になり、溶ける素材では全コマがボケになる。**
 * 音の側で「倍率の基準を素材の中から持ってこられない」と分かったのと逆向きで、
 * こちらは**同じ素材の中での順位しか要らない**（表紙は「どれを選ぶか」なので）。
 *
 * 粒ノイズを引き算しないのも同じ理由。粒は素材の中でほぼ一定なので、
 * 順位を入れ替えない（引くと**細かい肌理まで一緒に引いてしまう**。probe の 4 段目）。
 */

import { combinedHistDistance, summarizeFrames, type FrameLike, type FrameStat } from './frames.ts';
import { summarizeThumbs, type ThumbStat } from './thumb.ts';

export interface PickOptions {
  /**
   * 細かさを何で測るか。**4 通り測って `grad`（いちばん素朴なもの）が残った**（2026-09-23）。
   *
   * - `grad`（既定）: 画面ぜんたいの隣どうしの差
   * - `cellRatio`: 升目ごとに「その升目自身の最大と比べた割合」を出し、その中央値
   * - `cellMoving`: **尺のあいだに細かさが動いた升目だけ**で測る（焼き込みの帯を外す狙い）
   * - `gradNet`: 粒ノイズの見積りを引いたもの
   *
   * 横型と「最初から縦」では `grad` が 駄目 0.0% / 良い所から 100% / 場面の網羅 100%。
   * 手の込んだ 3 つはどれもそこに届かない:
   *   - `cellRatio` は良い所から選べた率が 88.9% へ落ちる（升目ごとに割ると、
   *     **もともと何も無い升目が「満点」を返す**ので、答えが薄まる）
   *   - `cellMoving` は場面の網羅が 83.3% へ落ちる（場面が変われば升目はどこでも動くので、
   *     **外す相手が「動かない帯」ではなく「変化の少ない場面」になる**）
   *   - `gradNet` は「最初から縦」で駄目なコマが 26.7% まで増える（粒の見積りが
   *     **細かい肌理を粒と読んで引いてしまう**。probe の 4 段目）
   *
   * つまり**帯や粒に強くしようとした細工は、どれも中身の情報を一緒に削っていた。**
   */
  sharpness: 'cellRatio' | 'cellMoving' | 'grad' | 'gradNet';
  /** 何枚出すか。 */
  count: number;
  /** 選んだもの どうしを何秒以上離すか。 */
  minGap: number;
  /**
   * 似すぎと見なす線（明るさ・色の分布の隔たり。0〜1）。
   *
   * これより近い絵は「同じ画」と見なして飛ばす。**時間で離すだけでは足りない**のは、
   * 止まった場面なら 5 秒離れていても同じ絵だから。逆に距離だけで見ると、
   * 同じ場面の中で明るさが揺れただけのものを別の画と数えてしまうので、両方を使う。
   */
  minDistance: number;
  /** 暗すぎ／明るすぎの効き始め（明るさ 0〜1）。この外は 0 点。 */
  darkFloor: number;
  brightCeil: number;
  /** 効きの幅（この幅をかけて 0 点から満点へ変わる）。 */
  exposureRamp: number;
  /**
   * **周りより明るすぎるコマ**を落とす線（周りのふつうの何倍か）。
   *
   * 1 コマだけを見ても、白飛びと「もともと明るい絵」は区別が付かない
   * （画面ぜんたいが明るいのは、雪でも逆光でもふつうに起きる）。
   * フラッシュが他と違うのは**周りが暗いのに自分だけ明るい**ことなので、
   * シーン検出で `localRatio` を足したときと同じで、基準をその場から取る。
   *
   * `flashLow` 倍までは満点、`flashHigh` 倍で 0 点。`flashWindow` は周りを何秒見るか
   * （光っている長さより広く取る。狭いと光が自分で自分の基準を押し上げる）。
   */
  flashLow: number;
  flashHigh: number;
  flashWindow: number;
  /**
   * その素材のふつう（中央値）の何割を下回ったら、**似た絵を避けるためでも選ばない**か。
   *
   * 2026-09-23 に踏んだ穴をふさぐための線。似た絵を避ける条件だけを置くと、
   * **いちばん壊れたコマがいちばん「似ていない」**ので、進んでそれを選ぶ。
   * 静かな場面で 3 枚選ぼうとすると、ふつうのコマはどれも 1 枚目と似ているため全部飛ばされ、
   * フラッシュで白く飛んだコマと振り回してボケたコマだけが条件を通り抜けた
   * （`flash` で 3 枚中 2 枚、`whip-still` で 1 枚）。
   *
   * 似ていないことは**良いことの証拠ではない**ので、良し悪しの順位のほうを先に効かせる。
   */
  qualityFloor: number;
  /**
   * その下限を**何と比べるか**。`median` はふつうのコマ、`top` はその素材のいちばん良いコマ。
   *
   * 2026-09-23 に両方振って `median` にした。`top` を基準にすると、
   * **下限と場面の網羅がそのまま交換になる**（横型で 0.6 → 網羅 100%、0.9 → 33%）。
   * 素材の中でいちばん鮮明な場面が 1 つあると、ほかの場面が丸ごと線の下へ落ちるため。
   * ふつうを基準にすれば、場面ごとの高さの違いは中央値の中に吸われる。
   */
  floorBase: 'top' | 'median';
  /**
   * 条件を満たすコマが足りないとき、条件を緩めてでも枚数を揃えるか。
   *
   * 既定は緩める。表紙は**「ありません」では困る**もので、
   * 3 枚頼まれて 1 枚しか返さないより、似た絵でも 3 枚返して
   * 「3 枚目は 2 枚目と似ている」と添えるほうが使える。
   */
  fill: boolean;
}

/**
 * 既定。**どれも `npm run lab:thumb` の「つまみを振る」段で台（動かない範囲）を見て取った。**
 *
 *   `minGap`        0〜0.5 秒 が同じ（1.0 以上で良い所から選べた率が 100% → 88.9%）→ 0.5
 *   `minDistance`   0.10〜0.20 が同じ（0.02〜0.08 はかえって悪い。下を参照）→ 0.15
 *   `qualityFloor`  0.50〜0.85 が同じ（0.90 以上で場面の網羅が落ちる）→ 0.70
 *   `flashHigh`     1.15〜2.0 が同じ（外すと駄目なコマが 3.3% 出る）→ 1.4
 *   `flashWindow`   0.5 秒以上が同じ（0.2〜0.3 では光が自分で自分の基準を押し上げる）→ 0.8
 *
 * **`minDistance` を中途半端に小さくすると、外すより悪い**（0 で 0.0% のところ 0.08 で 6.7%）。
 * 小さすぎる線は「似ていない絵」ではなく「**少しだけ壊れた絵**」を通すため。
 */
export const DEFAULT_PICK: PickOptions = {
  sharpness: 'grad',
  count: 3,
  minGap: 0.5,
  minDistance: 0.15,
  qualityFloor: 0.7,
  floorBase: 'median',
  flashLow: 1.1,
  flashHigh: 1.4,
  flashWindow: 0.8,
  darkFloor: 0.03,
  brightCeil: 0.97,
  exposureRamp: 0.12,
  fill: true,
};

export interface ThumbPick {
  /** 素材の頭からの秒数。 */
  time: number;
  /** 何コマ目か。 */
  index: number;
  /** 点（細かさ × 写りの良さ）。素材をまたいで比べられる数ではない。 */
  score: number;
  /** その素材のふつう（中央値）の何倍鮮明か。**素材の中に使えるコマがあるか**の目安。 */
  relative: number;
  /** 写りの良さ（0〜1）。黒つぶれ・白飛びで下がる。 */
  exposure: number;
  /** 細かさ（`grad`）。 */
  sharpness: number;
  /** 条件を緩めて入れた 1 枚なら、その理由。ふつうに選べたときは null。 */
  relaxed: 'gap' | 'similar' | 'quality' | null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 写りの良さ（0〜1）。黒つぶれ・白飛びの両側で 0 へ落ちる。
 *
 * 掛け算にしてあるのは、**どちらか一方が駄目なら表紙にならない**から。
 * 足し算だと、真っ白なコマでも細かさが残っていれば通ってしまう
 * （フラッシュのコマは明るさ 0.954 で、細かさはまだ半分残っている）。
 */
export function exposureScore(stat: ThumbStat, options: PickOptions): number {
  const low = clamp01((stat.meanLuma - options.darkFloor) / options.exposureRamp);
  const high = clamp01((options.brightCeil - stat.meanLuma) / options.exposureRamp);
  // 飛んでいる画素の割合はそのまま引く。半分が白飛びなら、残り半分がどれだけ良くても半分。
  return low * high * (1 - clamp01(stat.clipped));
}

/**
 * 周りと比べた明るさの落とし前（0〜1）。周りのふつうの `flashLow` 倍までは 1。
 *
 * 周りの明るさは**中央値**で取る。平均だと、光そのものが基準を押し上げてしまう。
 */
// 注: 周りを毎回なめるので、コマ数の 2 乗で効く。13 秒（195 コマ）では測れないほど軽いが、
// 長尺へ当てるなら窓を滑らせる形に直すこと（リミッタの長尺対応と同じ話）。
export function flashScore(stats: ThumbStat[], index: number, options: PickOptions): number {
  if (options.flashHigh <= options.flashLow) return 1;
  const t = stats[index].time;
  const around: number[] = [];
  for (const s of stats) if (Math.abs(s.time - t) <= options.flashWindow) around.push(s.meanLuma);
  const base = median(around);
  if (!(base > 0)) return 1;
  const ratio = stats[index].meanLuma / base;
  return clamp01((options.flashHigh - ratio) / (options.flashHigh - options.flashLow));
}

/**
 * 素材ぜんたいの細かさの列を作る。
 *
 * `cellRatio` は**升目ごとに、その素材の中でのその升目の最大と比べる**。
 * 分母に下駄（素材ぜんたいの最大の 5%）を履かせてあるのは、
 * **もともと何も無い升目**（空・壁）で 0÷0 に近い割り算をしないため。
 * 下駄が無いと、平らな升目がノイズで 0.2 → 0.9 と暴れて答えを乗っ取る。
 */
export function sharpnessSeries(stats: ThumbStat[], options: PickOptions): number[] {
  if (options.sharpness === 'grad') return stats.map((s) => s.grad);
  if (options.sharpness === 'gradNet') return stats.map((s) => s.gradNet);

  const cellCount = stats[0]?.cells.length ?? 0;
  if (!cellCount) return stats.map((s) => s.grad);

  if (options.sharpness === 'cellMoving') {
    // **尺のあいだに細かさが動いた升目だけ**で測る。
    // 焼き込みの文字帯は編集で最後に乗るので、どのコマでも同じ細かさを返す
    // ——つまり動かない。そこを外せば、残るのは中身だけになる。
    const lo = new Float64Array(cellCount).fill(Infinity);
    const hi = new Float64Array(cellCount);
    for (const s of stats) {
      for (let i = 0; i < cellCount; i += 1) {
        if (s.cells[i] < lo[i]) lo[i] = s.cells[i];
        if (s.cells[i] > hi[i]) hi[i] = s.cells[i];
      }
    }
    let widest = 0;
    for (let i = 0; i < cellCount; i += 1) widest = Math.max(widest, hi[i] - lo[i]);
    const keep: number[] = [];
    for (let i = 0; i < cellCount; i += 1) if (hi[i] - lo[i] >= 0.2 * widest) keep.push(i);
    // 1 つも動かない素材（完全に止まった絵）では外す相手が居ないので、全部で測る。
    const use = keep.length ? keep : Array.from({ length: cellCount }, (_, i) => i);
    return stats.map((s) => {
      let sum = 0;
      for (const i of use) sum += s.cells[i];
      return sum / use.length;
    });
  }

  const best = new Float64Array(cellCount);
  for (const s of stats) for (let i = 0; i < cellCount; i += 1) if (s.cells[i] > best[i]) best[i] = s.cells[i];
  let top = 0;
  for (let i = 0; i < cellCount; i += 1) if (best[i] > top) top = best[i];
  const floor = top * 0.05;

  const ratios: number[] = [];
  for (const s of stats) {
    const row: number[] = [];
    for (let i = 0; i < cellCount; i += 1) row.push((s.cells[i] + floor) / (best[i] + floor));
    ratios.push(median(row));
  }
  return ratios;
}

/** コマごとの点。**細かさ × 写りの良さ**。 */
export function frameScore(stat: ThumbStat, options: PickOptions): number {
  return stat.grad * exposureScore(stat, options);
}

/** 中央値（並べ替えるので写しを取る）。 */
function median(values: number[]): number {
  if (!values.length) return 0;
  const v = values.slice().sort((a, b) => a - b);
  const half = v.length >> 1;
  return v.length % 2 ? v[half] : (v[half - 1] + v[half]) / 2;
}

/**
 * 表紙の候補を選ぶ。
 *
 * `frameStats`（シーン検出と同じ分布の要約）は**似た絵を避けるため**だけに使う。
 * 渡さなければ時間で離すだけになる。
 */
export function pickThumbnails(
  stats: ThumbStat[],
  frameStats: FrameStat[] | null = null,
  options: Partial<PickOptions> = {},
): ThumbPick[] {
  const o = { ...DEFAULT_PICK, ...options };
  if (!stats.length || o.count <= 0) return [];

  const sharp = sharpnessSeries(stats, o);
  const scores = stats.map((s, i) => sharp[i] * exposureScore(s, o) * flashScore(stats, i, o));
  // ふつうの高さ。**0 で割らない**ように、全コマが 0 点の素材（真っ黒な尺）では 1 とする。
  const mid = median(scores.filter((v) => v > 0)) || 1;

  // 点の高い順。同点のときは前のコマを先にする（毎回同じ答えが出るように）。
  const order = stats.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);

  const picked: ThumbPick[] = [];
  const skipped: { index: number; why: 'gap' | 'similar' | 'quality' }[] = [];
  // ふつうの何割を下回ったら候補から外すか。**中央値は必ず通る**ので、
  // 尺ぜんたいが同じ調子の素材（暗所など）では 1 枚も外れない。
  // 展開（`Math.max(...scores)`）で書かないのは、**長い素材で落ちる**から。
  // 10 分 15fps なら 9000 コマあり、引数の数の上限に当たりうる。
  let top = 0;
  for (const v of scores) if (v > top) top = v;
  const floor = (o.floorBase === 'top' ? top : mid) * o.qualityFloor;

  const tooClose = (index: number) =>
    picked.some((p) => Math.abs(stats[index].time - p.time) < o.minGap);
  const tooSimilar = (index: number) => {
    if (!frameStats || frameStats.length !== stats.length) return false;
    return picked.some((p) => combinedHistDistance(frameStats[index], frameStats[p.index]) < o.minDistance);
  };

  const add = (index: number, relaxed: 'gap' | 'similar' | 'quality' | null) => {
    picked.push({
      time: stats[index].time,
      index,
      score: scores[index],
      relative: scores[index] / mid,
      exposure: exposureScore(stats[index], o),
      sharpness: sharp[index],
      relaxed,
    });
  };

  for (const index of order) {
    if (picked.length >= o.count) break;
    if (scores[index] < floor) {
      skipped.push({ index, why: 'quality' });
      continue;
    }
    if (tooClose(index)) {
      skipped.push({ index, why: 'gap' });
      continue;
    }
    if (tooSimilar(index)) {
      skipped.push({ index, why: 'similar' });
      continue;
    }
    add(index, null);
  }

  // 足りなければ、飛ばしたものを戻す。
  // **戻した 1 枚には理由を付けて返す**（黙って埋めると、呼ぶ側が
  // 「3 枚とも同じくらい良い」と読んでしまう）。
  //
  // 戻す順は「**どの条件を諦めるか**」で決める。点の高い順にそのまま戻すと、
  // 隣り合うコマは点がほとんど同じなので**3 枚が 3 コマ続きになる**
  // （止まった場面で実際にそうなった。0.07 秒ずつ離れた 3 枚は表紙 3 枚ではない）。
  // 諦める順は 似すぎ → 時間の近さ → 出来 の順。**止まった場面では
  // 「似ていない 3 枚」は原理的に取れない**が、「離れた 3 枚」なら取れる。
  if (o.fill && picked.length < o.count) {
    const passes = [
      // 1. 似すぎで飛ばしたもののうち、**時間では離れている**もの
      skipped.filter((s) => s.why === 'similar' && !tooClose(s.index)),
      // 2. 残り（時間の近さで飛ばしたもの・出来で飛ばしたもの）を点の高い順に
      skipped,
    ];
    for (const pass of passes) {
      for (const s of pass) {
        if (picked.length >= o.count) break;
        if (picked.some((p) => p.index === s.index)) continue;
        // 1 段目はその場で `tooClose` を測り直す（前の 1 枚を入れたぶん条件が変わる）。
        if (s.why === 'similar' && pass !== skipped && tooClose(s.index)) continue;
        add(s.index, s.why);
      }
    }
  }

  // 返す並びは時間順。点の高い順に並べると、3 枚を並べて見るときに順序が飛ぶ。
  return picked.sort((a, b) => a.time - b.time);
}

/** コマの列からそのまま選ぶ（測る段をまとめただけの入口）。 */
export function pickFromFrames(
  frames: FrameLike[],
  times: ArrayLike<number>,
  options: Partial<PickOptions> = {},
): ThumbPick[] {
  const stats = summarizeThumbs(frames, times);
  const frameStats = summarizeFrames(frames, times);
  return pickThumbnails(stats, frameStats, options);
}
