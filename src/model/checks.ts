/**
 * 確かめリスト — 書き出す前に、仕上がりの穴を並べる。
 *
 * 見落としやすいのに、投稿してから気づくと直しようがないもの（字幕が速すぎる・ボタンに隠れる・
 * 黒い画面が挟まる・見出しが仮のまま・長い無音・音割れ）を、時刻つきで出す。押せばその場所へ飛べる。
 *
 * ここは純粋な計算だけ。文字の大きさは描いてみないと分からないので、呼ぶ側が測り方（`measure`）を渡す。
 * 音は、書き出しと同じ混ぜ方で作った波形（`renderAudioMix`）を渡す。
 */

import { goldenBands } from './layout';
import { sequenceDuration } from './ops';
import type { Clip, Sequence } from './types';

export type CheckKind =
  | 'captionFast'
  | 'captionsStacked'
  | 'captionCrushed'
  | 'captionSmall'
  | 'speakerUnsure'
  | 'faceCovered'
  | 'safeZone'
  | 'offscreen'
  | 'titlePlaceholder'
  | 'emptyText'
  | 'gap'
  | 'tooLong'
  | 'silence'
  | 'quietStart'
  | 'clipping';

export interface CheckItem {
  kind: CheckKind;
  /** 'warn' は直したほうがよいもの、'info' は好みで決めてよいもの。 */
  level: 'warn' | 'info';
  /** 飛ぶ先（秒）。 */
  time: number;
  /** 関わるクリップ（展開後の id。まとめたクリップの中身は `外の id/中の id`）。 */
  clipId?: string;
  message: string;
  /** どう直せばよいか。 */
  hint: string;
}

/** シーケンス座標（px）の矩形。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 文字の塊の矩形を測る（描かずに測れないので、呼ぶ側が渡す）。測れなければ null。 */
export type MeasureText = (clip: Clip) => Box | null;

/**
 * 字幕を読み切れる速さ。日本語の字幕は 1 秒に 4 文字（テレビ）〜 8 文字（ショート動画の速いもの）。
 * ショート動画は速めなので 9 文字/秒を超えたら速すぎ、とする。短すぎる表示（0.6 秒未満）も読めない。
 */
export const CAPTION_CHARS_PER_SECOND = 9;
export const CAPTION_MIN_SECONDS = 0.6;

/**
 * 縁が太すぎて文字が潰れる境目。縁（内側＋外側）の太さ ÷ 文字の大きさ。
 * 縁は文字の輪郭の外へ広がるので、字の中の隙間（「日」の中や、画どうしの間）を両側から埋める。
 * 手本にしているテレビ風（0.20）・色文字＋白黒フチ（0.18）は読めるので、それより太いものを知らせる。
 * 字を詰めている（字間がマイナス）と隣の字ともつながるので、そのぶん早めに知らせる。
 */
export const STROKE_CRUSH_RATIO = 0.22;
/** スマホで読める文字の大きさの下限。画面の短い辺に対する割合（1080 幅なら 38px）。 */
export const CAPTION_MIN_SIZE_RATIO = 0.035;

/** 縁の太さ ÷ 文字の大きさ。 */
export function strokeRatio(text: { fontSize: number; strokeWidth: number; strokeWidth2?: number }): number {
  return text.fontSize > 0 ? (Math.max(0, text.strokeWidth) + Math.max(0, text.strokeWidth2 ?? 0)) / text.fontSize : 0;
}

/**
 * 縦長（9:16）の各サービス（TikTok・Shorts・Reels）で、ボタンや説明文が上に重なる所（画面に対する割合）。
 * サービスごとに少しずつ違うので、どれに出しても隠れないよう広めに取った「だいたい」の値。
 */
export const SAFE_ZONE_9X16 = {
  top: 0.06,
  bottom: 0.18,
  /** 右側の縦に並ぶボタン（いいね・コメントなど）。画面の下半分あたりにある。 */
  right: 0.13,
  rightFrom: 0.42,
};

/** Shorts・Reels の長さの上限（秒）。TikTok はもっと長くてよい。 */
export const VERTICAL_LIMIT_SECONDS = 180;

/** 見出しの仮の文言（3 分割の「見出しつき」で入るもの）。 */
export const TITLE_PLACEHOLDER = '見出しを入れる';

const EPS = 0.002;

function isCaption(clip: Clip): boolean {
  return clip.kind === 'text' && (clip.text?.role ?? 'caption') === 'caption';
}

