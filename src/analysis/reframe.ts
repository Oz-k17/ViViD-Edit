/**
 * **横型の素材から縦型を切り出すとき、クロップ枠を被写体に合わせて動かす。**
 *
 * 決めるのは「各コマで、幅 `cropWidth` の窓を横のどこに置くか」の 1 本の列だけ。
 * 縦は切らない（9:16 を 16:9 から切るときに余るのは横だけ）ので、ここも横だけを持つ。
 *
 * ## 何を当てにしているか（probe で測ってから決めた。2026-09-24・3 回目）
 *
 * 被写体を指す手は **`spatial`（そのコマの中で色が浮いている列）＋ `peak`（いちばん強い所）**。
 * 7 本の素材のうち 6 本で、生の位置をそのまま枠の中心にするだけで**枠に入る率 100%**。
 * 引き算（動いた所を探す手）は、いちばん素直に見えて**いちばん悪い**——
 * カメラがパンしていると画面じゅうが動くので被写体の所だけが立つ理由が無く、
 * `subject-pan` で 2.5% まで落ちる。列をずらして打ち消しても 4.9% にしかならない。
 * 背景（列ごとの時間の中央値）と比べる手は動きに強いが、
 * **被写体が動かないと自分が背景になる**ので `subject-static` で 0.0%。
 *
 * ## ここから先が「追う」の中身
 *
 * 生の位置は**当たっているが落ち着きが無い**。そのまま枠にすると 1 コマごとに揺れて、
 * 出来上がりは手ぶれのひどい映像になる。かといって強くならすと、
 * 動き出した被写体に置いていかれる。**遅れと揺れは同じつまみの裏表**なので、
 * ここは「ならす」ではなく**どれだけ動かすかを決める**形にしてある:
 *
 *   1. 生の位置を**中央値**でならす（平均ではない。カットのコマで飛ぶ 1 点を落とすため）
 *   2. 枠の中心からのずれが `deadband` の内側なら**動かさない**
 *   3. 外へ出たら、**はみ出したぶんだけ**（`maxSpeed` を上限に）寄せる
 *
 * ## 3 は、2026-09-25（3 回目）まで「貯めて動き出す」形だった
 *
 * 前は「`settle` 秒ぶん続けて外に居たら動き出し、真ん中まで寄せ切って止まる」形で、
 * **その形が、同じ動画を焼き直しただけで枠の置き所を変えていた。**
 * ならした的が **0.001** 違うだけで「動き出す / 動かない」が入れ替わり、
 * 枠ぜんたいが **0.059**（死に帯ぶん）別の所へ行く——**59 倍の増幅器**だった。
 * 貯め方を変える手（`release` / `ramp`）は測って足りず、**貯めるのをやめると消えた**
 * （枠の開き 0.0145 → 0.0016 / 焼き直しの振れ幅 1.6pt → 0.4pt）。
 * 表は `gate` の注と `npm run lab:reframe:gate`、経緯は `README.md`。
 *
 * 払ったのは `deadband` の意味が変わったこと（下の注）と、
 * **泳ぎが少し増えたこと**（被写体の居ない 20 本で、動いた量の合計の中央値 0.042 → 0.050）。
 * 買ったのは再現性と、**短い寄り道への追従**（`subject-dart` の寄り道で 55.0% → 90.0%）。
 * 寄り道に強くなったのは、`settle` が消えて**待たずに動き出す**ようになったため。
 */

import {
  COLUMNS,
  FULL_BAND,
  type ColumnStat,
  type FrameLike,
  type RowBand,
  keepBand,
  readPeak,
  spatialOdds,
  summarizeAllColumns,
  summarizeAllRows,
  trendOdds,
} from './columns.ts';

