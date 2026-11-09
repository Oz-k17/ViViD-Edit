/**
 * 1 本の素材から「上に見出し・中に本編・下に顔」の 3 分割を組む。
 *
 * 切り抜き動画でよく使う形で、横長の配信をそのまま縦に入れると小さくなってしまう所を、
 * 見せたい部分だけ 2 か所取り出して縦に積むことで解く。
 * 帯の高さは黄金比（`layout.ts`）、切り出しは帯と同じ縦横比にして、絵がつぶれないようにする。
 *
 * 切り出す**位置**は素材によって違うので、ここでは中心から取っておくだけにする。
 * 置いたあと、画面の切り抜き操作でつまんで合わせてもらう前提。
 */

import { baseClip, textClip, uid } from './factory';
import { bandCrop, coverSource, goldenBands, type SourceRect } from './layout';
import { addTrack, placeClip, tracksOf } from './ops';
import { fitSourceToAspect, type KitBands } from './kit';
import type { Clip, Sequence, TextProps } from './types';

export interface ThreeBandOptions {
  /** 顔の帯の寄せ具合。1 で寄せなし。既定は 4 倍（顔のアップくらい）。 */
  faceZoom?: number;
  /** 上の帯に置く見出しの体裁。渡さなければ見出しは作らない。 */
  titleStyle?: TextProps;
  /** 見出しの文言。 */
  titleText?: string;
  /**
   * 「自分の型」の切り抜き範囲（素材に対する割合）。渡せば、中心から取る代わりにこの位置で切り抜く。
   * 素材の解像度が型と違っても、帯の形に合わせて直す（kit.ts の fitSourceToAspect）。
   * 帯ごとに省ける（省いた帯は中心から取る。顔の位置だけ決めたレイアウトなど）。
   */
  sources?: Partial<KitBands>;
}

/**
 * 帯 1 本の切り抜き範囲（素材に対する割合）。決めてあればそれを帯の形に合わせ、無ければ中心から取る。
 * `aspect` は帯の画素の縦横比。顔の帯（bottom）は既定で `faceZoom` 倍に寄せる。
 */
export function bandSource(
  key: keyof KitBands,
  aspect: number,
  media: { width: number; height: number },
  sources?: Partial<KitBands>,
  faceZoom = 4,
): SourceRect {
  const chosen = sources?.[key];
  return chosen ? fitSourceToAspect(chosen, media, aspect) : coverSource(media, aspect, key === 'bottom' ? faceZoom : 1);
}

/**
 * 組んである 3 分割の、帯の切り抜き範囲（とあれば見出しの体裁）だけを、別のレイアウトに付け替える。
 * 帯は置き場所（dy・dh）で見分けるので、間を詰めて何本にも分かれていても全部に当たる。時間や音は変えない。
 * `mediaOf` は素材の画素の大きさ（分からなければ null で、その帯は変えない）。
 */
export function relayoutThreeBand(
  sequence: Sequence,
  sources: Partial<KitBands> | undefined,
  mediaOf: (clip: Clip) => { width: number; height: number } | null,
  title?: Omit<TextProps, 'content'> | null,
): { sequence: Sequence; changed: number } {
  const bands = goldenBands(sequence.height);
  const keys: (keyof KitBands)[] = ['top', 'middle', 'bottom'];
  let changed = 0;
  const clips = sequence.clips.map((c) => {
    if (c.kind === 'text' && title && c.text && c.text.role === 'design') {
      changed += 1;
      return { ...c, text: { ...c.text, ...title, content: c.text.content } };
    }
    if (c.kind !== 'video' || !c.crop.enabled || Math.abs(c.crop.dw - 1) > 0.002) return c;
    const key = keys.find((k) => Math.abs(c.crop.dy - bands[k].dy) < 0.002 && Math.abs(c.crop.dh - bands[k].dh) < 0.002);
    const media = key ? mediaOf(c) : null;
    if (!key || !media) return c;
    const src = bandSource(key, sequence.width / bands[key].h, media, sources);
    changed += 1;
    return { ...c, crop: { ...c.crop, sx: src.sx, sy: src.sy, sw: src.sw, sh: src.sh } };
  });
  return { sequence: changed ? { ...sequence, clips } : sequence, changed };
}

/** 背景として敷く帯のぼかしと暗さ。見出しを読ませるために、はっきり落とす。 */
function backdropEffects(): Clip['effects'] {
  return [
    { id: uid('fx'), type: 'blur', intensity: 0.35 },
    { id: uid('fx'), type: 'brightness', intensity: 0.22 },
  ];
}

/**
 * @param clip   元にする映像クリップ。これは取り除かれ、3 本に置き換わる。
 * @param media  素材の画素の大きさ。切り出しの縦横比を合わせるために要る。
 */
export function buildThreeBand(
  sequence: Sequence,
  clip: Clip,
  media: { width: number; height: number },
  options: ThreeBandOptions = {},
): Sequence {
  const bands = goldenBands(sequence.height);
  const aspect = (band: { h: number }) => sequence.width / band.h;

  // 下から順に「背景 → 本編 → 顔」。足りなければ足す。
  let next: Sequence = { ...sequence, clips: sequence.clips.filter((c) => c.id !== clip.id) };
  while (tracksOf(next, 'video').length < 3) {
    next = addTrack(next, 'video', `V${tracksOf(next, 'video').length + 1}`);
  }
  const videoTracks = tracksOf(next, 'video');

  /** 元のクリップから、時間まわりだけを引き継いだ 1 本を作る。 */
  const band = (trackId: string, crop: Clip['crop'], effects: Clip['effects'] = []): Clip => ({
    ...baseClip(clip.kind, trackId),
    mediaId: clip.mediaId,
    start: clip.start,
    duration: clip.duration,
    sourceIn: clip.sourceIn,
    speed: clip.speed,
    volume: clip.volume,
    // 同じ素材を 3 本置くので、音は 1 本（本編）だけ鳴らす。3 本とも鳴ると重なって歪む。
    muted: true,
    crop,
    effects,
  });

  const pick = (key: keyof KitBands, band: { h: number }, zoom = 1) =>
    bandSource(key, aspect(band), media, options.sources, key === 'bottom' ? zoom : 4);
  const backdrop = band(videoTracks[0].id, bandCrop(pick('top', bands.top), bands.top), backdropEffects());
  const main = {
    ...band(videoTracks[1].id, bandCrop(pick('middle', bands.middle), bands.middle)),
    muted: clip.muted,
    // 音声レーンに分けた音とつないであれば、本編がそのつなぎを引き継ぐ（音を失わないように）。
    ...(clip.linkId ? { linkId: clip.linkId } : {}),
  };
  const face = band(
    videoTracks[2].id,
    bandCrop(pick('bottom', bands.bottom, options.faceZoom ?? 4), bands.bottom),
  );

  next = placeClip(next, backdrop);
  next = placeClip(next, main);
  next = placeClip(next, face);

  if (options.titleStyle) {
    const textTrack = tracksOf(next, 'text')[0];
    if (textTrack) {
      const title = textClip(textTrack.id, clip.start, clip.duration, {
        ...options.titleStyle,
        content: options.titleText ?? options.titleStyle.content,
      });
      // 上の帯の真ん中に置く。クリップの y は画面中央からのずれで持っている。
      const centerY = bands.top.y + bands.top.h / 2;
      next = placeClip(next, { ...title, y: centerY / sequence.height - 0.5 });
    }
  }

  return next;
}
