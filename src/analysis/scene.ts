/**
 * シーン検出（素材の中でカットが切り替わっている所を見つける）の計画を立てる。
 *
 * やることは 4 段だけで、無音カット（`auto-cut/src/silence.ts`）とほぼ同じ形をしている:
 *   1. 隣り合うコマの距離を測る
 *   2. 線を超えたコマを候補とする
 *   3. **変化をまたいで前後を比べ**、戻ってくる変化（フラッシュ）を門で落とす
 *   4. 連なった候補と短すぎる場面をまとめる
 *
 * 実際に切るのは呼び出し側。ここは秒の並びを返すだけなので、
 * タイムラインの実装が変わっても使い回せる。
 * 返す `scenes` は隙間なく並ぶので、`auto-cut/src/edits.ts` の `toClipEdits` へ
 * そのまま渡せば「1 本のクリップを場面ごとに割る」になる。
 *
 * ## なぜヒストグラムなのか（2026-09-20・4 回目に測って決めた）
 *
 * 画素を引き算する素直な手（`grid`）は、**カメラが横に流れるだけで破れる**。
 * 12 本で測ると、正解のコマの最小 0.044 に対してパンの最大が 0.039 で、
 * 差は 1.1 倍しかない（線が引けない）。明るさの分布どうしを比べると、
 * **画面の中で物が動いても分布は動かない**ので、同じ素材で 0.153 対 0.035 と 4.4 倍開く。
 * 数字は `npm run lab:scene:probe` の 1 段目と 2 段目にある。
 */

import { DISTANCES, type FrameStat } from './frames.ts';

export interface Range {
  start: number;
  end: number;
}