export interface ReframeOptions {
  /** 切り出す窓の幅（画面の幅に対する割合）。16:9 から 9:16 を切るなら 81/256 ≒ 0.316。 */
  cropWidth: number;
  /**
   * 枠の中心からこのぶんまでのずれは、動かす理由にしない（画面の幅に対する割合）。
   *
   * **`gate` が `soft` のとき、この値はそのまま「止まるときに残るずれ」になる。**
   * 縁の内側では 1 コマも動かないので、寄っていっても必ずこのぶん手前で止まる。
   * 貯めて動き出す形では「動き出す線」でしかなく、動き出したあとは
   * `stopBand` まで詰め切っていた——**同じつまみが、門の形で別の意味になる。**
   *
   * 既定を 0.06 → 0.03 にしたのはそのため（2026-09-25・3 回目）。
   * 0.06 のままだと、正解が画面の端に貼り付く素材で枠が端まで詰め切れず、
   * **入れた率が 4.6 ポイント落ちる**（落ちたコマは 24 本とも画面の端だった）。
   * 0.02 まで詰めると入れた率は戻るが、**パンの泳ぎが 0.029 → 0.063 と倍**になる。
   */
  deadband: number;
  /** 1 秒に動かしてよい幅（画面の幅 / 秒）。 */
  maxSpeed: number;
  /**
   * 外へ出てから動き出すまでに要る時間（秒）。**`gate` が `soft` のときは使わない。**
   *
   * `leadIn` が頭の置き所を決めるのにはこの値を使い続けるので、消していない。
   */
  settle: number;
  /** 生の位置をならす窓（秒）。中央値を取る。 */
  smooth: number;
  /**
   * 列へ畳むときに見る縦の範囲。上下を落とすのは**焼き込みの字幕**のため。
   *
   * 短尺の動画は上下に字幕が焼かれていて、**1.5 秒ごとに書き換わる**。
   * 字幕は画面の一部しか占めないのに列の色を動かすので、
   * 「そこに何かある」を見る手がそれを拾って枠を引っぱる。
   * 上下 15% を落とすと `captions-only` の泳ぎが **0.077 → 0.010** まで落ち、
   * 追従はほとんど変わらない（`crossing-vertical` を除いた 6 本で 97.4% → 96.8%）。
   * **ここは「字幕がそこにある」という入力への仮定**なので、つまみとして残してある。
   */
  rowBand: RowBand;
  /**
   * **軸の上で、枠の中心を探してよい範囲**（2026-10-04 に縦の軸のために足した）。
   *
   * `rowBand` と同じ仮定（「字幕は上下にある」）を、**軸の向きが字幕と同じとき**に当てる口。
   * 横の軸では字幕は軸と垂直なので `rowBand` で畳む前に落とせるが、
   * 縦の軸では**字幕が軸の上に載っている**ので落とす先が無く、畳んだあとに締め出すほかない。
   * **横の軸では使わない**（既定は全部）。1 つの入れ物に両方置いてあるのは、
   * つまみの一覧が 2 つに割れると、どちらを渡したかで数字が静かにずれるため。
   */
  axisBand: RowBand;
  /**
   * 頭の置き所を、最初の `settle` 秒の中央値から決めるか。
   *
   * 真ん中から始めると、**右寄りに居続ける被写体では頭でかならず 1 回すべる**。
   * 編集では頭から最後まで素材が手元にあるので、始まる前に決めてよい。
   */
  leadIn: boolean;
  /**
   * **門の貯め方**——「外へ出ている」という証拠を、コマごとにどう足し引きするか。
   *
   * ここが 1 本のつまみになっているのは、2026-09-25（2 回目）に
   * **同じ動画を焼き直しただけで枠が数ポイントぶん振れる**と分かり、
   * その根が「貯めを 1 コマで捨てる作り」だったため。
   * 読む速さを上げる（30fps）のは上から被せた蓋で、ここが本体。
   *
   * - `step`  … 外なら +1、内へ入った瞬間に **0 へ捨てる**（2026-09-25 まではこれ）
   * - `release` … 捨てる線を入る線より内側へ置く。あいだは **据え置き**
   * - `ramp`  … 縁からの距離に**比例して**足し、内側では同じだけ引く
   * - `soft`  … 貯めを**持たない**。縁からはみ出したぶんだけ、そのコマで寄せる
   *
   * `soft` だけ毛色が違う（`settle` も `maxSpeed` の寄せ切りも使わない）。
   * 並べてあるのは、**貯め方を直すのと、貯めるのをやめるのと、どちらが効くか**を
   * 測るため。`step` / `release` / `ramp` は同じ骨格の中の違いでしかない。
   */
  gate: 'step' | 'release' | 'ramp' | 'soft';
  /** `release` のとき、貯めを捨てる線（`deadband` に対する割合）。 */
  gateRelease: number;
  /** `ramp` のとき、1 コマで満額たまるずれ（`deadband` からの超過分 / `deadband`）。 */
  gateRamp: number;
}

