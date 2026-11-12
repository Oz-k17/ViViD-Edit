/**
 * 説明カード（Hint）の中で動かす、小さな見本。
 *
 * - TimelineDemo: クリップの帯がどう動くかの図（編集ツール）
 * - TransitionDemo: 場面の切り替わり方
 * - TextDemo: テロップのスタイルと出てくるときの動き（本物の描画を小さく回す）
 * - EffectDemo: エフェクト・色味を見本の絵にかけた結果（左が元、右がかけた後）
 * - ThreeBandDemo: 横長の録画が、縦の 3 段になる図
 *
 * どれも、カードが出ているあいだだけ作られる。
 */

import { useEffect, useRef, useState } from 'react';
import { effectFilter, renderFrame, type RenderSources } from '../engine/renderer';
import { createSequence, textClip } from '../model/factory';
import { tracksOf } from '../model/ops';
import type { Effect, TextProps, TransitionType } from '../model/types';

// ---------------------------------------------------------------- タイムライン

export type TimelineDemoKind =
  | 'normal'
  | 'ripple'
  | 'roll'
  | 'slip'
  | 'slide'
  | 'insert'
  | 'range'
  | 'lift'
  | 'extract'
  | 'closeGap'
  | 'splitAll'
  | 'split'
  | 'snap'
  | 'follow'
  | 'delete'
  | 'rippleDelete'
  | 'duplicate'
  | 'scene'
  | 'tempo';

/** 帯のある時点の姿。null なら見えない。 */
type Shape = { x: number; w: number; shift?: number } | null;
interface Bar {
  tone: 'a' | 'b' | 'c' | 'new' | 'quiet';
  row?: number;
  /** 動かしている帯（強調する）。 */
  hot?: boolean;
  at: [Shape, Shape];
}
interface Scene {
  bars: Bar[];
  rows?: number;
  /** 再生位置の線（前・後）。 */
  head?: [number, number];
  /** 範囲（In〜Out）。 */
  range?: [[number, number] | null, [number, number] | null];
  /** ぴったり合う所の線。 */
  snapLine?: number;
}

const W = 216;
const bar = (tone: Bar['tone'], from: Shape, to: Shape, extra: Partial<Bar> = {}): Bar => ({ tone, at: [from, to], ...extra });
const at = (x: number, w: number, shift?: number): Shape => ({ x, w, shift });

