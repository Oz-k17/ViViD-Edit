/**
 * 実数列のスペクトルを取る（基数 2 の FFT）。
 *
 * 外部ライブラリを足さないために自前で持っている。
 * 音の「速さ」や「明るさ」を見るには周波数ごとの大きさが要るが、
 * そのために依存を増やすほどの量ではない（60 行ほど）。
 *
 * 長さは 2 の冪に限る。呼ぶ側で窓の長さを決めているので、そこは守れる。
 */

/** 事前に計算した回転因子。窓の長さは毎回同じなので、作り直さない。 */
const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  const found = twiddleCache.get(n);
  if (found) return found;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const made = { cos, sin };
  twiddleCache.set(n, made);
  return made;
}

/**
 * その場で変換する（re / im を書き換える）。
 * 呼ぶたびに配列を作らずに済むよう、入れ物は呼ぶ側が使い回す。
 */
export function fftInPlace(re: Float64Array, im: Float64Array) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`FFT の長さは 2 の冪である必要があります（${n}）`);

  // ビット反転で並べ替える。
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const c = cos[k * step];
        const s = sin[k * step];
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** 実数列 → 振幅スペクトル（0 〜 ナイキストまで）。out は使い回してよい。 */
export function magnitudes(samples: Float32Array | Float64Array, re: Float64Array, im: Float64Array, out: Float64Array) {
  const n = re.length;
  for (let i = 0; i < n; i += 1) {
    // ハン窓。窓を掛けないと、切り取った端の段差が全周波数へ漏れる。
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    re[i] = (samples[i] ?? 0) * w;
    im[i] = 0;
  }
  fftInPlace(re, im);
  for (let i = 0; i <= n / 2; i += 1) out[i] = Math.hypot(re[i], im[i]);
}

/** 窓の入れ物をまとめて作る。 */
export function fftScratch(size: number) {
  return {
    size,
    re: new Float64Array(size),
    im: new Float64Array(size),
    mag: new Float64Array(size / 2 + 1),
  };
}