/**
 * **この判定へ渡すコマの速さ**（fps）。シーン検出の `ANALYSIS_FPS`（15）とは別に持つ。
 *
 * ## なぜ 2 つ持つのか（2026-09-25・2 回目に測って決めた）
 *
 * `decode.ts` の `ANALYSIS_FPS` は「読み込みの既定」ではなく**シーン検出の単位**。
 * あちらは 15fps で線を引いてあり、速く読むと渡り（ディゾルブ）が薄まって見逃す。
 * **同じ 1 本の動画から、2 つの判定が別々の速さを欲しがる。**
 * なので「読む速さ」は読み込みの持ち物ではなく、**判定ごとの持ち物**にしてある。
 *
 * ## 2026-09-25（3 回目）に、30 を持っている理由が入れ替わった
 *
 * 下に書いてある「間引くと振れる」は、**門が増幅器だったせい**だった。
 * 門を `soft` にしたら **15fps 読みも 30fps 読みも振れ幅 0.0pt** になり、
 * **当時の理由はまるごと消えた**（`npm run lab:reframe:decimate`）。
 *
 * それでも 30 のままにしているのは別の理由で、**間引くと泳ぐ**から——
 * `pan` の泳ぎが 30fps 読み 0.029 に対して 15fps 読み **0.091 / 秒**（3 倍）。
 * ならしが中央値なので、窓に入る標本が半分になると的が隣の値へ飛びやすくなり、
 * `soft` はその飛びに**そのまま付いていく**（貯める門は飛びを 1 コマぶん無視できていた）。
 *
 * **15 へ戻せば読む時間もメモリも半分・上限までの尺は 2 倍**になるので、
 * ここは開いたままの問いとして残してある（`README.md` の積み残し）。
 *
 * ## （以下は 2 回目の記録）30 にしたのは、当たるからではなく**振れないから**
 *
 * 1 回目（9/25）に「間引くと落ちる（92.6% 対 97.9%）」と書いたが、
 * **そのうち大半は測り方の穴だった。** 読む時刻をコマの頭に置いていたので、
 * 素材の速さの見積もりがほんの少し速いだけで列ぜんたいが 1 コマずれる
 * （`decode.ts` の `sampleTimes` の注）。直したうえで 7 本並べると、
 * **入れた率の平均は 15fps 読みも 30fps 読みも 96.5% で同じ。**
 *
 * 残るのは**振れ幅**のほう。中身も速さも変えずに焼くビットレートだけ 5 通り振ると
 * （粒はほとんど動かない）、入れた率はこうなる:
 *
 * | 素材 | 15fps 読み | 30fps 読み |
 * | --- | --- | --- |
 * | `motion` | 92.6〜98.4%（**5.7pt**） | 97.9〜98.4%（0.4pt） |
 * | `subject-decoy` | 92.6〜96.7%（**4.1pt**） | 96.3〜97.9%（1.6pt） |
 * | `subject-pan` / `subject-dart` | 0.0pt | 0.0pt / 0.0pt |
 *
 * **1 回目に見た 5.3 ポイントは、間引いた側の当たり外れ（5.7pt）の中に丸ごと入る。**
 * つまり「間引くと落ちる」は言えず、言えるのは「**間引くと、同じ動画を焼き直しただけで
 * 答えが数ポイント動く**」のほう。ならしは中央値なので、窓に入る標本が半分になると
 * 中央値が隣の値へ飛びやすくなり、その飛びを門（deadband / settle）が拡大する。
 *
 * 選んだのは**再現性のほう**——同じ素材を入れ直したら同じ枠が出てほしいので。
 * 払っているのは**読む時間 1.8 倍・メモリ 2 倍**、そして `MAX_ANALYSIS_FRAMES` に
 * 当たるまでの尺が 200 秒から 100 秒へ半分になること（短尺の道具なので飲んでいる）。
 *
 * 30 で止めてあるのは、そこで頭打ちになるから（`npm run lab:reframe:decimate`）:
 * 60fps で焼いた素材を 60fps で読んでも `motion` は 97.3% と上がらず、
 * 時間とメモリだけが倍になる。**素材の速さに合わせる（間引かない）を選ばなかった**のは、
 * それだと 120fps の素材で値段だけが 4 倍になるため。
 *
 * ## ならしの窓を広げる手は取らなかった
 *
 * 標本が足りないなら窓を広げればよい、という手もある（1 回目はそれを勧めていた）。
 * 測ると**窓より短い動きが中央値の中で少数派になって消える**——
 * `subject-dart`（0.8 秒の寄り道が 2 回）で、ならしたあとのずれが 0.005 → 0.173、
 * 寄り道のあいだの入れた率が 46.7% → 13.3%。**振れ幅も直らない。**
 *
 * **不安定の根は、標本の数ではなく門の側にある**（数コマの違いが
 * 「動き出す / 動かない」に化ける作り）。ここで増やしているのは、その上から被せた蓋。
 * → **その根は 2026-09-25（3 回目）に直した**（`gate` の注）。上の節を参照。
 */