const SCENES: Record<TimelineDemoKind, Scene> = {
  normal: { bars: [bar('a', at(0, 70), at(0, 70)), bar('b', at(70, 70), at(70, 40), { hot: true }), bar('c', at(140, 70), at(140, 70))] },
  ripple: { bars: [bar('a', at(0, 70), at(0, 70)), bar('b', at(70, 70), at(70, 40), { hot: true }), bar('c', at(140, 70), at(110, 70))] },
  roll: { bars: [bar('a', at(0, 70), at(0, 100), { hot: true }), bar('b', at(70, 70), at(100, 40), { hot: true }), bar('c', at(140, 70), at(140, 70))] },
  slip: { bars: [bar('a', at(0, 70), at(0, 70)), bar('b', at(70, 70, 0), at(70, 70, -26), { hot: true }), bar('c', at(140, 70), at(140, 70))] },
  slide: { bars: [bar('a', at(0, 70), at(0, 100)), bar('b', at(70, 70), at(100, 70), { hot: true }), bar('c', at(140, 70), at(170, 40))] },
  insert: { bars: [bar('a', at(0, 80), at(0, 80)), bar('new', null, at(80, 50), { hot: true }), bar('c', at(80, 80), at(130, 80))] },
  range: { bars: [bar('a', at(0, 100), at(0, 100)), bar('c', at(100, 110), at(100, 110))], head: [60, 150], range: [[60, 62], [60, 150]] },
  lift: {
    bars: [bar('a', at(0, 60), at(0, 60)), bar('b', at(60, 90), null, { hot: true }), bar('c', at(150, 60), at(150, 60))],
    range: [[60, 150], [60, 150]],
  },
  extract: {
    bars: [bar('a', at(0, 60), at(0, 60)), bar('b', at(60, 90), null, { hot: true }), bar('c', at(150, 60), at(60, 60))],
    range: [[60, 150], null],
  },
  closeGap: { bars: [bar('a', at(0, 70), at(0, 70)), bar('c', at(120, 80), at(70, 80), { hot: true })], head: [95, 95] },
  splitAll: {
    rows: 2,
    bars: [
      bar('a', at(0, 200), at(0, 99)),
      bar('a', null, at(103, 97)),
      bar('c', at(0, 180, 0), at(0, 99), { row: 1 }),
      bar('c', null, at(103, 77), { row: 1 }),
    ],
    head: [101, 101],
  },
  split: { bars: [bar('a', at(0, 200), at(0, 99), { hot: true }), bar('a', null, at(103, 97), { hot: true })], head: [101, 101] },
  snap: { bars: [bar('a', at(0, 80), at(0, 80)), bar('b', at(96, 70), at(80, 70), { hot: true })], snapLine: 80 },
  follow: {
    bars: [bar('a', at(0, 90), at(-110, 90)), bar('b', at(90, 90), at(-20, 90)), bar('c', at(180, 90), at(70, 90)), bar('a', at(270, 90), at(160, 90))],
    head: [196, 86],
  },
  delete: { bars: [bar('a', at(0, 70), at(0, 70)), bar('b', at(70, 70), null, { hot: true }), bar('c', at(140, 70), at(140, 70))] },
  rippleDelete: { bars: [bar('a', at(0, 70), at(0, 70)), bar('b', at(70, 70), null, { hot: true }), bar('c', at(140, 70), at(70, 70))] },
  duplicate: { bars: [bar('a', at(0, 70), at(0, 70), { hot: true }), bar('a', null, at(70, 70), { hot: true }), bar('c', at(70, 70), at(140, 70))] },
  scene: {
    bars: [bar('a', at(0, 216), at(0, 62)), bar('b', at(64, 152), at(66, 78)), bar('c', at(146, 70), at(148, 68))],
  },
  tempo: {
    bars: [
      bar('a', at(0, 56), at(0, 56)),
      bar('quiet', at(56, 30), null),
      bar('a', at(86, 50), at(56, 50)),
      bar('quiet', at(136, 24), null),
      bar('a', at(160, 56), at(106, 56)),
    ],
  },
};

/** 前 → 後 を、間を置いて繰り返す。 */
function usePhase(holdMs = 1300): 0 | 1 {
  const [phase, setPhase] = useState<0 | 1>(0);
  useEffect(() => {
    const id = window.setInterval(() => setPhase((p) => (p === 0 ? 1 : 0)), holdMs);
    return () => window.clearInterval(id);
  }, [holdMs]);
  return phase;
}

export function TimelineDemo({ kind }: { kind: TimelineDemoKind }) {
  const phase = usePhase();
  const scene = SCENES[kind];
  const rows = scene.rows ?? 1;
  const range = scene.range?.[phase];
  return (
    <div className={`demo-tl rows-${rows} phase-${phase}`} style={{ width: W }} aria-hidden>
      {range && <span className="demo-range" style={{ left: range[0], width: range[1] - range[0] }} />}
      {scene.bars.map((b, i) => {
        const now = b.at[phase];
        const other = b.at[phase === 0 ? 1 : 0];
        const shape = now ?? other;
        if (!shape) return null;
        return (
          <span
            key={i}
            className={`demo-bar tone-${b.tone}${b.hot ? ' hot' : ''}${now ? '' : ' gone'}`}
            style={{
              left: shape.x,
              width: shape.w,
              top: 4 + (b.row ?? 0) * 26,
              backgroundPositionX: shape.shift ?? 0,
            }}
          />
        );
      })}
      {scene.snapLine !== undefined && <span className="demo-snap" style={{ left: scene.snapLine }} />}
      {scene.head && <span className="demo-head" style={{ left: scene.head[phase] }} />}
      <span className="demo-phase">{phase === 0 ? '前' : '後'}</span>
    </div>
  );
}

// ---------------------------------------------------------------- 場面の切り替え

