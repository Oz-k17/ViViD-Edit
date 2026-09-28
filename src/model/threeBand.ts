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
import { bandCrop, coverSource, goldenBands } from './layout';
import { addTrack, placeClip, tracksOf } from './ops';
import type { Clip, Sequence, TextProps } from './types';

export interface ThreeBandOptions {
  /** 顔の帯の寄せ具合。1 で寄せなし。既定は 4 倍（顔のアップくらい）。 */
  faceZoom?: number;
  /** 上の帯に置く見出しの体裁。渡さなければ見出しは作らない。 */
  titleStyle?: TextProps;
  /** 見出しの文言。 */
  titleText?: string;
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

  const backdrop = band(
    videoTracks[0].id,
    bandCrop(coverSource(media, aspect(bands.top)), bands.top),
    backdropEffects(),
  );
  const main = {
    ...band(videoTracks[1].id, bandCrop(coverSource(media, aspect(bands.middle)), bands.middle)),
    muted: clip.muted,
  };
  const face = band(
    videoTracks[2].id,
    bandCrop(coverSource(media, aspect(bands.bottom), options.faceZoom ?? 4), bands.bottom),
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