/** 読む文字数（空白・改行・絵文字の印を除く）。 */
export function readingLength(content: string): number {
  return content.replace(/:[^:\s]+:/g, '字').replace(/\s/g, '').length;
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function format(seconds: number): string {
  return `${seconds.toFixed(1)} 秒`;
}

/** 映像の何も映らない時間（黒い画面）。[開始, 終了] の列。 */
export function visualGaps(sequence: Sequence, minLength: number): { start: number; end: number }[] {
  const duration = sequenceDuration(sequence);
  const visibleTracks = new Set(sequence.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id));
  const spans = sequence.clips
    .filter((c) => (c.kind === 'video' || c.kind === 'image') && visibleTracks.has(c.trackId) && c.opacity > 0.05)
    .map((c) => [c.start, c.start + c.duration] as const)
    .sort((a, b) => a[0] - b[0]);
  const gaps: { start: number; end: number }[] = [];
  let covered = 0;
  for (const [s, e] of spans) {
    if (s - covered >= minLength) gaps.push({ start: covered, end: s });
    covered = Math.max(covered, e);
  }
  if (spans.length > 0 && duration - covered >= minLength) gaps.push({ start: covered, end: duration });
  return gaps;
}

/**
 * 3 分割の下の帯（顔）が映っている所。帯の置き場所が黄金比の下の帯と同じ映像クリップ。
 * 返すのは、顔が写っていそうな帯の中ほど（上下の 2 割を除く）。
 */
function faceBands(sequence: Sequence): { clip: Clip; box: Box }[] {
  const band = goldenBands(sequence.height).bottom;
  return sequence.clips
    .filter(
      (c) =>
        c.kind === 'video' &&
        c.crop.enabled &&
        Math.abs(c.crop.dy - band.dy) < EPS &&
        Math.abs(c.crop.dh - band.dh) < EPS &&
        Math.abs(c.crop.dw - 1) < EPS,
    )
    .map((clip) => ({ clip, box: { x: 0, y: band.y + band.h * 0.2, w: sequence.width, h: band.h * 0.6 } }));
}

/** 9:16 で、サービスのボタンや説明文に隠れる所。 */
function safeZoneBoxes(sequence: Sequence): Box[] {
  const W = sequence.width;
  const H = sequence.height;
  const z = SAFE_ZONE_9X16;
  return [
    { x: 0, y: 0, w: W, h: H * z.top },
    { x: 0, y: H * (1 - z.bottom), w: W, h: H * z.bottom },
    { x: W * (1 - z.right), y: H * z.rightFrom, w: W * z.right, h: H * (1 - z.bottom - z.rightFrom) },
  ];
}

/**
 * タイムラインだけで分かる穴（音を調べなくてよいもの）。`sequence` はまとめを展開したもの。
 * 並びは時刻順。
 */