/** 2 枚の絵（A → B）が、その切り替えで入れ替わる様子。動きは CSS（styles.css の demo-tr-*）。 */
export function TransitionDemo({ type }: { type: TransitionType }) {
  return (
    <div className={`demo-tr type-${type}`} aria-hidden>
      <span className="demo-tr-a">A</span>
      <span className="demo-tr-b">B</span>
      <span className="demo-tr-flash" />
    </div>
  );
}

// ---------------------------------------------------------------- テロップ

const NO_SOURCES: RenderSources = { frameFor: () => null, sizeFor: () => null, emojiFor: () => null };
const TEXT_W = 1080;
const TEXT_H = 460;
const TEXT_LOOP = 2.4;

/**
 * テロップの見本。アプリの描画（renderFrame）をそのまま小さく回すので、選んだあとの見た目と同じになる。
 * `still` なら出きった所で止める（スタイルの見本）。そうでなければ、出てくる動きを繰り返す。
 */
export function TextDemo({ text, still = false }: { text: TextProps; still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const base = createSequence();
    const track = tracksOf(base, 'text')[0];
    // 長い文は見本に収まらないので、頭の 1 行だけ。幅いっぱいの見出しは、枠に合わせて縮む。
    const content = (text.content.split('\n')[0] || 'テロップ').slice(0, 12);
    const clip = {
      ...textClip(track.id, 0, TEXT_LOOP, { ...text, content, fontSize: Math.min(text.fontSize, 120), frame: null }),
      x: 0,
      y: 0,
    };
    const sequence = { ...base, width: TEXT_W, height: TEXT_H, background: '#33424f', clips: [clip] };
    let raf = 0;
    const started = performance.now();
    const draw = () => {
      const time = still ? TEXT_LOOP / 2 : ((performance.now() - started) / 1000) % TEXT_LOOP;
      renderFrame(ctx, sequence, time, NO_SOURCES, { guides: false });
      if (!still) raf = requestAnimationFrame(draw);
    };
    draw();
    // 字体があとから届くことがある。届いたら、止め絵も描き直す。
    let alive = true;
    void document.fonts?.ready?.then(() => alive && still && draw());
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [text, still]);

  return <canvas ref={ref} className="demo-text" width={432} height={184} aria-hidden />;
}

// ---------------------------------------------------------------- エフェクト・色味

/**
 * 見本の絵にかけた結果。左半分が元、右半分がかけた後。
 * 絵は、選んでいるクリップのサムネイル（無ければ色の帯）。
 */
export function EffectDemo({
  effects,
  thumbnail,
  motion,
}: {
  effects: Pick<Effect, 'type' | 'intensity'>[];
  thumbnail?: string;
  /** 動きのエフェクトの見本。動かし方は CSS（styles.css の demo-fx-move-*）。 */
  motion?: string;
}) {
  const filter = effectFilter(effects as Effect[], 216 / 1080);
  const image = thumbnail ? { backgroundImage: `url(${thumbnail})` } : undefined;
  return (
    <div className={`demo-fx${thumbnail ? '' : ' sample'}`} aria-hidden>
      <span className="demo-fx-pic" style={image} />
      <span className="demo-fx-after">
        <span className={`demo-fx-pic${motion ? ` move-${motion}` : ''}`} style={{ ...image, filter: filter === 'none' ? undefined : filter }} />
        {motion === 'vignette' && <span className="demo-fx-vignette" />}
      </span>
      <span className="demo-fx-label left">元</span>
      <span className="demo-fx-label right">かけた後</span>
    </div>
  );
}

// ---------------------------------------------------------------- 3 段（3 分割）

/** 横長の録画（隅に顔）が、縦の 3 段（見出し・本編・顔のアップ）になる図。 */
export function ThreeBandDemo({ title }: { title: boolean }) {
  return (
    <div className="demo-3b" aria-hidden>
      <div className="demo-3b-src">
        <span className="demo-3b-main">本編</span>
        <span className="demo-3b-face">顔</span>
      </div>
      <span className="demo-3b-arrow">→</span>
      <div className="demo-3b-out">
        <span className="demo-3b-top">{title ? '見出し' : ''}</span>
        <span className="demo-3b-mid">本編</span>
        <span className="demo-3b-bot">顔</span>
      </div>
    </div>
  );
}