export interface SceneCutOptions {
  /**
   * 何を見て「変わった」と決めるか。
   * - `combined`（既定）: `lumaHist` と `rgbHist` の大きいほう
   * - `lumaHist`: 明るさの分布。パン・ズーム・被写体の横断に強いが、色だけのカットが見えない
   * - `rgbHist`: 色の分布。色だけのカットは見えるが、黒へのフェードで山が縁からずれる
   * - `grid`: 縮小した画素の引き算。**パンに破れる**ので既定にはしていない
   */
  metric: 'combined' | 'lumaHist' | 'rgbHist' | 'grid' | 'changed' | 'meanLuma';
  /**
   * 隣り合うコマがこれだけ離れていたら候補にする（0〜1）。
   *
   * もとは 0.10 だった（正解のコマの最小 0.153 と、カットでないコマの最大 0.035 の間）。
   * **2026-09-22（3 回目）に 0.05 へ下げた。** 下げた理由は精度ではなく、
   * 短尺の動画に必ず乗っている**焼き込みの文字帯**（字幕・見出し）。
   * 帯は場面が切り替わっても 1 画素も動かないので、**どのカットの距離もそのぶん薄まる**。
   * 20 本で測った「本物のカットの最小」は、帯なし 0.167 → 26% で 0.126 → 40% で 0.078 と落ち、
   * **0.10 では 40% の帯で見逃しが出る**（`cuts-similar`）。
   *
   * **下げしろの底を決めているのは `captions-only`**（字幕だけが書き換わる素材）で、
   * その山は 0.019（帯なし）〜0.049（帯 70%）。**この山は比の線では落ちない**
   * （周りが静かな所で小さく跳ねるので、比は 11〜15 倍まで立つ）。
   * つまり固定の線は「比が肩代わりしたから要らない」ものではなく、
   * **書き換わる帯に対する唯一の守り**で、そのぶん下げすぎれば空振りに変わる。
   *
   * 0.05 は、上（本物の最小）と下（字幕の山）の相乗平均をほぼ両立する値:
   *   帯 26% で √(0.019×0.126) = 0.049 ／ 帯 40% で √(0.030×0.078) = 0.048。
   * 代価も書いておく。**帯が無いときの余裕は 5.3 倍 → 2.6 倍へ減る。**
   * 引き換えに、帯 55% まで 1 本も落とさない（0.10 は 40% で落ちる）。
   * 帯が無ければ 0.02〜0.14 のどこでも結果は 1 本も動かない（`lab:scene` の線の振り）。
   */
  threshold: number;
  /**
   * 変化をまたぐ幅（コマ）。
   *
   * カットなら「K コマ前」と「K コマ後ろ」は別の場面なので離れたままだが、
   * フラッシュのように戻ってくる変化なら、またいだ先では同じ場面に戻っている。
   *
   * **幅は、落としたい変化の長さより広く取る必要がある。**
   * 候補のコマは変化の真ん中とは限らず、端に立つこともあるからで、
   * 実際 5 コマぶん光るフラッシュを K=5 でまたぐと、
   * 「K コマ前」がまだ光の中に残っていて門が開いてしまう（誤りの最大 0.473）。
   * K=6 まで広げると 0.009 まで落ちる。
   *
   * **代価は最短シーン長と同じ向きに効く。** またぐ幅より短い場面は門が丸ごとまたぐので、
   * 前後が似ていれば本物のカットでも落ちうる。既定の 6 コマは 30fps で 0.2 秒。
   */
  straddleFrames: number;
  /**
   * 門の線（0〜1）。null なら `threshold` と同じ値を使う。
   *
   * 既定で同じ値を使っているのは、**線を 2 本に分けても根拠が 1 つしかない**ため。
   * 12 本での実測は、正解の最小 0.167 に対して落としたい側の最大 0.014 で、
   * その間ならどこでも同じ結果になる。分ける理由が出てきたら、そのとき分ける。
   */
  straddleThreshold: number | null;
  /**
   * **その場のふだんの高さの何倍立っているか**の下限。null なら見ない。
   *
   * 2026-09-22 に縦型（9:16 の切り出し）で測って足した。縦型にすると画面に写る範囲が
   * 横型の 0.316 倍になるので、**パンも手ぶれも画面に対しては 3.16 倍の速さで効く**。
   * 実際 `pan` の隣どうしの距離は 0.006 → **0.160** まで上がり、固定の線を超える
   * （当時の既定は 0.10。9/22・3 回目に 0.05 へ下げたので、なおさら超える）。
   *
   * **線を上げる形では直らない。** 縦型は 0.160〜0.426 のあいだなら通るが、
   * 横型のカットは最小 0.167 なので、1 本の固定線に残る余裕は **1.04 倍**しかない。
   * 大きさそのものではなく、**周りと比べてどれだけ跳ねたか**を見る必要がある。
   * パンは「ずっと同じくらい動き続ける」ので周りも高く、カットは「1 コマだけ跳ねる」。
   *
   * 音の側で `lowBandRangeDb` を「その場の低い側から 20dB 下」に取り直したのと同じ考え方で、
   * **固定の線が外れるときは、たいてい基準をその場から取り直すほうが効く。**
   *
   * 既定の 4 は測って取った。**上も下も、この手を潰す素材が決めている**:
   *   - 下は `dark-noise`（暗所のノイズ）の 2.8 倍
   *   - 上は `pan-cuts`（パンしながらのカット）の 7.8 倍
   *     ——周りがずっと動いている所では、本物のカットでも比は立たない
   * 実際に 15 → 16 本で振ると **2〜7 のあいだは 1 本も動かない**（`lab:scene` の線の振り）。
   * その台の真ん中を取っている。
   */
  localRatio: number | null;
  /**
   * 周りを何コマ見るか（前後それぞれ）。
   *
   * **狭いと渡りが自分で自分を隠す。** 1 秒のディゾルブ（15 コマ）を W=8 で見ると
   * 窓の中がほとんど渡りで埋まり、中央値が上がって比が 1.1 倍まで落ちる（＝落ちてしまう）。
   * W=15 で 43.5、W=30 で 56.9。**渡りの長さより広く取る**のは、
   * フラッシュをまたぐ幅を「光っている長さより広く」取ったのと同じ理由。
   */
  localWindow: number;
  /**
   * 周りの中央値の下限。
   *
   * 素直な素材では周りが 0 に潰れるので、そのままだと割り算が無限大になる。
   * 0.002 は「分布の距離として意味のない大きさ」の側から取った。
   */
  localFloor: number;
  /**
   * これより短い場面は作らない（秒）。
   *
   * ディゾルブのように渡りが何コマも続くと候補が連なって立つので、
   * まとめるためにも要る。同じ連なりの中では**いちばん大きく動いたコマ**を残す。
   */
  minScene: number;
}

