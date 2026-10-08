/**
 * 長い動画の「下見の絵」。
 *
 * 3 時間の動画を飛ばし飛ばしに見ると、そのたびに本物の動画をシークすることになる。
 * シークは「直前のキーフレームから目的のコマまでデコードし直す」処理なので重く、
 * ドラッグ中は次々に積み上がって固まる原因になる。
 *
 * そこで取り込んだあと裏で、**キーフレームだけ**を数秒おきに小さく読んでおく。
 * キーフレームはそれ単体で絵になるので、1 枚あたりデコードは 1 コマで済む（変換・書き出しは要らない）。
 * ドラッグ中はこの絵を即座に出し、本物の動画は手を止めたときに 1 回だけシークする（player.ts）。
 *
 * 絵はメモリにだけ置く（長辺 128px・最大 1200 枚で 40MB 程度）。開き直したら作り直す。
 */
import { BlobSource, CanvasSink, EncodedPacketSink, Input, UrlSource } from 'mediabunny';
import { useSyncExternalStore } from 'react';
import { VIDEO_INPUT_FORMATS } from './formats';
import { mediaRegistry } from './media';

/** これより短い動画は、普通にシークしても十分軽いので作らない。 */
const MIN_DURATION = 3 * 60;
const MAX_FRAMES = 1200;
const MIN_STEP = 3;
const LONG_SIDE = 128;

interface Strip {
  /** キーフレームの時刻（素材内の秒、昇順）。 */
  times: number[];
  frames: ImageBitmap[];
}

const strips = new Map<string, Strip>();
/** 作成中の進み具合（0〜1）。 */
let progress: Record<string, number> = {};
const listeners = new Set<() => void>();
const queue: string[] = [];
let busy = false;
const tried = new Set<string>();

function setProgress(id: string, value: number | null) {
  const next = { ...progress };
  if (value === null) delete next[id];
  else next[id] = value;
  progress = next;
  listeners.forEach((fn) => fn());
}

export function useStripProgress(): Record<string, number> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => progress,
    () => progress,
  );
}

export function hasStrip(id: string | null): boolean {
  return !!id && strips.has(id);
}

/** 素材内の時刻に一番近い（その時刻以前の）下見の絵。無ければ null。 */
export function stripFrameAt(id: string | null, sourceTime: number): ImageBitmap | null {
  const strip = id ? strips.get(id) : undefined;
  if (!strip || strip.times.length === 0) return null;
  let lo = 0;
  let hi = strip.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (strip.times[mid] <= sourceTime) lo = mid;
    else hi = mid - 1;
  }
  return strip.frames[lo] ?? null;
}

/** 長い動画すべてについて、まだ無ければ作る（1 本ずつ、裏で）。 */
export function ensureStrips() {
  // 消された素材の絵は手放す。
  for (const id of [...strips.keys()]) if (!mediaRegistry.get(id)) dropStrip(id);
  for (const asset of mediaRegistry.all()) {
    if (asset.kind !== 'video' || asset.duration < MIN_DURATION || asset.warning) continue;
    if (strips.has(asset.id) || tried.has(asset.id) || queue.includes(asset.id)) continue;
    queue.push(asset.id);
  }
  void pump();
}

async function pump() {
  if (busy) return;
  const id = queue.shift();
  if (!id) return;
  busy = true;
  tried.add(id);
  try {
    await build(id);
  } catch {
    /* 下見が無くても、普通のシーク（手を止めたときに 1 回）で動く */
  } finally {
    setProgress(id, null);
    busy = false;
    void pump();
  }
}

async function build(id: string) {
  const asset = mediaRegistry.get(id);
  if (!asset) return;
  setProgress(id, 0);
  const source = asset.src ? new UrlSource(asset.url) : new BlobSource(await (await fetch(asset.url)).blob());
  const input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return;
    const duration = await input.computeDuration();
    const step = Math.max(MIN_STEP, duration / MAX_FRAMES);

    // 1. 欲しい時刻ごとに、直前のキーフレームの時刻を調べる（索引を引くだけで、中身は読まない）。
    const keys = new EncodedPacketSink(track);
    const times: number[] = [];
    for (let t = 0; t < duration; t += step) {
      const packet = await keys.getKeyPacket(t, { metadataOnly: true });
      if (packet && packet.timestamp !== times[times.length - 1]) times.push(packet.timestamp);
    }
    if (times.length === 0) return;

    // 2. その時刻の絵を小さく取り出す。キーフレームちょうどなので、1 枚につき 1 コマのデコードで済む。
    const w = track.displayWidth || asset.width || 1920;
    const h = track.displayHeight || asset.height || 1080;
    const scale = LONG_SIDE / Math.max(w, h);
    const sink = new CanvasSink(track, {
      width: Math.max(2, Math.round(w * scale)),
      height: Math.max(2, Math.round(h * scale)),
      fit: 'fill',
      poolSize: 2,
    });
    const strip: Strip = { times: [], frames: [] };
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      const t = times[i];
      i += 1;
      if (!wrapped) continue;
      strip.times.push(t);
      strip.frames.push(await createImageBitmap(wrapped.canvas));
      if (i % 20 === 0) setProgress(id, i / times.length);
      // 素材が消されたら、やめる。
      if (!mediaRegistry.get(id)) return;
    }
    strips.set(id, strip);
  } finally {
    input.dispose();
  }
}

/** 素材を消したときなどに、絵を手放す。 */
export function dropStrip(id: string) {
  const strip = strips.get(id);
  strip?.frames.forEach((f) => f.close());
  strips.delete(id);
}
