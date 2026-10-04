/**
 * 枠の置き所を採点する物差し。
 *
 * **`bench.mjs` と `uitest.mjs` が同じ関数を呼ぶために切り出してある**
 * （`scene-cut/score.mjs` と同じ立場）。画面の確認でいちばん見たいのは
 * 「画面が出した枠が、コマンドラインの枠と同じか」なので、
 * **採点する側が 2 つあると、食い違いが判定の違いなのか採点の違いなのか読めない。**
 *
 * 入口はどれも「枠の中心の列（`centers`）と時刻の列（`times`）」だけを取る。
 * 計画（`ReframePlan`）を取らないのは、比べる相手（ずっと真ん中）や
 * 画面から読み出した列も、同じ物差しに載せたいため。
 */

import { leadSubjectAt } from '../fixtures/scenes.mjs';

export const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * 被写体を枠に入れられているか。
 *
 * **「入れた」は被写体の中心が窓に入っていること。** 被写体（横幅 40%）は
 * 窓（31.6%）より広いので、どこに置いても全身は入らない——だから中心で数える。
 * 画面の外に居るコマは追いようが無いので数えない。
 *
 * `axis` が `v` なら縦の軸（最初から縦の素材から 1:1 を切る側）。`cropWidth` には
 * **窓の高さ**を渡す。**縦の窓は横の 1.8 倍広いので、入れた率を軸をまたいで並べないこと。**
 */
export function scoreFollow(fixture, times, centers, cropWidth, aspect = 'landscape', axis = 'u') {
  const half = cropWidth / 2;
  const errors = [];
  let inside = 0;
  let counted = 0;
  for (let i = 0; i < centers.length; i += 1) {
    const truth = leadSubjectAt(fixture, times[i], aspect);
    if (!truth) continue;
    // 軸は**正解の読み方だけ**を変える（2026-10-04）。入れた率も泳ぎも、
    // 縦の軸では「窓の高さ」で同じ式を回すだけなので、物差しを 2 つに割らない。
    const p = axis === 'v' ? truth.v : truth.u;
    if (p < 0 || p > 1) continue;
    counted += 1;
    const err = Math.abs(p - centers[i]);
    errors.push(err);
    if (err < half) inside += 1;
  }
  return { inside: counted ? (inside / counted) * 100 : null, error: median(errors), counted };
}

/**
 * 枠が動いたひと続き（run）を、始まった時刻つきで取り出す。
 *
 * コマ単位ではなく run 単位で持つのは、**カット直後の組み直しを丸ごと外す**ため
 * （下の `scoreSwim` の注を参照）。
 *
 * `cuts` を渡すと、**カットをまたぐ run はそこで切る**。
 * 2026-09-25（3 回目）に足した。理由は下の `scoreSwim` の注。
 */
export function movingRuns(times, centers, cuts = []) {
  const runs = [];
  let open = null;
  const close = () => {
    if (open) runs.push(open);
    open = null;
  };
  for (let i = 1; i < centers.length; i += 1) {
    const moved = Math.abs(centers[i] - centers[i - 1]);
    if (moved > 0) {
      // このコマでカットをまたいだなら、ここから先は別の run として数える。
      if (open && cuts.some((c) => c > times[i - 1] && c <= times[i])) close();
      if (!open) open = { start: times[i - 1], travel: 0 };
      open.travel += moved;
    } else {
      close();
    }
  }
  close();
  return runs;
}

/**
 * **カットの直後に枠を置き直すのは正しい振る舞い**なので、泳ぎから外す。
 *
 * 場面が変われば構図も変わるから、そこで枠が動くのは「泳いだ」ではなく「組み直した」。
 * 外さずに数えると、カットの多い素材ほど悪く見えて、**直すべきでない所を直しにいく**。
 *
 * ただし「カットから 0.6 秒のあいだのコマを外す」では足りない（2026-09-24・3 回目に測った）。
 * 寄せの上限は 0.22/s なので端から端まで組み直すのに 3 秒以上かかり、
 * コマで外すと組み直しの大半が窓の外に落ちる。なので外すのは**ひと続きごと**で、
 * **その始まりがカットから 0.6 秒以内なら、その run は丸ごと組み直し**とみなす。
 *
 * ## run をカットで切るようにした（2026-09-25・3 回目）
 *
 * 「始まりで決める」だけだと、**枠が止まらずに動き続ける門では丸ごと裏返る。**
 * カットの手前から枠がわずかに動いていると run はそこから開いているので、
 * カットの直後の組み直しまで含めて **1 本の「泳ぎ」**として数えてしまう。
 * 実際 `cuts-plain` は、動いた量の合計が 0.078 → 0.071 と**減っている**のに、
 * 泳ぎだけが 0.000 → 0.071 に化けた。
 *
 * **これは門の出来ではなく物差しの穴**（「枠は止まったり動いたりする」を
 * 暗黙に仮定していた）。なので run をカットで切って、
 * **カットから先は別の run**として始まりを測り直す。
 * 切っても、貯めて動き出す門の数字は 1 つも動かない（あちらの run は
 * もともとカットをまたがない）。**物差しを直したら、前の答えが動かないことを確かめること。**
 */
export const AFTER_CUT = 0.6;

/**
 * コマの時刻の**丸めしろ**（秒）。
 *
 * 動き出しがカットのすぐ手前のコマに乗ったとき、`c - 1/fps` の線で拾いそこねる。
 * デコードした時刻はミリ秒に丸めてあり、速さも素材から読んだ見積もり
 * （15fps の素材が 15.0015fps と出る）なので、**ちょうど 1 コマぶんが
 * きっかり 1 コマぶんにならない。** 実際 `cuts-plain` は
 * 2.9330 対 2.9334 と **0.0004 秒**足りずに落ちていた。
 * 判定の話ではなく時刻の丸めの話なので、そのぶんだけ緩める。
 */
const TIME_EPS = 1e-3;

export function scoreSwim(times, centers, cuts, fps) {
  const seconds = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const runs = movingRuns(times, centers, cuts);
  const isRecompose = (r) => cuts.some((c) => r.start >= c - 1 / fps - TIME_EPS && r.start < c + AFTER_CUT);
  const wander = runs.filter((r) => !isRecompose(r));
  const sum = (rs) => rs.reduce((a, r) => a + r.travel, 0);
  return {
    swim: seconds > 0 ? sum(wander) / seconds : 0,
    wanders: wander.length,
    recompose: seconds > 0 ? sum(runs.filter(isRecompose)) / seconds : 0,
    range: centers.length ? Math.max(...centers) - Math.min(...centers) : 0,
  };
}

/** カットを分けずに数えた泳ぎ（被写体の**居る**素材の表で使う。組み直しも動きのうち）。 */
export function totalSwim(times, centers) {
  const seconds = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  let travel = 0;
  for (let i = 1; i < centers.length; i += 1) travel += Math.abs(centers[i] - centers[i - 1]);
  return seconds > 0 ? travel / seconds : 0;
}