export const DEFAULT_SCENE_CUT: SceneCutOptions = {
  metric: 'combined',
  threshold: 0.05,
  straddleFrames: 6,
  straddleThreshold: null,
  localRatio: 4,
  localWindow: 30,
  localFloor: 0.002,
  minScene: 0.4,
};

/** 見つけた切り替わり 1 つ。 */
export interface SceneBoundary {
  /** 素材の頭からの秒数。このコマから新しい場面、という向き。 */
  time: number;
  /** 何コマ目か。 */
  frame: number;
  /** 隣り合うコマの距離。 */
  distance: number;
  /** またいだ距離。 */
  straddle: number;
  /** その場のふだんの高さの何倍立っていたか。 */
  local: number;
}

/** 落とした候補。なぜ落としたかまで残す（数字を読むときに要る）。 */
export interface RejectedBoundary extends SceneBoundary {
  reason: 'straddle' | 'local' | 'minScene' | 'run';
}

export interface ScenePlan {
  boundaries: SceneBoundary[];
  /** 隙間なく並ぶ場面の区間。境界が 0 本なら素材まるごと 1 本。 */
  scenes: Range[];
  rejected: RejectedBoundary[];
  /** コマごとの距離（表示と測定のため）。長さは stats と同じで、先頭は 0。 */
  distances: Float64Array;
}

/** 隣り合うコマの距離を並べる。先頭は比べる相手がいないので 0。 */
export function sceneDistances(stats: FrameStat[], metric: SceneCutOptions['metric']): Float64Array {
  const out = new Float64Array(stats.length);
  const distance = DISTANCES[metric];
  for (let i = 1; i < stats.length; i += 1) out[i] = distance(stats[i - 1], stats[i]);
  return out;
}

/**
 * 変化をまたいで前後を比べる。端は詰める。
 *
 * 詰めているのは、素材の頭や尻で門が測れなくなるより、
 * **狭いなりに測れるほうがまし**だから。ただし詰めた側は幅が足りないので、
 * 頭と尻の `straddleFrames` コマぶんは門が甘くなる（`straddleSpan` で分かるようにしてある）。
 */
export function straddleDistance(
  stats: FrameStat[],
  frame: number,
  straddleFrames: number,
  metric: SceneCutOptions['metric'],
): number {
  if (stats.length < 2) return 0;
  const before = Math.max(0, frame - straddleFrames);
  const after = Math.min(stats.length - 1, frame + straddleFrames);
  if (before === after) return 0;
  return DISTANCES[metric](stats[before], stats[after]);
}

/** 門が実際に何コマぶんまたげたか。端では足りない。 */
export function straddleSpan(stats: FrameStat[], frame: number, straddleFrames: number): number {
  const before = Math.max(0, frame - straddleFrames);
  const after = Math.min(stats.length - 1, frame + straddleFrames);
  return after - before;
}

/**
 * シーンの切り替わりを見つける。
 *
 * `stats` は `frames.ts` の `summarizeFrames` が返したもの。時刻は `stats[i].time`。
 */