export const REFRAME_ANALYSIS_FPS = 30;

export const DEFAULT_REFRAME: ReframeOptions = {
  cropWidth: 81 / 256,
  deadband: 0.03,
  maxSpeed: 0.22,
  settle: 0.3,
  smooth: 1.0,
  rowBand: { from: 0.15, to: 0.85 },
  axisBand: FULL_BAND,
  leadIn: true,
  gate: 'soft',
  gateRelease: 0.6,
  gateRamp: 0.5,
};

export interface ReframeFrame {
  time: number;
  /** 枠の中心（画面の幅に対する割合）。 */
  center: number;
  /**
   * その手が指した**生の位置**（`rawTargets` の値そのもの）。
   *
   * 下の `target` と 2 本持っているのは、**画面で見比べたときに意味が違うから**
   * （2026-09-25 に画面を作って気づいた）。生の位置が荒れているのか、
   * ならしが追い付いていないのかは、片方だけでは切り分けられない。
   */
  raw: number;
  /** 生の位置を中央値でならしたあと、枠を動かす条件へ入れる前の値。 */
  target: number;
  /** そのコマで枠を動かしたか。動いた秒数を数えるために持つ。 */
  moving: boolean;
}

export interface ReframePlan {
  frames: ReframeFrame[];
  options: ReframeOptions;
  /** 枠が動いた量の合計（画面の幅ぶん）。尺で割れば「1 秒あたりどれだけ泳いだか」。 */
  travel: number;
  /**
   * 門のふるまい。**「同じ動画を焼き直すと枠が振れる」の根を名指しするために持つ。**
   *
   * `resets` は貯めが捨てられた回数、`nearResets` はそのうち
   * **あと半分で動き出すところまで貯まっていた**もの。
   * 後者が出ている素材は、**コマ 1 枚の行き先が枠ぜんたいの行き先に化けている**。
   */
  gate: { resets: number; nearResets: number };
}

/**
 * コマの列を、**この手の都合で**畳む。
 *
 * `summarizeAllColumns` の既定は画面ぜんぶ（あちらは判断を置かない側）なので、
 * 「上下を落とす」という判断はこちらで足す。呼ぶ側が畳み方を選び違えると
 * 数字が静かにずれるので、入口を 1 つにしてある。
 */
