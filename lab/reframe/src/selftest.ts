/**
 * 合成したコマで、計算そのものが正しいかを確かめる。
 *
 * 素材（`make-frames.mjs`）は使わない。あちらは 1 本 7MB を毎回その場で作るので、
 * **手を入れるたびに走らせるもの**の中に置くと重すぎる。
 * ここで見るのは「計算が合っているか」だけで、効きは `npm run lab:reframe` が見る。
 *
 * 検算を書くときは、**わざと壊して FAIL することまで確かめる**
 * （2026-09-23・2 回目に、止まった素材では素通りする検査を書いた）。
 */

import {
  COLUMNS,
  FULL_BAND,
  type FrameLike,
  type Weights,
  columnCenter,
  contrast,
  diffLuma,
  keepBand,
  readCentroid,
  readPeak,
  spatialOdds,
  summarizeColumns,
  summarizeRows,
  trendOdds,
} from './columns.ts';
import {
  DEFAULT_REFRAME,
  SQUARE_CROP_V,
  VERTICAL_REFRAME,
  planFromRaw,
  planReframe,
  planReframeVertical,
  rawTargets,
  rawTargetsVertical,
  summarizeForReframe,
  summarizeForReframeVertical,
  toCropRects,
} from './reframe.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * 塗り分けたコマを作る。`paint(u, v)` が 0〜255 の RGB を返す。
 * 画素の**真ん中**で引くので、`summarizeColumns` の畳み方と辻褄が合う。
 */
function makeFrame(width: number, height: number, paint: (u: number, v: number) => [number, number, number]): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint((x + 0.5) / width, (y + 0.5) / height);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** 背景の上に、横位置 `at`・半幅 `rx` の柱を 1 本立てたコマ。 */
function withBar(at: number, rx = 0.08, bg: [number, number, number] = [40, 60, 90]): FrameLike {
  return makeFrame(128, 72, (u) => (Math.abs(u - at) < rx ? [240, 140, 40] : bg));
}

/** コマの列から `ColumnStat[]` を作る（秒は等間隔）。 */
function clipOf(frames: FrameLike[], fps = 15) {
  const times = frames.map((_, i) => i / fps);
  return summarizeForReframe(frames, times);
}