export function planSceneCut(stats: FrameStat[], options: Partial<SceneCutOptions> = {}): ScenePlan {
  const o = { ...DEFAULT_SCENE_CUT, ...options };
  const gateLine = o.straddleThreshold ?? o.threshold;
  const distances = sceneDistances(stats, o.metric);
  const rejected: RejectedBoundary[] = [];

  if (stats.length < 2) {
    const only = stats.length === 1 ? [{ start: stats[0].time, end: stats[0].time }] : [];
    return { boundaries: [], scenes: only, rejected, distances };
  }

  const duration = endOf(stats);

  // --- 2 段目: 線を超えたコマを候補にする ---
  //
  // 線は 2 本ある。**固定の線**（`threshold`）は「小さすぎる変化を落とす」ためのもので、
  // **その場と比べる線**（`localRatio`）は「ずっと動き続けているだけの所を落とす」ため。
  // 前者だけだと縦型のパンが 11 本通り、後者だけだと静かな素材のノイズが通る。
  const candidates: SceneBoundary[] = [];
  for (let i = 1; i < stats.length; i += 1) {
    if (distances[i] < o.threshold) continue;
    const local = localRatioAt(distances, i, o.localWindow, o.localFloor);
    const c = {
      time: stats[i].time,
      frame: i,
      distance: distances[i],
      straddle: straddleDistance(stats, i, o.straddleFrames, o.metric),
      local,
    };
    if (o.localRatio !== null && local < o.localRatio) {
      rejected.push({ ...c, reason: 'local' });
      continue;
    }
    candidates.push(c);
  }

  // --- 3 段目: またいだ距離で門を立てる ---
  //
  // **まとめるより先に門を通す。** 逆にすると、フラッシュの縁と本物のカットが
  // 隣り合ったときに、フラッシュのほうが大きいだけで本物を追い出してしまう
  // （まとめは「いちばん大きく動いたもの」を残すので、落とすべき側が勝ちうる）。
  // 門は候補を減らすだけで増やさないので、先に通しても取りこぼしは増えない。
  const gated: SceneBoundary[] = [];
  for (const c of candidates) {
    if (c.straddle < gateLine) {
      rejected.push({ ...c, reason: 'straddle' });
      continue;
    }
    gated.push(c);
  }

  // --- 連なりをまとめる: 続けて線を超えたら、いちばん大きく動いたコマだけを残す ---
  //
  // ディゾルブは何コマもかけて渡るので、素直に数えると 1 つの渡りが何本にもなる。
  // ここでまとめておかないと、あとの最短シーン長が「どれを残すか」を
  // 大きさではなく**先に来たか**で決めてしまう。
  const passed: SceneBoundary[] = [];
  for (const c of gated) {
    const last = passed[passed.length - 1];
    if (last && c.frame === last.frame + 1) {
      if (c.distance > last.distance) {
        rejected.push({ ...last, reason: 'run' });
        passed[passed.length - 1] = c;
      } else {
        rejected.push({ ...c, reason: 'run' });
      }
      continue;
    }
    passed.push(c);
  }

  // --- 4 段目: 短すぎる場面は作らない ---
  //
  // 近い候補をまとめるとき、残すのは**いちばん大きく動いたもの**。
  // 「先に来たものを残す」形にすると、ディゾルブや黒への落ち込みのように
  // 渡りが何コマも続くところで、渡り始めの弱い候補が本命を追い出す。
  // これは 3 段目の手前で連なりをまとめたのと同じ理由だが、
  // **連なりは「隣り合うコマ」だけを繋ぐので、線を一度でも下回ると切れてしまう。**
  // ここで最短シーン長の幅までまとめ直して初めて、1 つの渡りが 1 本になる。
  //
  // 比べるときにコマの半分だけ甘くしてあるのは、**ちょうど最短シーン長と同じ間隔**で
  // 切り替わる素材を落とさないため。0.4 秒ごとのカットを 0.4 秒の下限で見ると、
  // 引き算の丸め誤差だけで通ったり落ちたりする（実際 31 本中 9 本が落ちた）。
  const slack = frameStep(stats) / 2;
  const clusters: SceneBoundary[][] = [];
  for (const c of passed) {
    const group = clusters[clusters.length - 1];
    if (group && c.time - group[group.length - 1].time < o.minScene - slack) group.push(c);
    else clusters.push([c]);
  }

  const boundaries: SceneBoundary[] = [];
  for (const group of clusters) {
    let best = group[0];
    for (const c of group) if (c.distance > best.distance) best = c;
    for (const c of group) if (c !== best) rejected.push({ ...c, reason: 'minScene' });
    boundaries.push(best);
  }

  // 頭と尻が短くなりすぎるなら、その境界は入れない（1 コマだけの場面を作らないため）。
  while (boundaries.length && boundaries[0].time - stats[0].time < o.minScene - slack) {
    rejected.push({ ...boundaries[0], reason: 'minScene' });
    boundaries.shift();
  }
  while (boundaries.length && duration - boundaries[boundaries.length - 1].time < o.minScene - slack) {
    rejected.push({ ...boundaries[boundaries.length - 1], reason: 'minScene' });
    boundaries.pop();
  }

  const scenes: Range[] = [];
  let start = stats[0].time;
  for (const b of boundaries) {
    scenes.push({ start, end: b.time });
    start = b.time;
  }
  scenes.push({ start, end: duration });

  rejected.sort((a, b) => a.frame - b.frame);
  return { boundaries, scenes, rejected, distances };
}