export function timelineChecks(sequence: Sequence, measure: MeasureText): CheckItem[] {
  const items: CheckItem[] = [];
  const W = sequence.width;
  const H = sequence.height;
  const hiddenTracks = new Set(sequence.tracks.filter((t) => t.hidden).map((t) => t.id));
  const texts = sequence.clips.filter((c) => c.kind === 'text' && c.text && !hiddenTracks.has(c.trackId));
  const boxes = new Map<string, Box | null>();
  const boxOf = (clip: Clip) => {
    if (!boxes.has(clip.id)) boxes.set(clip.id, measure(clip));
    return boxes.get(clip.id) ?? null;
  };
  const faces = faceBands(sequence);
  const zones = sequence.aspect === '9:16' ? safeZoneBoxes(sequence) : [];

  for (const clip of texts) {
    const content = clip.text!.content;
    const chars = readingLength(content);
    const middle = clip.start + clip.duration / 2;

    if (chars === 0) {
      items.push({
        kind: 'emptyText',
        level: 'warn',
        time: clip.start,
        clipId: clip.id,
        message: '文字の入っていないテロップがあります',
        hint: '文字を入れるか、消してください',
      });
      continue;
    }
    if (content.trim() === TITLE_PLACEHOLDER) {
      items.push({
        kind: 'titlePlaceholder',
        level: 'warn',
        time: clip.start,
        clipId: clip.id,
        message: '見出しが「見出しを入れる」のままです',
        hint: '見出しを選んで、文言を書き換えてください',
      });
    }

    if (isCaption(clip)) {
      const need = Math.max(CAPTION_MIN_SECONDS, chars / CAPTION_CHARS_PER_SECOND);
      if (clip.duration + EPS < need) {
        items.push({
          kind: 'captionFast',
          level: 'warn',
          time: clip.start,
          clipId: clip.id,
          message: `字幕が速すぎて読み切れません（${chars} 文字を ${format(clip.duration)}）`,
          hint: `${format(need)}以上出すか、言葉を短くしてください`,
        });
      }
    }

    // 縁が太すぎて潰れている・小さすぎて読めない（どちらも、スマホの実寸で読めるかの話）。
    const text = clip.text!;
    const size = text.fontSize * (clip.scale || 1);
    const ratio = strokeRatio(text);
    const tight = text.letterSpacing < 0 ? 0.03 : 0;
    if (ratio > STROKE_CRUSH_RATIO - tight) {
      const total = text.strokeWidth + (text.strokeWidth2 ?? 0);
      items.push({
        kind: 'captionCrushed',
        level: 'warn',
        time: middle,
        clipId: clip.id,
        message: `縁が太すぎて、文字が潰れて見えます（大きさ ${Math.round(text.fontSize)} に縁 ${Math.round(total)}）`,
        hint: `縁を ${Math.max(1, Math.floor(text.fontSize * 0.14))} くらいまで細くするか、文字を大きくしてください`,
      });
    }
    // 「縮めて合わせる」文字は、幅に合わせて大きさが決まるので、ここでは見ない。
    if ((text.fit ?? 'wrap') === 'wrap' && size < Math.min(W, H) * CAPTION_MIN_SIZE_RATIO) {
      items.push({
        kind: 'captionSmall',
        level: 'info',
        time: middle,
        clipId: clip.id,
        message: `文字が小さく、スマホでは読みにくい大きさです（${Math.round(size)}）`,
        hint: `${Math.ceil(Math.min(W, H) * 0.05)} 以上にすると読みやすくなります`,
      });
    }
    if (isCaption(clip) && text.speakerGuess) {
      items.push({
        kind: 'speakerUnsure',
        level: 'warn',
        time: clip.start,
        clipId: clip.id,
        message: 'だれの声か決めきれず、色を付けていない字幕です',
        hint: '字幕を選び、「話者」でどちらの人か決めてください',
      });
    }

    const box = boxOf(clip);
    if (!box) continue;

    if (box.x < -1 || box.y < -1 || box.x + box.w > W + 1 || box.y + box.h > H + 1) {
      items.push({
        kind: 'offscreen',
        level: 'warn',
        time: middle,
        clipId: clip.id,
        message: '文字が画面からはみ出しています',
        hint: '文字を小さくするか、内側へ動かしてください',
      });
    } else if (zones.some((zone) => overlap(zone, box) > box.w * box.h * 0.15)) {
      items.push({
        kind: 'safeZone',
        level: 'info',
        time: middle,
        clipId: clip.id,
        message: '文字が、TikTok・Shorts・Reels のボタンや説明文に隠れる所にかかっています',
        hint: '端から少し内側へ動かすと、どのサービスでも読めます',
      });
    }

    if (isCaption(clip)) {
      const covering = faces.find(
        ({ clip: face, box: faceBox }) =>
          face.start < clip.start + clip.duration - EPS &&
          clip.start < face.start + face.duration - EPS &&
          overlap(faceBox, box) > box.w * box.h * 0.3,
      );
      if (covering) {
        items.push({
          kind: 'faceCovered',
          level: 'info',
          time: middle,
          clipId: clip.id,
          message: '字幕が下の帯（顔）にかかっています',
          hint: '本編の帯の中か、帯の境目へ動かすと顔が隠れません',
        });
      }
    }
  }

  // 同じ時間に出ていて、場所も重なっている字幕（読めない）
  const captions = texts.filter(isCaption).sort((a, b) => a.start - b.start);
  for (let i = 0; i < captions.length; i++) {
    for (let j = i + 1; j < captions.length; j++) {
      const a = captions[i];
      const b = captions[j];
      if (b.start >= a.start + a.duration - 0.05) break;
      const ba = boxOf(a);
      const bb = boxOf(b);
      if (ba && bb && overlap(ba, bb) > 0) {
        items.push({
          kind: 'captionsStacked',
          level: 'warn',
          time: b.start,
          clipId: b.id,
          message: '字幕が 2 つ同じ所に重なって出ています',
          hint: 'どちらかの長さを詰めるか、場所をずらしてください',
        });
      }
    }
  }

  for (const gap of visualGaps(sequence, Math.max(1 / (sequence.fps || 30), 0.05))) {
    items.push({
      kind: 'gap',
      level: 'warn',
      time: gap.start,
      message: gap.start < EPS ? `頭に黒い画面があります（${format(gap.end)}）` : `黒い画面が挟まっています（${format(gap.end - gap.start)}）`,
      hint: '「隙間を詰める」で詰めるか、映像を置いてください',
    });
  }

  const duration = sequenceDuration(sequence);
  if (sequence.aspect === '9:16' && duration > VERTICAL_LIMIT_SECONDS + EPS) {
    items.push({
      kind: 'tooLong',
      level: 'warn',
      time: VERTICAL_LIMIT_SECONDS,
      message: `${Math.floor(duration / 60)} 分 ${Math.round(duration % 60)} 秒あります。Shorts・Reels は 3 分までです`,
      hint: '3 分を超えた所から後ろを削るか、2 本に分けてください（TikTok はこのままで出せます）',
    });
  }

  return items.sort((a, b) => a.time - b.time);
}

