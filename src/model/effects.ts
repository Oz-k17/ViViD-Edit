/**
 * エフェクトを**時間で効かせる**ところ。
 *
 * これまでは、掛けたら最後までその強さで掛かりっぱなしだった。
 * 「頭の 0.25 秒だけ寄る」「決めゼリフの所だけ暗くする」「一瞬フラッシュ」は、
 * どれも掛かり方が時間で変わるので作れなかった。
 *
 * 打点を並べる形（キーフレーム）にすると持ち物が大きく変わるので、
 * まず**1 つのエフェクトに 1 つの山**だけを持たせる形にしてある。
 * 上の 3 つはこれで足りる。
 *
 * 画面にも canvas にも依存していない。
 */

import type { Effect, EffectType } from './types';

/**
 * 「掛かっていない」ときの強さ。
 *
 * 強さ 0 が素通しとは限らない。明るさは 0 だと**暗くなる**し、
 * 彩度も 0 だと白黒になる。時間で効かせるとき、抜けた所が素通しになるよう、
 * 型ごとの素通しの値をここに持つ。
 */
export const EFFECT_NEUTRAL: Record<EffectType, number> = {
  brightness: 0.5,
  contrast: 0.5,
  saturate: 0.5,
  grayscale: 0,
  sepia: 0,
  hueRotate: 0,
  blur: 0,
  invert: 0,
};

export interface EffectTiming {
  /** 掛かり始め（クリップの頭からの秒）。 */
  start: number;
  /** 掛かっている長さ（秒）。0 以下ならクリップの終わりまで。 */
  duration: number;
  /** 立ち上がりの長さ（秒）。 */
  attack: number;
  /** 抜けの長さ（秒）。 */
  release: number;
}

export const DEFAULT_EFFECT_TIMING: EffectTiming = {
  start: 0,
  duration: 0.25,
  attack: 0,
  release: 0.2,
};

/** 行き帰りとも滑らかにする。等速で動かすと、機械が動かした感じになる。 */
function ease(t: number): number {
  const v = Math.max(0, Math.min(1, t));
  return v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2;
}

/**
 * その時刻に、どれだけ効いているか（0〜1）。
 * 立ち上がりと抜けは、掛かっている区間の**内側**に取る。
 * 外へはみ出させると、指定した所より前から効き始めて位置が読めなくなる。
 */
export function effectAmount(timing: EffectTiming, local: number, clipDuration: number): number {
  const from = timing.start;
  const to = timing.duration > 0 ? timing.start + timing.duration : clipDuration;
  if (local <= from || local >= to) return 0;

  const span = to - from;
  // 立ち上がりと抜けを足して区間を超えるときは、比を保ったまま詰める。
  const want = Math.max(0, timing.attack) + Math.max(0, timing.release);
  const scale = want > span ? span / want : 1;
  const attack = Math.max(0, timing.attack) * scale;
  const release = Math.max(0, timing.release) * scale;

  if (attack > 0 && local < from + attack) return ease((local - from) / attack);
  if (release > 0 && local > to - release) return ease((to - local) / release);
  return 1;
}

/**
 * その時刻の強さ。
 * 時間の指定が無ければ、これまでどおり掛けた強さのまま。
 */
export function effectIntensity(effect: Effect, local: number, clipDuration: number): number {
  if (!effect.timing) return effect.intensity;
  const neutral = EFFECT_NEUTRAL[effect.type] ?? 0;
  const amount = effectAmount(effect.timing, local, clipDuration);
  return neutral + (effect.intensity - neutral) * amount;
}

/** 使いどころの決まった型。押すだけで当てられるようにしておく。 */
export const EFFECT_SHAPES: { key: string; label: string; hint: string; timing: EffectTiming }[] = [
  {
    key: 'head',
    label: '頭だけ',
    hint: 'セグメントの頭で一度効かせて、すぐ戻す',
    timing: { start: 0, duration: 0.25, attack: 0, release: 0.2 },
  },
  {
    key: 'flash',
    label: '一瞬',
    hint: '決めの所で瞬かせる',
    timing: { start: 0, duration: 0.12, attack: 0.02, release: 0.1 },
  },
  {
    key: 'in',
    label: '入ってくる',
    hint: 'ゆっくり効かせて、そのまま最後まで',
    timing: { start: 0, duration: 0, attack: 0.6, release: 0 },
  },
  {
    key: 'out',
    label: '抜けていく',
    hint: '最初から効いていて、終わりに向けて戻す',
    timing: { start: 0, duration: 0, attack: 0, release: 0.8 },
  },
  {
    key: 'always',
    label: 'ずっと',
    hint: '時間で変えない（これまでどおり）',
    timing: { start: 0, duration: 0, attack: 0, release: 0 },
  },
];