/**
 * i 番のコマが、周り（前後 `window` コマ）のふだんの高さの何倍立っているか。
 *
 * 周りの代表値に**中央値**を使うのは、平均だと跳ねたコマ自身と
 * 「カットの多い素材」で周り側が引き上げられてしまうため
 * （`cuts-rapid` は 0.4 秒ごとに跳ねるので、平均だと自分で自分を隠す）。
 *
 * 自分の左右 1 コマを数えないのは、**渡りの縁が中央値へ混ざるのを避ける**ため。
 * ディゾルブの山の隣は同じ渡りの一部なので、周りではなく本人の一部として扱う。
 */
export function localRatioAt(distances: ArrayLike<number>, i: number, window: number, floor: number): number {
  const around: number[] = [];
  // 先頭の 0 は「比べる相手がいなかった」という印で、**測った値ではない**。
  // 周りに混ぜると中央値を下へ引いて、素材の頭だけ門が甘くなる。
  const from = Math.max(1, i - window);
  const to = Math.min(distances.length - 1, i + window);
  for (let j = from; j <= to; j += 1) {
    if (Math.abs(j - i) <= 1) continue;
    around.push(distances[j]);
  }
  // 周りが 1 つも無いのは、素材が数コマしかないとき。
  // **分からないときに落とすのは、この門の仕事ではない**ので通す側へ倒す
  // （0 を返すと「ずっと動き続けている」と同じ扱いになり、黙って全部落ちる）。
  if (!around.length) return Infinity;
  around.sort((a, b) => a - b);
  const n = around.length;
  const mid = n % 2 ? around[(n - 1) / 2] : (around[n / 2 - 1] + around[n / 2]) / 2;
  return distances[i] / Math.max(mid, floor);
}

/** コマとコマの間隔（秒）。時刻の列から取るので、可変フレームレートでも平均で効く。 */
function frameStep(stats: FrameStat[]): number {
  if (stats.length < 2) return 0;
  return (stats[stats.length - 1].time - stats[0].time) / (stats.length - 1);
}

/**
 * 素材の終わりの秒。
 *
 * 最後のコマの時刻そのままにすると、**最後の 1 コマぶんが尺から抜ける**。
 * コマの間隔が分かるなら 1 つぶん足す（分からないときだけ最後の時刻を使う）。
 */
function endOf(stats: FrameStat[]): number {
  const last = stats[stats.length - 1].time;
  if (stats.length < 2) return last;
  return last + frameStep(stats);
}