/** 音を調べるときの決めごと。 */
export const AUDIO_CHECK = {
  /** この長さ（秒）ごとに音の大きさを測る。 */
  window: 0.05,
  /** これより小さい（dBFS）と、無音とみなす。 */
  silenceDb: -45,
  /** この長さ（秒）以上の無音を知らせる。 */
  silenceSeconds: 2,
  /** 頭のこの秒数に、声らしい大きさ（dBFS）が無いと知らせる。 */
  startSeconds: 3,
  startDb: -30,
  /** この大きさ以上の標本を、割れているとみなす。 */
  clipLevel: 0.999,
  /** 割れた標本がこの数以上続いたら、聞こえる音割れとみなす。 */
  clipRun: 3,
};

/**
 * 音の穴（長い無音・頭が静か・音割れ）。`channels` は書き出しと同じ混ぜ方の波形。
 * 音割れは近いものを 1 つにまとめ、多すぎるときは最初の数か所だけ出す。
 */
export function audioChecks(channels: Float32Array[], sampleRate: number, maxClipping = 5): CheckItem[] {
  const items: CheckItem[] = [];
  if (channels.length === 0 || channels[0].length === 0) return items;
  const length = channels[0].length;
  const hop = Math.max(1, Math.round(sampleRate * AUDIO_CHECK.window));
  const windows = Math.ceil(length / hop);
  const levels = new Float32Array(windows);
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    let count = 0;
    const end = Math.min(length, (w + 1) * hop);
    for (const ch of channels) {
      for (let i = w * hop; i < end; i++) {
        sum += ch[i] * ch[i];
        count++;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    levels[w] = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }
  const total = length / sampleRate;

  // 長い無音
  let quietFrom = -1;
  const flush = (w: number) => {
    if (quietFrom < 0) return;
    const start = quietFrom * AUDIO_CHECK.window;
    const end = Math.min(total, w * AUDIO_CHECK.window);
    if (end - start >= AUDIO_CHECK.silenceSeconds) {
      items.push({
        kind: 'silence',
        level: 'warn',
        time: start,
        message: `${format(end - start)}、音がありません`,
        hint: '間を詰めるか、BGM や効果音を入れてください（間がテンポを落とします）',
      });
    }
    quietFrom = -1;
  };
  for (let w = 0; w < windows; w++) {
    if (levels[w] < AUDIO_CHECK.silenceDb) {
      if (quietFrom < 0) quietFrom = w;
    } else flush(w);
  }
  flush(windows);

  // 頭が静か（最初の数秒で見るのをやめられやすい）
  const startWindows = Math.min(windows, Math.round(AUDIO_CHECK.startSeconds / AUDIO_CHECK.window));
  if (total >= AUDIO_CHECK.startSeconds && !items.some((i) => i.kind === 'silence' && i.time < EPS)) {
    let loud = false;
    for (let w = 0; w < startWindows; w++) if (levels[w] >= AUDIO_CHECK.startDb) loud = true;
    if (!loud) {
      items.push({
        kind: 'quietStart',
        level: 'info',
        time: 0,
        message: `最初の ${AUDIO_CHECK.startSeconds} 秒に、はっきりした声や音がありません`,
        hint: '頭は見るのをやめられやすい所です。声や音が早く始まるよう、頭を詰めてみてください',
      });
    }
  }

  // 音割れ
  const clips: number[] = [];
  let run = 0;
  for (let i = 0; i < length; i++) {
    let peak = 0;
    for (const ch of channels) peak = Math.max(peak, Math.abs(ch[i]));
    if (peak >= AUDIO_CHECK.clipLevel) {
      run++;
      if (run === AUDIO_CHECK.clipRun) {
        const t = (i - run + 1) / sampleRate;
        if (clips.length === 0 || t - clips[clips.length - 1] > 1) clips.push(t);
      }
    } else run = 0;
  }
  for (const t of clips.slice(0, maxClipping)) {
    items.push({
      kind: 'clipping',
      level: 'warn',
      time: t,
      message: '音が割れています',
      hint: 'その所の音量を下げるか、書き出しの「音量」を入れてください（割れないよう整えます）',
    });
  }
  if (clips.length > maxClipping) {
    items.push({
      kind: 'clipping',
      level: 'warn',
      time: clips[maxClipping],
      message: `ほかにも ${clips.length - maxClipping} か所、音が割れています`,
      hint: '全体の音量を下げるか、書き出しの「音量」を入れてください（割れないよう整えます）',
    });
  }

  return items.sort((a, b) => a.time - b.time);
}