export function summarizeForReframe(
  frames: FrameLike[],
  times: ArrayLike<number>,
  options: Partial<ReframeOptions> = {},
): ColumnStat[] {
  const opt = { ...DEFAULT_REFRAME, ...options };
  return summarizeAllColumns(frames, times, opt.rowBand);
}

/**
 * **縦の軸**（2026-10-04）。最初から縦（9:16）で撮った素材から 1:1 を切ると、余るのは縦。
 *
 * 枠を決める側（`planFromRaw`）は軸を知らない——入口は「0〜1 の位置の列」1 本だけ——ので、
 * **畳む向きを替えて窓の長さを入れ替えるだけ**で同じ道具が乗る。
 * 既定は `VERTICAL_REFRAME`。
 */
export const SQUARE_CROP_V = 9 / 16;

/**
 * 縦の軸の既定。横（`DEFAULT_REFRAME`）から変えるのは 2 つだけ:
 *
 * - `cropWidth` は**窓の高さ**（9/16 ＝ 0.5625）。受け皿の幅がそのまま 1:1 の 1 辺になる。
 *   横の窓（0.316）の **1.8 倍広い**ので、**入れた率を横の表と並べて読まないこと。**
 * - `rowBand`（畳むときに見る、軸と垂直な範囲）は**全部**。横の軸で上下 15% を落としていたのは
 *   焼き込みの字幕のためだが、**縦の軸では字幕は軸の上に載っている**ので、
 *   畳む前に落とすことができない。締め出すなら `muteCaptions` のほう（下の注）。
 */
export const VERTICAL_REFRAME: ReframeOptions = {
  ...DEFAULT_REFRAME,
  cropWidth: SQUARE_CROP_V,
  rowBand: FULL_BAND,
  axisBand: { from: 0.15, to: 0.85 },
};

/** 縦の軸へ畳む。入口を 1 つにしてある理由は `summarizeForReframe` と同じ。 */
export function summarizeForReframeVertical(
  frames: FrameLike[],
  times: ArrayLike<number>,
  options: Partial<ReframeOptions> = {},
): ColumnStat[] {
  const opt = { ...VERTICAL_REFRAME, ...options };
  return summarizeAllRows(frames, times, opt.rowBand);
}

/**
 * 縦の軸の**生の位置**。横（`rawTargets`）と違うのは 2 つだけで、**どちらも測って足した**
 * （2026-10-04。表は `npm run lab:reframe:vprobe`）:
 *
 * 1. **階調を外す**（`trendOdds`）。背景の明暗は上から下へ付いているので、
 *    コマの中の中央値と比べる手（`spatialOdds`）では**いちばん浮くのが階調の端**になる。
 *    `vsubject-static` のずれが 0.510 → 0.044、入れた率 0% → 100%。
 * 2. **軸の上の帯を締め出す**（`axisBand`）。字幕は上下にあるので、縦の軸では
 *    畳んだあとに締め出すほかない。`vsubject-captions` のずれが 0.329 → 0.013、
 *    入れた率 0% → 100%。
 *
 * **片方だけでは足りない**（階調だけだと字幕に負け、締め出しだけだと階調に負ける）。
 */
export function rawTargetsVertical(rows: ColumnStat[], band: RowBand = VERTICAL_REFRAME.axisBand): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const v = readPeak(keepBand(trendOdds(rows, i), band));
    // 指せなかったコマの扱いは横と同じ（真ん中へ戻さず、前の答えを引き継ぐ）。
    out.push(Number.isNaN(v) ? (out.length ? out[out.length - 1] : 0.5) : v);
  }
  return out;
}

/** 縦の軸の枠の置き所。枠を決める段（`planFromRaw`）は横とまったく同じものを使う。 */
export function planReframeVertical(rows: ColumnStat[], options: Partial<ReframeOptions> = {}): ReframePlan {
  const opt = { ...VERTICAL_REFRAME, ...options };
  return planFromRaw(
    rawTargetsVertical(rows, opt.axisBand),
    rows.map((r) => r.time),
    opt,
  );
}