export function runSelfTest(): TestResult[] {
  const out: TestResult[] = [];
  const push = (name: string, ok: boolean, detail?: string) => out.push({ name, ok, detail });

  // --- 列へ畳む ---

  {
    // 左半分だけ白。列の前半は 1・後半は 0 になるはず。
    const f = makeFrame(64, 16, (u) => (u < 0.5 ? [255, 255, 255] : [0, 0, 0]));
    const c = summarizeColumns(f, 0);
    push(
      '列は左右を取り違えない（左半分が白なら前半の列だけ立つ）',
      c.luma[0] > 0.99 && c.luma[COLUMNS - 1] < 0.01,
      `列0 ${c.luma[0].toFixed(3)} / 列${COLUMNS - 1} ${c.luma[COLUMNS - 1].toFixed(3)}`,
    );
  }
  {
    // 上半分だけ白。**帯を絞れば結果が変わる**ことを見る（つまみが黙って無視されないか）。
    const f = makeFrame(64, 16, (_u, v) => (v < 0.5 ? [255, 255, 255] : [0, 0, 0]));
    const all = summarizeColumns(f, 0, FULL_BAND).luma[0];
    const lower = summarizeColumns(f, 0, { from: 0.6, to: 1 }).luma[0];
    const upper = summarizeColumns(f, 0, { from: 0, to: 0.4 }).luma[0];
    push(
      '見る帯のつまみが効く（上半分だけ白いコマを、上から見るか下から見るかで変わる）',
      Math.abs(all - 0.5) < 0.01 && upper > 0.99 && lower < 0.01,
      `全部 ${all.toFixed(3)} / 上 ${upper.toFixed(3)} / 下 ${lower.toFixed(3)}`,
    );
    const flat = summarizeColumns(f, 0, { from: 0.7, to: 0.3 });
    push(
      '帯が潰れていても列が 0 にならない（0 行で割らない）',
      Number.isFinite(flat.luma[0]),
      `潰れた帯の列0 ${flat.luma[0]}`,
    );
  }
  {
    const empty = summarizeColumns({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, 1.5);
    push('大きさ 0 のコマでも落ちない', empty.luma.length === COLUMNS && empty.time === 1.5);
  }

  // --- 被写体を指す ---

  {
    const cols = clipOf([withBar(0.75)]);
    const u = readPeak(spatialOdds(cols, 0));
    push('浮いている柱の位置を指す', Math.abs(u - 0.75) < 0.03, `指した ${u.toFixed(3)}（正解 0.75）`);
  }
  {
    // **重心は 2 つあると間を指す**。probe で測った性質を、合成データで固定しておく。
    const cols = clipOf([makeFrame(128, 72, (u) => (Math.abs(u - 0.2) < 0.06 || Math.abs(u - 0.8) < 0.06 ? [240, 140, 40] : [40, 60, 90]))]);
    const w = spatialOdds(cols, 0);
    const mid = readCentroid(w);
    const peak = readPeak(w);
    push(
      '柱が 2 本あると、重心は間を指し、山はどちらかを指す',
      Math.abs(mid - 0.5) < 0.05 && Math.min(Math.abs(peak - 0.2), Math.abs(peak - 0.8)) < 0.05,
      `重心 ${mid.toFixed(3)} / 山 ${peak.toFixed(3)}`,
    );
  }
  {
    // 一様なコマでは指す手が答えを持たない。ここで真ん中を返すと、
    // 「何も無い」と「真ん中に居る」が同じ顔になる。
    const cols = clipOf([makeFrame(64, 16, () => [70, 70, 70])]);
    const w = spatialOdds(cols, 0);
    push('一様なコマでは位置を答えない（NaN）', Number.isNaN(readPeak(w)), `尖り ${contrast(w).toFixed(4)}`);
  }
  {
    // 引き算の手は**動いた縁を 2 本**返すので、山は中心からずれる（probe の 0.141 の正体）。
    const cols = clipOf([withBar(0.4), withBar(0.5)]);
    const w = diffLuma(cols, 1);
    const mid = readCentroid(w);
    const peak = readPeak(w, 2);
    push(
      '引き算は前と後の縁を 2 つ返す（重心は真ん中・山は端）',
      Math.abs(mid - 0.45) < 0.04 && Math.abs(peak - 0.45) > 0.03,
      `重心 ${mid.toFixed(3)} / 山 ${peak.toFixed(3)}`,
    );
  }
  {
    const w: Weights = new Float64Array(COLUMNS);
    w[10] = 1;
    push('尖りは、山と真ん中の列の差', Math.abs(contrast(w) - 1) < 1e-9, `${contrast(w)}`);
    push('列の真ん中を返す', Math.abs(columnCenter(0) - 0.5 / COLUMNS) < 1e-9);
  }

  // --- 枠を決める ---

  {
    // 動かない柱。**1 コマも動かない**のが正解（頭の置き所で決まり切る）。
    const frames = Array.from({ length: 45 }, () => withBar(0.72));
    const plan = planReframe(clipOf(frames));
    push(
      '止まっている被写体では枠が 1 度も動かない',
      plan.travel < 1e-9 && Math.abs(plan.frames[0].center - 0.72) < 0.03,
      `動いた量 ${plan.travel.toFixed(4)} / 置き所 ${plan.frames[0].center.toFixed(3)}`,
    );
  }
  {
    // 端まで動く柱。枠は追いつき、**窓が画面からはみ出さない**。
    const frames = Array.from({ length: 60 }, (_v, i) => withBar(0.2 + (0.7 * i) / 59));
    const plan = planReframe(clipOf(frames));
    const half = DEFAULT_REFRAME.cropWidth / 2;
    const last = plan.frames[plan.frames.length - 1];
    const inRange = plan.frames.every((f) => f.center >= half - 1e-9 && f.center <= 1 - half + 1e-9);
    push(
      '動く被写体を追い、窓は画面からはみ出さない',
      inRange && Math.abs(last.center - Math.min(0.9, 1 - half)) < 0.06,
      `終わりの中心 ${last.center.toFixed(3)}（上限 ${(1 - half).toFixed(3)}）`,
    );
  }
  {
    // 小さく揺れるだけの被写体に**枠が付き合わない**。
    // これが無いと出来上がりが手ぶれ映像になる。
    //
    // **「1 度も動かない」では書けない**（2026-09-25・3 回目に書き直した）。
    // 門を `soft` にして死に帯を 0.03 へ詰めてから、枠は最初に 1 度だけ
    // 揺れの真ん中へ寄って、そこで止まるようになった（0.518 → 0.512）。
    // 前の門は `leadIn` が置いた所に居座るので合計 0 だっただけで、
    // **寄って止まるほうがむしろ正しい。** 見るのは 2 つ:
    // 揺れに合わせて往復していないこと（後半は 1 コマも動かない）と、
    // 動いた合計が揺れの幅より小さいこと。
    const wobble = 0.02;
    const frames = Array.from({ length: 60 }, (_v, i) => withBar(0.5 + (i % 2 ? wobble : -wobble)));
    const plan = planReframe(clipOf(frames));
    const late = plan.frames.slice(30);
    const lateTravel = late.slice(1).reduce((a, f, i) => a + Math.abs(f.center - late[i].center), 0);
    push(
      '小さく揺れるだけの被写体に枠が付き合わない（寄って止まる）',
      lateTravel < 1e-9 && plan.travel < wobble * 2,
      `合計 ${plan.travel.toFixed(4)} / 後半 ${lateTravel.toFixed(4)}（揺れの幅 ${(wobble * 2).toFixed(2)}）`,
    );
  }
  {
    // 寄せの上限が効いているか。1 コマで飛ばないこと。
    const frames = [...Array.from({ length: 30 }, () => withBar(0.2)), ...Array.from({ length: 60 }, () => withBar(0.8))];
    const cols = clipOf(frames);
    const plan = planReframe(cols, { maxSpeed: 0.2 });
    const jump = Math.max(...plan.frames.slice(1).map((f, i) => Math.abs(f.center - plan.frames[i].center)));
    push(
      '寄せの上限を超えて 1 コマで飛ばない',
      jump <= 0.2 / 15 + 1e-9,
      `いちばん大きい 1 コマの動き ${jump.toFixed(4)}（上限 ${(0.2 / 15).toFixed(4)}）`,
    );
    // 上限を上げれば速く寄る。**つまみが黙って無視されていないか**まで見る。
    //
    // 寄り切りの線は、**死に帯より内側には置けない**（2026-09-25・3 回目に直した）。
    // `soft` は縁の内側で 1 コマも動かないので、止まる所は必ず死に帯ぶん手前になる。
    // 前の門は貯めて動き出したあと `stopBand` まで詰めるので 0.02 で書けていたが、
    // **その「詰め切る」こそが焼き直しで行き先を変えていた**（下の検査を参照）。
    const fast = planReframe(cols, { maxSpeed: 1.0 });
    const settled = DEFAULT_REFRAME.deadband + 0.01;
    const reach = (p: typeof plan) => p.frames.findIndex((f) => Math.abs(f.center - 0.8) < settled);
    push(
      '寄せの上限を上げると、速く寄り切る',
      reach(fast) > 0 && reach(fast) < reach(plan),
      `0.2 で ${reach(plan)} コマ / 1.0 で ${reach(fast)} コマ（寄り切りの線 ${settled.toFixed(3)}）`,
    );
  }
  {
    // 指せないコマ（真っ黒）が挟まっても、**生の位置が**真ん中へ帰らない。
    //
    // ここを `planReframe` の中心で見ると素通りする（実際に 1 度素通りした）。
    // ならしが中央値なので、15 コマの窓に 2 コマの外れ値が入っても消えてしまう。
    // **見るべき層を間違えた検査は、壊しても落ちない。**
    const black = makeFrame(128, 72, () => [0, 0, 0]);
    const frames = [...Array.from({ length: 30 }, () => withBar(0.8)), black, black, ...Array.from({ length: 10 }, () => withBar(0.8))];
    const raw = rawTargets(clipOf(frames));
    push(
      '指せないコマでは前の答えを引き継ぐ（真ん中へ帰らない）',
      Math.abs(raw[30] - 0.8) < 0.03 && Math.abs(raw[31] - 0.8) < 0.03,
      `黒いコマでの生の位置 ${raw[30].toFixed(3)} / ${raw[31].toFixed(3)}`,
    );
    const head = rawTargets(clipOf([black, black]));
    push('頭から指せなくても落ちない', head.every((v) => Number.isFinite(v)), `${head[0]}`);
  }
  {
    // 計画が持つ 3 つの層（`raw` / `target` / `center`）が、**別々の値である**ことを見る。
    //
    // 2026-09-25 に画面を作るまで、計画は生の位置を返していなかった
    // （`target` にならしたあとの値が入っていて、注だけが「生の位置」と言っていた）。
    // **画面に 2 本描こうとして初めて、1 本しか無いことに気づいた。**
    // ここが同じ値になっていたら、画面は「荒れ」と「遅れ」を切り分けられない。
    // 1 コマだけ柱が飛ぶ素材。**中央値はこの 1 点を落とす**ので、
    // `raw` は飛び、`target` は動かない——層が分かれていなければ、この差は出ない。
    const frames = [...Array.from({ length: 20 }, () => withBar(0.8)), withBar(0.2), ...Array.from({ length: 20 }, () => withBar(0.8))];
    const plan = planReframe(clipOf(frames));
    const raw = rawTargets(clipOf(frames));
    push(
      '計画は、生の位置とならしたあとを別々に持つ',
      plan.frames.every((f, i) => Math.abs(f.raw - raw[i]) < 1e-12) &&
        plan.frames.some((f) => Math.abs(f.raw - f.target) > 1e-9),
      `飛んだコマで 生 ${plan.frames[20].raw.toFixed(3)} / ならし ${plan.frames[20].target.toFixed(3)} / 枠 ${plan.frames[20].center.toFixed(3)}`,
    );
  }
  {
    // **上下の帯を外しているか**を、枠の側から見る。
    //
    // 縦に一様な素材（`withBar`）では、帯を外しても外さなくても同じ答えになるので、
    // つまみを黙って無視する作りが素通りする（実際に 1 度素通りした）。
    // 画面のまん中に止まった被写体を置き、**上の帯の中だけで柱が動く**素材で見る。
    const captioned = (capAt: number) =>
      makeFrame(128, 72, (u, v) => {
        if (v < 0.12) return Math.abs(u - capAt) < 0.06 ? [255, 255, 255] : [10, 10, 10];
        return Math.abs(u - 0.5) < 0.08 ? [240, 140, 40] : [40, 60, 90];
      });
    const frames = [captioned(0.9)];
    const times = [0];
    // 字幕の居る列（0.9 ＝ 28 列目）で、帯を外したときと全部見たときの重みを比べる。
    // **枠の動きで見ると素通りする**——真ん中の被写体が強いので、
    // 引っぱられていても山は動かない。見るのは重みそのもの。
    const at = Math.floor(0.9 * COLUMNS);
    const banded = spatialOdds(summarizeForReframe(frames, times), 0)[at];
    const whole = spatialOdds(summarizeForReframe(frames, times, { rowBand: FULL_BAND }), 0)[at];
    push(
      '上下の帯を外すと、字幕の居る列が浮かなくなる',
      whole > banded * 3,
      `帯を外して ${banded.toFixed(4)} / 全部見て ${whole.toFixed(4)}`,
    );
  }
  {
    // **門が増幅器になっていないか。** 2026-09-25（3 回目）のいちばんの収穫。
    //
    // 同じ動画を焼き直すと枠の置き所が振れる、その根はここにある——
    // ならしたあとの的が**ごくわずか**違うだけで、貯めて動き出す門は
    // 「動き出す / 動かない」に化け、枠ぜんたいが死に帯ぶん別の所へ行く。
    // 0.001 の差が 0.059 になる（**59 倍**）。`soft` は 1 倍。
    //
    // **合成したコマからは書けない検査**（コマは画素に量子化されていて、
    // 1 画素 0.008 より細かい差が作れない）。なので `planFromRaw` を直に叩く。
    const n = 120;
    const times = Array.from({ length: n }, (_v, i) => i / 15);
    // 30 コマ 0.4 に居て、そのあと**死に帯の縁ちょうど**へ移って居続ける的。
    const atEdge = (offset: number) => Array.from({ length: n }, (_v, i) => (i < 30 ? 0.4 : 0.4 + offset));
    const eps = 0.0005;
    const endGap = (options: Parameters<typeof planFromRaw>[2]) => {
      const band = { ...DEFAULT_REFRAME, ...options }.deadband;
      const a = planFromRaw(atEdge(band - eps), times, options).frames;
      const b = planFromRaw(atEdge(band + eps), times, options).frames;
      return Math.abs(a[n - 1].center - b[n - 1].center);
    };
    const now = endGap({});
    const latched = endGap({ gate: 'step', deadband: 0.06 });
    push(
      '的のごくわずかな差が、枠の行き先に化けない（既定の門）',
      now <= eps * 2 * 2,
      `的の差 ${(eps * 2).toFixed(4)} → 枠の差 ${now.toFixed(4)}（${(now / (eps * 2)).toFixed(0)} 倍）`,
    );
    // **比べる相手を置く。** これが無いと「1 倍」が良いのかどうかが読めないし、
    // 既定を貯める門へ戻したときに、この検査が黙って通ってしまう。
    push(
      '貯めて動き出す門では、同じ差が桁ちがいに化ける（比べる相手）',
      latched > eps * 2 * 20,
      `的の差 ${(eps * 2).toFixed(4)} → 枠の差 ${latched.toFixed(4)}（${(latched / (eps * 2)).toFixed(0)} 倍）`,
    );
  }
  {
    // 死に帯の内側では 1 コマも動かない（`soft` でもそこは変わっていない）。
    const times = Array.from({ length: 60 }, (_v, i) => i / 15);
    const inside = DEFAULT_REFRAME.deadband * 0.9;
    const plan = planFromRaw(
      times.map((_t, i) => (i < 20 ? 0.5 : 0.5 + inside)),
      times,
    );
    push(
      '死に帯の内側へ的が動いても、枠は動かない',
      plan.travel < 1e-9,
      `的の動き ${inside.toFixed(4)}（死に帯 ${DEFAULT_REFRAME.deadband}）/ 動いた量 ${plan.travel.toFixed(4)}`,
    );
  }
  {
    push('コマが 1 枚も無くても落ちない', planReframe([]).frames.length === 0);
    const one = planReframe(clipOf([withBar(0.8)]));
    push('コマが 1 枚だけでも落ちない', one.frames.length === 1 && Number.isFinite(one.frames[0].center));
  }
  {
    // 窓が画面より広ければ動かしようが無い。黙って端へ寄せず、真ん中で止める。
    const plan = planReframe(clipOf([withBar(0.8), withBar(0.2)]), { cropWidth: 1.4 });
    push(
      '窓が画面より広いときは真ん中で止まる',
      plan.travel === 0 && plan.frames.every((f) => f.center === 0.5),
      `中心 ${plan.frames.map((f) => f.center).join(' / ')}`,
    );
  }
  {
    const plan = planReframe(clipOf([withBar(0.72)]));
    const [rect] = toCropRects(plan);
    push(
      'クロップの矩形は、中心と幅から素直に出る',
      Math.abs(rect.x + rect.width / 2 - plan.frames[0].center) < 1e-9 && Math.abs(rect.width - DEFAULT_REFRAME.cropWidth) < 1e-9,
      `x ${rect.x.toFixed(3)} 幅 ${rect.width.toFixed(3)}`,
    );
  }

  /* ---------------------------------------------------------------------
   * 縦の軸（2026-10-04）
   * ------------------------------------------------------------------- */

  /** 横に 1 本の帯を置いたコマ。縦の軸での「被写体」。 */
  const withRow = (at: number, half = 0.08) =>
    makeFrame(72, 128, (_u, v) => (Math.abs(v - at) < half ? [240, 140, 40] : [40, 60, 90]));

  {
    // 畳む向きが本当に入れ替わっているか。**同じコマを両方で畳んで比べる**——
    // 片方を呼び忘れても落ちない作りなので、向きを取り違えたまま通る道がある。
    const f = withRow(0.75);
    const rows = summarizeRows(f, 0);
    const cols = summarizeColumns(f, 0);
    const at = Math.floor(0.75 * COLUMNS);
    push(
      '行へ畳むと、帯の居る高さだけが明るい',
      rows.luma[at] > rows.luma[0] * 1.5,
      `高さ ${at} ${rows.luma[at].toFixed(3)} / 上端 ${rows.luma[0].toFixed(3)}`,
    );
    push(
      '同じコマを列へ畳むと、横には差が出ない（帯は横いっぱいなので）',
      Math.abs(cols.luma[0] - cols.luma[COLUMNS - 1]) < 1e-9,
      `列0 ${cols.luma[0].toFixed(4)} / 列${COLUMNS - 1} ${cols.luma[COLUMNS - 1].toFixed(4)}`,
    );
  }
  {
    // **階調を外す手が、まっすぐな階調を消しているか。**
    // 外さない手（`spatialOdds`）が階調の端を指すことまで併せて見る——
    // そこを見ないと「`trendOdds` のほうが良い」と言える根拠が無い。
    const ramp = makeFrame(72, 128, (_u, v) => [30 + 200 * v, 30 + 200 * v, 30 + 200 * v]);
    const rows = [summarizeRows(ramp, 0)];
    const t = trendOdds(rows, 0);
    const sp = spatialOdds(rows, 0);
    let tMax = 0;
    for (let c = 0; c < COLUMNS; c += 1) if (t[c] > tMax) tMax = t[c];
    push(
      'まっすぐな階調は、直線を外すとほぼ消える',
      tMax < 0.01,
      `階調を外した最大 ${tMax.toFixed(4)} / 外さない最大 ${Math.max(...sp).toFixed(4)}`,
    );
    push(
      '外さない手は、階調の端を指してしまう（縦の軸で `spatial` を使わない理由）',
      readPeak(sp) > 0.8 || readPeak(sp) < 0.2,
      `指した所 ${readPeak(sp).toFixed(3)}`,
    );
  }
  {
    // **階調の上に乗せた被写体を、ちゃんと拾えるか。**
    // 上の検査は「階調が消える」だけなので、消しすぎていても通ってしまう。
    const rampWithRow = makeFrame(72, 128, (_u, v) =>
      Math.abs(v - 0.65) < 0.08 ? [240, 140, 40] : [30 + 200 * v, 30 + 200 * v, 30 + 200 * v],
    );
    const rows = [summarizeRows(rampWithRow, 0)];
    push(
      '階調の上に乗せた被写体は、直線を外しても残る',
      Math.abs(readPeak(trendOdds(rows, 0)) - 0.65) < 0.05,
      `階調を外して ${readPeak(trendOdds(rows, 0)).toFixed(3)} / 外さず ${readPeak(spatialOdds(rows, 0)).toFixed(3)}（正解 0.650）`,
    );
  }
  {
    // **軸の上の帯を締め出しているか。** 0 にするのであって小さくするのではない、
    // というのが要点なので、締め出した所がきっかり 0 であることまで見る。
    const w: Weights = new Float64Array(COLUMNS);
    for (let c = 0; c < COLUMNS; c += 1) w[c] = 1;
    const kept = keepBand(w, { from: 0.15, to: 0.85 });
    const outside = Array.from(kept).filter((_v, c) => columnCenter(c) < 0.15 || columnCenter(c) > 0.85);
    const inside = Array.from(kept).filter((_v, c) => columnCenter(c) >= 0.15 && columnCenter(c) <= 0.85);
    push(
      '締め出した帯はきっかり 0 になり、中は 1 も減らない',
      outside.every((v) => v === 0) && inside.every((v) => v === 1) && outside.length > 0,
      `外 ${outside.length} 個 / 中 ${inside.length} 個`,
    );
  }
  {
    // **字幕の帯を締め出すと、答えが被写体へ戻るか。**
    // 上下に明るい帯（字幕）、まん中より少し上に被写体。
    const captioned = makeFrame(72, 128, (_u, v) => {
      if (v < 0.08 || v > 0.92) return [255, 255, 255];
      // 被写体の色は**3 色とも背景から離す**。最初に [150,110,70] で書いたら、
      // 緑が背景（60）とほぼ同じで、3 色を平均した隔たりが背景のほうが大きくなった
      // ——**検査が落ちたのは実装ではなく素材のほう**だった。
      return Math.abs(v - 0.4) < 0.08 ? [240, 180, 60] : [40, 60, 90];
    });
    const rows = [summarizeRows(captioned, 0)];
    const whole = readPeak(trendOdds(rows, 0));
    const banded = readPeak(keepBand(trendOdds(rows, 0), { from: 0.15, to: 0.85 }));
    push(
      '字幕の帯を締め出すと、指す所が字幕から被写体へ戻る',
      Math.abs(banded - 0.4) < 0.06 && Math.abs(whole - 0.4) > 0.2,
      `締め出して ${banded.toFixed(3)} / 締め出さず ${whole.toFixed(3)}（正解 0.400）`,
    );
  }
  {
    // 境目。大きさ 0 のコマと、潰れた帯（from >= to）。
    // 縦は**答えを返せないときに真ん中へ戻さない**ので、そこまで見る。
    const empty = summarizeRows({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, 2.5);
    const flat = summarizeRows(withRow(0.5), 0, { from: 0.7, to: 0.3 });
    const nothing = rawTargetsVertical([summarizeRows(withRow(0.5), 0)], { from: 0.7, to: 0.3 });
    push(
      '大きさ 0 のコマ・潰れた帯・締め出しで何も残らない帯でも落ちない',
      empty.luma.length === COLUMNS &&
        empty.time === 2.5 &&
        flat.luma.length === COLUMNS &&
        nothing.length === 1 &&
        nothing[0] === 0.5,
      `潰れた帯の最大 ${Math.max(...flat.luma).toFixed(3)} / 何も残らないとき ${nothing[0]}`,
    );
  }
  {
    // 縦の窓の長さが 9/16 であること、そして**枠がそのぶん端で止まる**こと。
    // 止まる所（0.28125）は正解の置き所と重ねてはいけない、という話が
    // `vsubject-static` の注にある。ここではその止まる所そのものを固定しておく。
    const frames = [withRow(0.05), withRow(0.05)];
    const times = [0, 1 / 15];
    const rows = summarizeForReframeVertical(frames, times);
    const plan = planReframeVertical(rows);
    push(
      '縦の窓は 9/16 で、枠はその半分より端へは行かない',
      Math.abs(SQUARE_CROP_V - 0.5625) < 1e-12 &&
        Math.abs(VERTICAL_REFRAME.cropWidth - SQUARE_CROP_V) < 1e-12 &&
        plan.frames.every((f) => f.center >= SQUARE_CROP_V / 2 - 1e-9),
      `いちばん上 ${Math.min(...plan.frames.map((f) => f.center)).toFixed(5)}（下限 ${(SQUARE_CROP_V / 2).toFixed(5)}）`,
    );
  }
  {
    // 縦の生の位置が、横の生の位置と**混ざっていない**こと。
    // 同じ `ColumnStat` の形を使い回しているので、取り違えても型では落ちない。
    const frames = [withRow(0.7), withRow(0.7)];
    const times = [0, 1 / 15];
    const rows = summarizeForReframeVertical(frames, times);
    const v = rawTargetsVertical(rows);
    const u = rawTargets(summarizeForReframe(frames, times));
    push(
      '縦は帯の高さを指し、同じコマを横で読むと指す所が無い（横は一様なので）',
      Math.abs(v[0] - 0.7) < 0.05,
      `縦 ${v[0].toFixed(3)}（正解 0.700）/ 横 ${Number.isNaN(u[0]) ? 'NaN' : u[0].toFixed(3)}`,
    );
  }

  return out;
}
