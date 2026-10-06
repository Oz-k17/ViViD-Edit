/**
 * 自動リフレームの「枠の中心の列」を、**止まった区間の並び**に畳む。
 *
 * ラボの計画（`planReframe`）が返すのは「コマごとの枠の中心」で、**枠が滑らかに動く**前提の列。
 * 本体は時間で変わる値（キーフレーム）を持っていない（`lab/keyframe/` は試作止まり）ので、
 * 滑らかには動かせない。**代わりに、中心がほぼ同じ所を 1 区間にまとめ、区間ごとに枠を止める。**
 * 区間の境目でクリップを割るので、そこで枠はぽんと動く。
 *
 * これは**暫定の形**で、キーフレームが入れば要らなくなる。そのときは `planReframe` の列を
 * そのまま打点にできる。ここに置いたのは「いま本体で実現できる範囲」のための畳み方。
 *
 * 画面にも DOM にも依存していないので、Node から検算できる。
 */

export interface CenterSample {
  /** 素材の頭からの秒。 */
  time: number;
  /** 枠の中心（軸の幅に対する割合、0〜1）。 */
  center: number;
}

export interface CenterSegment {
  /** 区間の頭（素材の頭からの秒）。最初の区間は最初のコマの時刻。 */
  from: number;
  /** 区間の終わり（次の区間の頭と同じ）。最後の区間は最後のコマの時刻。 */
  to: number;
  /** その区間で枠を止める中心（区間の中央値）。 */
  center: number;
}

export interface SegmentOptions {
  /**
   * 1 つの区間の中で、枠の中心がこのぶんまで動いてよい（軸の幅に対する割合、**幅**として）。
   * 小さいほど細かく割れてクリップが増える。既定 0.06。
   * 窓の幅（横から縦なら 0.316）の 2 割弱で、「動いたと分かるが、枠から被写体が外れない」くらい。
   */
  tolerance: number;
  /** これより短い区間は、隣へ畳む（秒）。短い区間で割ると、画がちらつくだけになる。 */
  minSeconds: number;
  /** 区間の数の上限。超えたら、近い区間どうしを畳んで収める。 */
  maxSegments: number;
}

export const DEFAULT_SEGMENTS: SegmentOptions = {
  tolerance: 0.06,
  minSeconds: 0.8,
  maxSegments: 16,
};

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Run {
  start: number; // 添字
  end: number; // 添字（この手前まで）
}

/** 区間（添字の組）を、中心の動きが `tolerance` に収まる範囲で伸ばしていく。 */
function greedyRuns(samples: CenterSample[], tolerance: number): Run[] {
  const runs: Run[] = [];
  let start = 0;
  let lo = samples[0].center;
  let hi = samples[0].center;
  for (let i = 1; i < samples.length; i += 1) {
    const c = samples[i].center;
    const nlo = Math.min(lo, c);
    const nhi = Math.max(hi, c);
    if (nhi - nlo > tolerance) {
      runs.push({ start, end: i });
      start = i;
      lo = c;
      hi = c;
    } else {
      lo = nlo;
      hi = nhi;
    }
  }
  runs.push({ start, end: samples.length });
  return runs;
}

/** 区間の代表の中心（中央値）。 */
function runCenter(samples: CenterSample[], run: Run): number {
  return median(samples.slice(run.start, run.end).map((s) => s.center));
}

/** 区間の秒数（次のコマの頭までを含める。最後の区間だけは最後のコマまで）。 */
function runSeconds(samples: CenterSample[], run: Run): number {
  const from = samples[run.start].time;
  const to = run.end < samples.length ? samples[run.end].time : samples[samples.length - 1].time;
  return to - from;
}

/** 中心がいちばん近い隣へ、`index` の区間を畳み込む。畳んだあとの区間の添字を返す。 */
function mergeInto(runs: Run[], centers: number[], index: number): number {
  if (runs.length <= 1) return index;
  const left = index > 0 ? Math.abs(centers[index] - centers[index - 1]) : Infinity;
  const right = index < runs.length - 1 ? Math.abs(centers[index] - centers[index + 1]) : Infinity;
  if (left <= right) {
    runs[index - 1] = { start: runs[index - 1].start, end: runs[index].end };
    runs.splice(index, 1);
    centers.splice(index, 1);
    return index - 1;
  }
  runs[index + 1] = { start: runs[index].start, end: runs[index + 1].end };
  runs.splice(index, 1);
  centers.splice(index, 1);
  return index;
}

/**
 * 中心の列を、止まった区間の並びにする。
 *
 * 1. 中心の動きが `tolerance` に収まる範囲で、頭から区間を伸ばす
 * 2. `minSeconds` に満ちない区間を、中心が近いほうの隣へ畳む
 * 3. 数が `maxSegments` を超えるなら、**隣と中心がいちばん近い区間**から畳んで収める
 * 4. 畳んだあとの区間の中心を、**中央値で取り直す**（畳む前の値のままだと、畳んだ区間が外れる）
 *
 * 入力は時刻の昇順であること。空なら空を返す。
 */
export function segmentCenters(samples: CenterSample[], options: Partial<SegmentOptions> = {}): CenterSegment[] {
  const opt = { ...DEFAULT_SEGMENTS, ...options };
  if (samples.length === 0) return [];

  const runs = greedyRuns(samples, opt.tolerance);
  const centers = runs.map((r) => runCenter(samples, r));

  // 短い区間を畳む。1 つ畳むと隣の秒数が変わるので、いちばん短いものから 1 つずつ。
  for (;;) {
    if (runs.length <= 1) break;
    let shortest = -1;
    let shortestSeconds = Infinity;
    for (let i = 0; i < runs.length; i += 1) {
      const sec = runSeconds(samples, runs[i]);
      if (sec < opt.minSeconds && sec < shortestSeconds) {
        shortest = i;
        shortestSeconds = sec;
      }
    }
    if (shortest < 0) break;
    // 畳んだ区間は、畳む前の中心のままだと外れるので取り直す。
    const merged = mergeInto(runs, centers, shortest);
    centers[merged] = runCenter(samples, runs[merged]);
  }

  // 短い区間を畳んだあと、**中心がほぼ同じ区間が並んで残る**ことがある
  // （寄り道が左右どちらかへ畳まれると、その両側が同じ所を指している）。
  // 割っても枠は動かないので、割るだけ損。中心が近い隣は 1 つにする。
  for (let i = 0; i < runs.length - 1; ) {
    if (Math.abs(centers[i] - centers[i + 1]) <= opt.tolerance / 2) {
      runs[i] = { start: runs[i].start, end: runs[i + 1].end };
      runs.splice(i + 1, 1);
      centers.splice(i + 1, 1);
      centers[i] = runCenter(samples, runs[i]);
    } else {
      i += 1;
    }
  }

  // 数の上限。近い隣どうしから畳む。
  while (runs.length > Math.max(1, opt.maxSegments)) {
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < runs.length - 1; i += 1) {
      const gap = Math.abs(centers[i] - centers[i + 1]);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    runs[best] = { start: runs[best].start, end: runs[best + 1].end };
    runs.splice(best + 1, 1);
    centers.splice(best + 1, 1);
    centers[best] = runCenter(samples, runs[best]);
  }

  return runs.map((run) => ({
    from: samples[run.start].time,
    to: run.end < samples.length ? samples[run.end].time : samples[samples.length - 1].time,
    center: runCenter(samples, run),
  }));
}