/** 中央値。ならすのに平均を使わない理由は上の注に書いた。 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * 列の並びから、コマごとの**生の位置**を出す。
 *
 * ここだけ差し替えれば別の手を試せるように、枠を決める側とは分けてある。
 */
export function rawTargets(cols: ColumnStat[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < cols.length; i += 1) {
    const u = readPeak(spatialOdds(cols, i));
    // 指せなかったコマ（真っ黒など）は真ん中を答えにしない——**前の答えを引き継ぐ**。
    // 真ん中を返すと、黒へ落ちるフェードのあいだだけ枠が中央へ寄ってしまう。
    out.push(Number.isNaN(u) ? (out.length ? out[out.length - 1] : 0.5) : u);
  }
  return out;
}

/** 枠の置き所を決める。 */
export function planReframe(cols: ColumnStat[], options: Partial<ReframeOptions> = {}): ReframePlan {
  return planFromRaw(
    rawTargets(cols),
    cols.map((c) => c.time),
    options,
  );
}

/**
 * **生の位置の列から**枠を決める。`planReframe` の中身はこちら。
 *
 * 列（`ColumnStat`）を経由しない入口を分けてあるのは、**門を検算するため**。
 * 門が壊れるのは「ならし後の的が**ごくわずか**違ったとき、行き先が変わる」形なので、
 * 合成したコマからでは試せない——**コマは画素に量子化されている**ので、
 * 1 画素（0.008）より細かい差が作れない。2026-09-25（3 回目）に
 * 0.0036 の差を入れようとして、まったく同じコマが 2 枚できた。
 * **検算したい層より粗い入口からは、その層は検算できない。**
 */
