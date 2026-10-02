/**
 * 長尺の試し素材を、**標本の列として持たずに**作る。
 *
 * 10 分ぶんを `Float32Array` で持つと 1ch 115MB・2ch 230MB になる。
 * それを抱えたまま「区間ごとに流すとメモリが減る」と言っても何も測れないので、
 * **位置 i から値を直に計算する形**にしてある（状態を持たないので、どの範囲からでも同じ値が出る）。
 *
 * 中身は「土台の正弦波 ＋ 0.8 秒ごとに天井を超える打撃 ＋ ゆっくりした音量のうねり」。
 * リミッタが手を出す相手（短くてまばらな山）を素材の全域にばらまいた形で、
 * 2026-09-19（3 回目）に測った実素材の傾向（天井超えは 0.04% 以下・深さ 2dB 前後）に寄せてある。
 */

/** 位置 i（絶対）の標本。**同じ i なら必ず同じ値**を返すこと（区間に割っても同じ波になる根拠）。 */
export function sampleAt(i, sampleRate, channel = 0) {
  const t = i / sampleRate;
  const bed = Math.sin(2 * Math.PI * 180 * t) * (0.35 + 0.1 * Math.sin(2 * Math.PI * 0.05 * t));
  const period = Math.round(0.8 * sampleRate);
  const k = i % period;
  const decay = 0.0006 * sampleRate;
  const hit = k < Math.round(0.004 * sampleRate) ? 1.3 * Math.exp(-k / decay) : 0;
  return (bed + hit) * (channel === 1 ? 0.82 : 1);
}

/** `read(from, to)` だけを持つ入り口（丸ごと起こさない）。 */
export function generatedSource(seconds, { sampleRate = 48000, channels = 1 } = {}) {
  const length = Math.round(seconds * sampleRate);
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    read(from, to) {
      const out = [];
      for (let c = 0; c < channels; c += 1) {
        const a = new Float32Array(to - from);
        for (let i = from; i < to; i += 1) a[i - from] = sampleAt(i, sampleRate, c);
        out.push(a);
      }
      return out;
    },
  };
}

/** 同じ波を**丸ごと起こした** `AudioLike`（一括のほうに食わせる相手）。 */
export function materialize(seconds, { sampleRate = 48000, channels = 1 } = {}) {
  const length = Math.round(seconds * sampleRate);
  const data = [];
  for (let c = 0; c < channels; c += 1) {
    const a = new Float32Array(length);
    for (let i = 0; i < length; i += 1) a[i] = sampleAt(i, sampleRate, c);
    data.push(a);
  }
  return { sampleRate, numberOfChannels: channels, length, getChannelData: (c) => data[c] };
}

/** 出てきた標本を 1 つの数へ畳む（丸ごと持たずに「同じ波か」を比べるため）。 */
export function foldHash(prev, data) {
  let h = prev;
  const view = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < data.length; i += 1) {
    view.setFloat32(0, data[i]);
    h = (Math.imul(h ^ view.getUint32(0), 16777619) >>> 0) || 1;
  }
  return h;
}
