/**
 * 書き出す音の仕上げ（試験的）。
 *
 * 測る（LUFS）→ 倍率を 1 つ決める → 掛ける → 天井を超えるところだけリミッタで均す。
 * 判断の部分はラボ（`lab/auto-cut`）の写しで、ここは繋ぐだけ。
 * DOM を使わないので Node で検査できる（`scripts/model-selftest.mjs`）。
 */
import type { AudioLike } from '../analysis/audio/loudness.ts';
import { applyGain, measureLoudness, planLoudnessNormalization } from '../analysis/audio/lufs.ts';
import { limitTruePeak } from '../analysis/audio/limiter.ts';

export const FINISH_TARGET_LUFS = -14;
export const FINISH_CEILING_DB = -1;
/** リミッタが下げられる深さ（`limiter.ts` の既定）と揃える。 */
export const FINISH_LIMITER_DEPTH_DB = 6;

export interface AudioFinishReport {
  /** 仕上げが何かしたか。測れなかった（無音など）ときは false。 */
  applied: boolean;
  beforeLufs: number | null;
  afterLufs: number | null;
  gainDb: number;
  /** 処理後の真のピーク（dBTP）。 */
  truePeakDb: number;
  /** リミッタが下げた最大量（dB）。 */
  limiterReductionDb: number;
  /** 目標に届かなかったぶん（dB）。 */
  shortfallDb: number;
  /** 一言で。 */
  summary: string;
}

export interface AudioFinishResult {
  buffer: AudioLike;
  report: AudioFinishReport;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

export function finishAudio(buffer: AudioLike): AudioFinishResult {
  const measurement = measureLoudness(buffer);
  const plan = planLoudnessNormalization(measurement, {
    targetLufs: FINISH_TARGET_LUFS,
    truePeakCeilingDb: FINISH_CEILING_DB,
    limiterHeadroomDb: FINISH_LIMITER_DEPTH_DB,
  });
  if (plan.limitedBy === 'unmeasurable') {
    return {
      buffer,
      report: {
        applied: false,
        beforeLufs: null,
        afterLufs: null,
        gainDb: 0,
        truePeakDb: measurement.truePeakDb,
        limiterReductionDb: 0,
        shortfallDb: 0,
        summary: '音量を測れなかったので、そのまま書き出しました',
      },
    };
  }
  const gained = applyGain(buffer, plan.gain);
  const limited = limitTruePeak(gained, {
    ceilingDb: FINISH_CEILING_DB,
    maxReductionDb: FINISH_LIMITER_DEPTH_DB,
  });
  const after = measureLoudness(limited.buffer);
  const afterLufs = after.integratedLufs;
  const short = plan.shortfallDb > 0.05 ? `（目標まであと ${fmt(plan.shortfallDb)}dB）` : '';
  return {
    buffer: limited.buffer,
    report: {
      applied: true,
      beforeLufs: measurement.integratedLufs,
      afterLufs,
      gainDb: plan.gainDb,
      truePeakDb: limited.report.truePeakDb,
      limiterReductionDb: limited.report.maxReductionDb,
      shortfallDb: plan.shortfallDb,
      summary: `${fmt(measurement.integratedLufs ?? 0)} → ${afterLufs === null ? '?' : fmt(afterLufs)} LUFS、ピーク ${fmt(limited.report.truePeakDb)}dBTP${short}`,
    },
  };
}