export function planFromRaw(
  raw: number[],
  times: ArrayLike<number>,
  options: Partial<ReframeOptions> = {},
): ReframePlan {
  const opt = { ...DEFAULT_REFRAME, ...options };
  const frames: ReframeFrame[] = [];
  if (!raw.length) return { frames, options: opt, travel: 0, gate: { resets: 0, nearResets: 0 } };

  const half = opt.cropWidth / 2;
  const lo = half;
  const hi = 1 - half;
  // 窓が画面より広ければ動かしようが無い（切り出す意味が無い）ので、真ん中で止める。
  if (lo >= hi) {
    for (let i = 0; i < raw.length; i += 1) {
      frames.push({ time: times[i], center: 0.5, raw: 0.5, target: 0.5, moving: false });
    }
    return { frames, options: opt, travel: 0, gate: { resets: 0, nearResets: 0 } };
  }

  // コマの速さは素材から読む（つまみは秒で書いてあるので、ここでコマ数へ直す）。
  const span = raw.length > 1 ? times[raw.length - 1] - times[0] : 0;
  const fps = span > 0 ? (raw.length - 1) / span : 30;
  const smoothFrames = Math.max(1, Math.round(opt.smooth * fps));

  // 中央値でならす。窓は前後へ同じだけ広げる（片側だけだと半窓ぶん遅れる）。
  const targets: number[] = [];
  const k = smoothFrames >> 1;
  for (let i = 0; i < raw.length; i += 1) {
    const from = Math.max(0, i - k);
    const to = Math.min(raw.length - 1, i + k);
    targets.push(median(raw.slice(from, to + 1)));
  }

  const settleFrames = Math.max(1, Math.round(opt.settle * fps));
  const step = opt.maxSpeed / fps;
  // 動き出したあと「どこまで寄せたら止めるか」。deadband の 4 分の 1 まで寄せ切る。
  // ここを deadband と同じにすると、枠は縁に触れた所で止まるので**いつも少し遅れる**。
  const stopBand = opt.deadband * 0.25;

  let center = 0.5;
  if (opt.leadIn) {
    const lead = targets.slice(0, Math.min(targets.length, Math.max(1, settleFrames)));
    center = median(lead);
  }
  center = Math.min(hi, Math.max(lo, center));

  // `release` の捨てる線。入る線（`deadband`）より内側に置くので、
  // 縁をまたいだ 1 コマでは貯めが消えない。
  const releaseAt = opt.deadband * opt.gateRelease;

  let outside = 0;
  let moving = false;
  let travel = 0;
  let resets = 0;
  let nearResets = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const want = Math.min(hi, Math.max(lo, targets[i]));
    const err = want - center;
    const dist = Math.abs(err);
    const before = outside;

    if (opt.gate === 'soft') {
      // 状態を持たないので、貯めの話が丸ごと消える。
      // **どの 1 コマも「動き出すか」を決めない**——決めるのは動く量だけ。
      outside = 0;
    } else if (opt.gate === 'ramp') {
      // 縁ちょうどで 0 なので、縁に居るあいだは**貯めも減りもしない**。
      // 深く外に居るコマほど速く貯まり、深く内に居るコマほど速く抜ける。
      // 1 コマが動かせるのは高々 1 ぶんなので、**どの 1 コマも門を独りで決められない。**
      // 0 で割らない。死に帯も目盛りも 0 を渡せる形なので、
      // **つまみを端まで回したら NaN が枠に流れ込む**（画面からは 0.005 までしか回せないが、
      // 呼ぶ側は数字を直に渡せる）。極小で止めれば「縁の外はすぐ満額」と同じ意味になる。
      const rampSpan = Math.max(1e-6, opt.deadband * opt.gateRamp);
      const score = (dist - opt.deadband) / rampSpan;
      outside = Math.max(0, outside + Math.max(-1, Math.min(1, score)));
    } else if (opt.gate === 'release') {
      if (dist >= opt.deadband) outside += 1;
      else if (dist < releaseAt) outside = 0;
      // あいだ（捨てる線と入る線のあいだ）は据え置き。
    } else {
      if (dist >= opt.deadband) outside += 1;
      else outside = 0;
    }
    // **捨てた回数は、門の形に依らず同じ意味で数える**（形どうしを並べるため）。
    // `ramp` は少しずつ減るので、「貯めが半分より下へ落ちた」を 1 回と読む。
    if (before >= 1 && outside < before / 2) {
      resets += 1;
      if (before >= settleFrames / 2) nearResets += 1;
    }
    if (outside >= settleFrames) moving = true;
    // 寄せ切ったら止める。止める線を入れる側より内側にしてあるのがヒステリシス。
    if (moving && Math.abs(err) <= stopBand) moving = false;

    let next = center;
    if (opt.gate === 'soft') {
      // 縁からはみ出したぶんだけ寄せる。縁の内側では 0 なので、
      // 止まっている被写体には反応しない（そこは `step` と同じ）。
      // 代わりに**動き続ける被写体には deadband ぶん遅れて付いていく**形になる。
      const over = Math.max(0, dist - opt.deadband);
      const move = Math.sign(err) * Math.min(step, over);
      next = Math.min(hi, Math.max(lo, center + move));
      moving = move !== 0;
    } else if (moving) {
      next = center + Math.max(-step, Math.min(step, err));
      next = Math.min(hi, Math.max(lo, next));
    }
    travel += Math.abs(next - center);
    frames.push({ time: times[i], center: next, raw: raw[i], target: targets[i], moving });
    center = next;
  }

  return { frames, options: opt, travel, gate: { resets, nearResets } };
}

/** 枠を、クロップの矩形（0〜1 の左端と幅）として読む。本体のクロップへ渡す形。 */
export function toCropRects(plan: ReframePlan): { time: number; x: number; width: number }[] {
  const w = plan.options.cropWidth;
  return plan.frames.map((f) => ({ time: f.time, x: f.center - w / 2, width: w }));
}

/** 列の数。呼ぶ側が格子の細かさを知りたいときのため。 */
export { COLUMNS };
