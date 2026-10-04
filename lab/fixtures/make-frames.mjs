/**
 * 試し用の映像（コマの列）を作る。
 *
 *   node lab/fixtures/make-frames.mjs             # 一覧を出すだけ
 *   node lab/fixtures/make-frames.mjs pan         # 1 本だけ作って様子を出す
 *   node lab/fixtures/make-frames.mjs '' portrait # 縦型（9:16 の切り出し）で作る
 *   node lab/fixtures/make-frames.mjs '' native   # 縦型（最初から縦で撮った）で作る
 *   node lab/fixtures/make-frames.mjs '' landscape 30 # コマの速さを変えて作る
 *
 * 音の側の `make-audio.mjs` と同じで、**毎回まったく同じ絵が出る**ようにするために置いている。
 * 乱数に種を固定してあるので、「昨日は 8 本見つけた／今日は 9 本」をそのまま比べられる。
 *
 * ファイルには書き出さない（理由は `scenes.mjs` の頭に書いた）。
 * 呼ぶ側は `renderFixture(name)` でコマの列をその場で作る。
 */

import {
  REFRAME_FIXTURES,
  SCENE_ASPECTS,
  SCENE_FIXTURES,
  SCENE_FPS,
  SCENE_LENGTH,
  SUBJECT_HUE,
  sceneAspect,
  sceneFixture,
  subjectTrackAt,
  subjectsOf,
} from './scenes.mjs';

/** 種を固定した擬似乱数（mulberry32）。音の側と同じものを使う。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 色相・彩度・明度から RGB（0〜255）。場面ごとに色を散らすためだけのもの。 */
function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const table = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [table[0] * 255, table[1] * 255, table[2] * 255];
}

/**
 * 1 つの場面。
 *
 * 模様（`texU` / `texV`）を持たせてあるのは、**パンやズームで絵が動いたことにする**ため。
 * 色の面だけだと横へずらしても画素が 1 つも変わらず、「カメラが動いても切らない」を
 * 試したつもりで何も試していないことになる。
 */
function makeShot(rnd, { palette = null, dark = false, tint = null, span = 1, spanV = 1, fine = 0, horizon = null } = {}) {
  const hue = rnd();
  const top = palette ? palette.top.slice() : hsv(hue, 0.45 + 0.35 * rnd(), 0.55 + 0.35 * rnd());
  const bottom = palette
    ? palette.bottom.slice()
    : hsv((hue + 0.12 + 0.25 * rnd()) % 1, 0.45 + 0.35 * rnd(), 0.25 + 0.3 * rnd());

  // `span` は「画面何枚ぶんの帯を持つか」。1 なら画面ぶんだけで、パンすると同じ絵が巡る。
  // 大きくすると帯そのものが長くなり、パンで**新しい中身が入ってくる**。
  const wide = Math.max(1, Math.ceil(span));
  // `spanV` は縦の帯。縦は**巻き戻せない**（上下の階調が seam で段差になり、そこが偽のカットになる）ので、
  // 縦へ振るときは必ず「画面何枚ぶんか」の長さを持たせて、その中を通り抜ける形にする。
  const tall = Math.max(1, Math.ceil(spanV));
  const texU = Float64Array.from({ length: 24 * wide }, () => rnd());
  const texV = Float64Array.from({ length: 12 * tall }, () => rnd());

  const blobs = [];
  const count = (3 + Math.floor(rnd() * 3)) * wide * tall;
  for (let i = 0; i < count; i += 1) {
    blobs.push({
      cx: rnd(),
      // 縦の帯を持つときは、置き場所も大きさも**帯の座標**で持つ。
      // 画面ぶんの 0.09〜0.27 が、帯の中では spanV 分の 1 の大きさになる。
      cy: spanV > 1 ? rnd() : 0.15 + 0.7 * rnd(),
      rx: 0.07 + 0.16 * rnd(),
      ry: (0.09 + 0.18 * rnd()) / spanV,
      color: palette ? palette.blob.slice() : hsv(rnd(), 0.35 + 0.5 * rnd(), 0.3 + 0.6 * rnd()),
      vx: (rnd() - 0.5) * 0.03,
      vy: (rnd() - 0.5) * 0.02,
    });
  }

  if (dark) {
    // 暗所のつもり。色を残したまま全体を落とす（真っ黒にすると粒ノイズしか残らない）。
    for (const c of [top, bottom]) for (let i = 0; i < 3; i += 1) c[i] *= 0.13;
    for (const b of blobs) for (let i = 0; i < 3; i += 1) b.color[i] *= 0.16;
  }

  if (tint) {
    // 明るさを揃えたまま色だけを変える素材のため、灰色にしてから色味を掛ける。
    // 掛ける色味は明るさが 1 になるよう正規化してあるので、`lumaHist` は 1 段も動かない。
    for (const c of [top, bottom]) {
      const gray = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      for (let i = 0; i < 3; i += 1) c[i] = gray * tint[i];
    }
    for (const b of blobs) {
      const gray = 0.2126 * b.color[0] + 0.7152 * b.color[1] + 0.0722 * b.color[2];
      for (let i = 0; i < 3; i += 1) b.color[i] = gray * tint[i];
    }
  }

  // 細かい肌理の粗さ。**画面の幅に対して**決める（96 升 ≒ 128 画素の画面で 1.3 画素ごと）。
  // 縦横で同じ密度になるよう 16:9 で割ってある。ここを画素の数で決めてしまうと、
  // 縦型で測ったときに肌理の細かさまで一緒に変わって、何が効いたのか分からなくなる。
  // 種は `fine` を使うときだけ引く。使わない素材で 1 つ余分に引くと、
  // そのあとの乱数の列がまるごとずれて**既存の素材の絵が変わってしまう**。
  const fineSeed = fine > 0 ? Math.floor(rnd() * 1e9) : 0;
  // `horizon` は**上下の階調を直線でなくする**口（2026-10-04）。
  // 縦のリフレームは「背景の階調を直線とみなして外す」手を使っているので、
  // **直線で表せない背景**＝空と地面がくっきり分かれた絵が、その手を潰す相手になる。
  // 種を 1 つも余分に引かないので、この口を使わない素材の絵は 1 画素も変わらない。
  return { top, bottom, texU, texV, blobs, fine, fineU: 96, fineV: 54, fineSeed, horizon };
}

/**
 * 明るさを変えずに色味だけを変える掛け算。
 *
 * 明るさ（Rec.709）が 1 になるよう割り戻してある。**飽和させると崩れる**ので、
 * 掛ける前の灰色と掛け算の最大が 255 を超えないよう、控えめな振り幅にしてある。
 */
function lumaNeutralTint(index) {
  const table = [
    [1.0, 1.0, 1.0],
    [1.35, 0.9, 1.25],
    [0.75, 1.1, 1.3],
    [1.2, 0.95, 0.7],
  ];
  const t = table[index % table.length];
  const l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  return [t[0] / l, t[1] / l, t[2] / l];
}

/**
 * 2 つの整数から 0〜1 の値を作る（細かい模様のため）。
 *
 * 配列を持たずに済ませているのは、**帯の長さが素材ごとに変わる**ため
 * （パンで 14 画面ぶん流れる素材だと、画素と同じ細かさの配列は現実的でない）。
 * 種を混ぜて散らすだけなので、同じ座標なら毎回まったく同じ値が出る。
 */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h = (h + Math.imul(h ^ (h >>> 7), 61 | h)) ^ h;
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

/**
 * 細かい模様（画素 1〜2 つぶんの粗さ）を滑らかに読む。
 *
 * 2026-09-23 に足した。**ボケを測るには、ボケて失われるものが絵の中に要る**。
 * それまでの素材は色の面と丸い塊だけで、隣どうしの差が 0.007 しか無かった
 * （128 画素の幅に模様の山が 24 個しか無い）。そこへ動きボケを掛けても
 * 消えるものが無く、**ボケたコマと鮮明なコマの差が 3 桁目にしか出ない**。
 * 本物の映像には髪・布・草・肌理があり、真っ先に潰れるのはそこなので、
 * ここが無いと「ボケを見分けた」と言っても何も見分けていない。
 *
 * 角で値を決めて滑らかに繋ぐ（value noise）。段差にすると、それ自体が輪郭になる。
 */
function fineTexture(u, v, scaleU, scaleV, seed) {
  const x = u * scaleU;
  const y = v * scaleV;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** 模様を滑らかに読む（端は巻き戻す）。段差にすると、そこが偽のカットになってしまう。 */
function sampleWrap(arr, u) {
  const n = arr.length;
  const x = (((u % 1) + 1) % 1) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = arr[i % n];
  const b = arr[(i + 1) % n];
  return a + (b - a) * (f * f * (3 - 2 * f));
}

/**
 * 場面の 1 画素。u は横（巻き戻す）、v は縦（0〜1 に丸める）。
 *
 * `span` は帯の長さ（画面何枚ぶんか）。u を帯の座標へ直してから読むので、
 * 帯が長ければパンしても同じ絵が戻ってこない。
 */
function shotPixel(shot, u, v, t, out, span = 1, spanV = 1) {
  const uw = (((u / span) % 1) + 1) % 1;
  // 縦は巻き戻さず、帯の座標へ直してから 0〜1 に丸める（帯の外は端の色が続く）。
  const vv = v / spanV;
  const vc = vv < 0 ? 0 : vv > 1 ? 1 : vv;
  let shade = 0.68 + 0.32 * (0.6 * sampleWrap(shot.texU, uw) + 0.4 * sampleWrap(shot.texV, vc));
  if (shot.fine > 0) {
    // 細かい肌理。**帯の座標で読む**ので、カメラが動けば模様も一緒に流れる
    // ——つまりシャッターの中で動けば、そのぶんきちんと潰れる。
    shade *= 1 + shot.fine * (fineTexture(uw * span, vc * spanV, shot.fineU, shot.fineV, shot.fineSeed) - 0.5);
  }
  // 階調の読み所。既定は上から下へまっすぐ。`horizon` があるときは、
  // そこで一気に渡る形（空と地面）にする。**にじみを 0 にしない**のは、
  // 1 画素で立てると手ぶれだけで大きな差が出てしまうため（blob の縁と同じ理由）。
  let grad = vc;
  if (shot.horizon != null) {
    const edge = 0.03;
    const step = Math.min(1, Math.max(0, (vc - shot.horizon) / edge + 0.5));
    grad = 0.1 * vc + 0.9 * step;
  }
  for (let i = 0; i < 3; i += 1) {
    out[i] = (shot.top[i] + (shot.bottom[i] - shot.top[i]) * grad) * shade;
  }
  for (const b of shot.blobs) {
    let bx = b.cx + b.vx * t;
    bx = ((bx % 1) + 1) % 1;
    const by = b.cy + (b.vy * t) / spanV;
    let du = uw - bx;
    if (du > 0.5) du -= 1;
    if (du < -0.5) du += 1;
    const dv = vc - by;
    const d = (du / b.rx) * (du / b.rx) + (dv / b.ry) * (dv / b.ry);
    if (d < 1) {
      // 縁を少しぼかす。輪郭が 1 画素で立つと、手ぶれだけで大きな差が出てしまう。
      const a = Math.min(1, (1 - d) * 2.2);
      for (let i = 0; i < 3; i += 1) out[i] += (b.color[i] - out[i]) * a;
    }
  }
}

/**
 * 焼き込みの文字帯（字幕・見出し・アカウント名）を組み立てる（2026-09-22・3 回目）。
 *
 * 短尺の動画ではほぼ必ず乗っていて、**場面が切り替わっても 1 画素も動かない**。
 * 分布どうしの距離は「動いた画素の割合」でしかないので、帯が画面の k を占めるなら
 * **どのカットの距離も (1-k) 倍に薄まる**——つまり固定の線の余裕を直接食う。
 * ここを合成で作れるようにしておかないと、その薄まりが数字にならない。
 *
 * 形は「暗い板の上に明るい字の升目」。本物の字形を真似る必要は無くて、
 * 要るのは**占める割合が決まっていること**と**時間で動かないこと**の 2 つだけ。
 * `changeEvery` を付けると下の帯（字幕）だけが書き換わる。上（見出し）は動かさない。
 *
 * ## 透ける帯（2026-09-24）
 *
 * `alpha` は**板の不透明度**（既定 1 ＝ 不透明。9/22・3 回目までの帯はこれ）。
 * 板だけを分けているのは、実際の字幕がその形だから——**半透明なのは背景の板で、
 * 字そのものは読ませるために不透明**に置く。板も字もまとめて薄くする置き方
 * （素材ごと不透明度を下げる編集）も測れるように、字の側は `inkAlpha` で別に持つ。
 *
 * 透けると「1 画素も動かない領域」が**板の下だけ動く領域**に変わる。
 * 薄まりが (1-k) 倍で決まるという読みが正しければ、板が透けたぶんだけ k が減って
 * 距離が戻るはず——それが戻るかどうかがこの回の題。
 *
 * ## 字の縁取り（2026-09-24・2 回目）
 *
 * `outline` は**字の周りの暗い輪郭**の太さ。板と違って**字と一緒に動く**ので、
 * 書き換わるたびに位置が変わる。単位は**画面の高さに対する割合**にしてある
 * （帯の厚みに対する割合ではない）。本物の縁取りは字の大きさで決まるもので、
 * 帯を厚くしても太らないから。1080p の 4 画素なら 4/1080 ＝ 0.0037。
 *
 * `samples` は**画素の中を何等分して面積で混ぜるか**（既定 1 ＝ 点で測る。
 * それまでの帯と 1 ビットも変わらない）。縁取りにこれが要るのは、
 * **現実の縁取りが測るコマでは 1 画素より細い**から——128×72 で 0.0037 は 0.27 画素で、
 * 点で測ると画素の中心に当たるかどうかの運になる（当たらなければ丸ごと消える）。
 * 本物の映像は 1920×1080 で焼いてから縮むので、細い線は**消えずに薄まって**残る。
 * それを作るには面積で混ぜるほかない。
 *
 * **混ぜるのは帯の中だけ**にしてある。絵の側まで面積で混ぜると、
 * 手ぶれやパンの当たり方まで一緒に変わってしまい、
 * 「縁取りを足したから動いた」のか「混ぜ方を変えたから動いた」のかが分からなくなる。
 */
function buildCaptions(spec, seed, view) {
  const top = spec.top ?? 0;
  const bottom = spec.bottom ?? 0;
  const changeEvery = spec.changeEvery ?? 0;
  const alpha = opacity(spec.alpha ?? 1);
  const inkAlpha = opacity(spec.inkAlpha ?? 1);
  const outline = thickness(spec.outline ?? 0);
  const samples = subSamples(spec.samples ?? 1);
  const cells = 16;
  // 升目の並びを何通りか先に作っておく。書き換えるときはこの中を順に使う。
  const patterns = [];
  const variants = changeEvery > 0 ? Math.max(2, Math.ceil(SCENE_LENGTH / changeEvery)) : 1;
  for (let i = 0; i < variants + 1; i += 1) {
    const r = rng(seed * 31 + i * 7);
    patterns.push(Array.from({ length: cells }, () => r() < 0.62));
  }
  return {
    top,
    bottom,
    changeEvery,
    cells,
    patterns,
    alpha,
    inkAlpha,
    outline,
    samples,
    // 縁取りの太さは高さの割合で受けるので、横へは**画面の縦横比のぶんだけ縮める**
    // （そうしないと横に太い縁取りになる）。切り出した縦型では受け皿が縦長なので、
    // 同じ 1 つの数から出る横の太さは向きごとに変わる——それが正しい。
    outlineU: (outline * view.height) / view.width,
    outlineV: outline,
    plate: [22, 20, 26],
    ink: [236, 236, 228],
    // 縁取りは**字と同じ不透明度**で置く（読ませるための線なので、板と一緒に透かさない）。
    // 色は黒。板（22,20,26）とは明るさの升目で 2 つ離れるが、
    // **色の升目（4×4×4）では板と同じ所に落ちる**——`rgbHist` からは見えない線になる。
    stroke: [0, 0, 0],
  };
}

/** 不透明度として受け取れる値か見る。**範囲の外は黙って詰めない**（帯の厚みと同じ扱い）。
 * 黙って詰めると「透かしたつもりで透けていない表」が出る。 */
function opacity(v) {
  if (!Number.isFinite(v)) throw new Error(`不透明度は 0〜1 の数です（${v}）`);
  if (v < 0 || v > 1) throw new Error(`不透明度は 0〜1 の数です（${v}）`);
  return v;
}

/**
 * 縁取りの太さ（画面の高さに対する割合）。
 *
 * 上限 0.05 は**思い違いを弾くための線**で、「これなら字が埋まらない」という保証ではない
 * （字の高さは帯の厚み × 0.45 なので、薄い帯では 0.05 は字より太い）。
 * 帯の厚みと同じく**範囲の外は黙って詰めない**——詰めると「太くしたつもりの表」が出る。
 */
function thickness(v) {
  if (!Number.isFinite(v) || v < 0 || v > 0.05) throw new Error(`縁取りの太さは 0〜0.05 の数です（${v}）`);
  return v;
}

/** 画素の中を何等分するか。1 は「点で測る」＝面積で混ぜない。 */
function subSamples(v) {
  if (!Number.isInteger(v) || v < 1 || v > 32) throw new Error(`分割数は 1〜32 の整数です（${v}）`);
  return v;
}

/**
 * その画素が文字帯なら、`out` へ色と不透明度を書いて true を返す。帯の外なら false。
 *
 * 帯の内側に少し余白を取ってあるのは、**板と字の割合を現実に寄せる**ため。
 * 板が全部字だと、書き換えたときの距離が実際よりずっと大きく出る。
 *
 * 色と不透明度を分けて渡しているのは、**混ぜるのは呼ぶ側の仕事**にするため。
 * ここで混ぜてしまうと、下の絵（粒ノイズまで乗ったあとの値）を引数で渡す羽目になる。
 * 受け皿を使い回すのは `shotPixel` と同じ理由で、**画素ごとに物を作らない**ため
 * （1 本 195 コマ × 9216 画素あるので、ここでの 1 つは 180 万個になる）。
 */
function captionAt(caps, u0, v0, t, out) {
  const inTop = caps.top > 0 && v0 < caps.top;
  const inBottom = caps.bottom > 0 && v0 > 1 - caps.bottom;
  if (!inTop && !inBottom) return false;

  // 上は見出し（動かない）、下は字幕（`changeEvery` ごとに書き換わる）。
  const index = inBottom && caps.changeEvery > 0 ? 1 + Math.floor(t / caps.changeEvery) : 0;
  const pattern = caps.patterns[index % caps.patterns.length];

  const band = inTop ? { from: 0, to: caps.top } : { from: 1 - caps.bottom, to: 1 };
  if (litAt(caps, pattern, band, u0, v0)) {
    out.color = caps.ink;
    out.alpha = caps.inkAlpha;
    return true;
  }
  // 縁取りは「字ではないが、字から縁取りの太さのうちにある所」。
  // 板と同じ升目に混ざらないよう、字の側を先に見てから引く。
  if (caps.outline > 0 && nearInk(caps, pattern, band, u0, v0)) {
    out.color = caps.stroke;
    out.alpha = caps.inkAlpha;
    return true;
  }
  out.color = caps.plate;
  out.alpha = caps.alpha;
  return true;
}

/**
 * その点が字（明るい升目）の上かどうか。
 *
 * 帯の内側に少し余白を取ってあるのは `captionAt` の注のとおり。
 * **`u0` の余白は帯ぜんたいに 1 回だけ掛かる**ので、隣り合う升目が両方点いていれば
 * 字は横に繋がる。縁取りが「升目の数」ではなく**「かたまりの数」で決まる**のはそのため。
 */
function litAt(caps, pattern, band, u0, v0) {
  if (!(u0 > 0.06 && u0 < 0.94)) return false;
  const h = (v0 - band.from) / (band.to - band.from);
  if (!(h > 0.3 && h < 0.75)) return false;
  return pattern[Math.min(caps.cells - 1, Math.floor(u0 * caps.cells))];
}

/**
 * 字から縁取りの太さのうちにあるか。
 *
 * 字は軸に平行な四角の集まりなので、**8 方向を突いて 1 つでも字に当たれば縁の中**
 * （四角の周りの、角まで四角い輪になる）。距離の式を書く形にしないのは、
 * 升目が繋がったときの輪郭が「1 つの四角」ではなくなるため。
 */
function nearInk(caps, pattern, band, u0, v0) {
  const du = caps.outlineU;
  const dv = caps.outlineV;
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      if (i === 0 && j === 0) continue;
      if (litAt(caps, pattern, band, u0 + i * du, v0 + j * dv)) return true;
    }
  }
  return false;
}

/**
 * 帯を 1 画素ぶん、**面積で**混ぜる（2026-09-24・2 回目）。
 *
 * 画素の中を `samples` × `samples` に割って、それぞれの点で帯を引き、
 * **不透明度を先に掛けて（premultiplied）足す**。最後に 1 回だけ下の絵へ乗せる。
 * 足しながら 1 点ずつ下の絵へ乗せる形にすると、同じ画素を何度も塗り重ねることになり、
 * 覆っている割合が指数で効いてしまう（0.5 を 2 回で 0.75）。
 *
 * これが要る理由は `buildCaptions` の注のとおりで、**現実の縁取りは測るコマでは
 * 1 画素より細い**。点で測ると当たり外れになるので、割合として残すには面積で混ぜる。
 * 逆に言えば、この道は**縁取りが無くても帯の縁を滑らかにする**ので、
 * 縁取りの効きを測るときは「面積で混ぜただけ」の列も並べて見ること。
 */
function overlayCaptionArea(caps, u0, v0, du, dv, t, data, p, cap) {
  const n = caps.samples;
  const each = 1 / (n * n);
  let a = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let j = 0; j < n; j += 1) {
    const v = v0 + ((j + 0.5) / n - 0.5) * dv;
    for (let i = 0; i < n; i += 1) {
      const u = u0 + ((i + 0.5) / n - 0.5) * du;
      if (!captionAt(caps, u, v, t, cap)) continue;
      const w = cap.alpha * each;
      if (w <= 0) continue;
      a += w;
      r += cap.color[0] * w;
      g += cap.color[1] * w;
      b += cap.color[2] * w;
    }
  }
  if (a <= 0) return;
  data[p] = data[p] * (1 - a) + r;
  data[p + 1] = data[p + 1] * (1 - a) + g;
  data[p + 2] = data[p + 2] * (1 - a) + b;
}

/**
 * 素材 1 本ぶんのコマを作る（名前で引く）。
 *
 * 返すのは `{ width, height, fps, times, frames }`。
 * `frames[i]` は RGBA の `Uint8ClampedArray`（`ImageData.data` と同じ並び）。
 * 本物の動画を縮めて渡すときと同じ形にしてある。
 */
export function renderFixture(name, opts = {}) {
  return renderSpec(sceneFixture(name), opts);
}

/**
 * 素材 1 本ぶんのコマを作る（正解の入れ物をそのまま渡す）。
 *
 * `renderFixture` と中身は同じで、**一覧に載っていない素材も描ける**ようにしてある
 * （2026-09-23）。サムネイルの側は正解の付け方が「どこで切り替わるか」ではなく
 * 「どのコマが使い物になるか」なので、`SCENE_FIXTURES` とは別の一覧を持つ。
 * 描く仕掛けまで書き写すと、片方を直したときにもう片方が静かに古くなる。
 */
export function renderSpec(
  fixture,
  {
    aspect = 'landscape',
    fps = SCENE_FPS,
    captionCover = 0,
    captionAlpha = null,
    captionInkAlpha = null,
    captionOutline = null,
    captionSamples = null,
    scale = 1,
  } = {},
) {
  const o = fixture.options ?? {};
  const view = sceneAspect(aspect);
  // `scale` は**描く大きさそのもの**を変える口（2026-09-24・2 回目）。
  // 既定の 1 は 128×72 ＝ これまでの大きさ。15 なら 1920×1080 になる。
  // 要るのは書き出しの側で、**細い線を細い線として焼くには実寸で描くほかない**
  // （表紙の書き出しは 128×72 を 15 倍して焼いているので、1 画素の線が 15 画素の帯になる）。
  // シーン検出の側では使わない——測るコマは本物でも縮めて渡すから。
  if (!Number.isInteger(scale) || scale < 1 || scale > 32) throw new Error(`scale は 1〜32 の整数です（${scale}）`);
  const width = view.width * scale;
  const height = view.height * scale;
  // 縦型は「同じ絵を縦長の受け皿に描き直す」のではなく、**横型の画面から横を切り出す**。
  // 理由は `scenes.mjs` の `PORTRAIT_CROP_U` の注に書いた。
  const cropU = view.cropU;
  // コマの速さは素材の側の話（描く絵は秒で決まるので、何コマ刻むかだけが変わる）。
  // **既定を変える口ではなく、「コマ数で決めたつまみが速さに耐えるか」を測る口**として足した。
  // 本物の動画は 30fps 級で来るのに、既定の `straddleFrames` も `localWindow` も
  // コマ数で書いてあるので、同じ数字が別の秒数を意味してしまう。
  if (!(fps > 0)) throw new Error(`fps は正の数です（${fps}）`);
  const total = Math.round(SCENE_LENGTH * fps);

  const rnd = rng(o.seed ?? 1);
  const cutsAt = o.cutsAt ?? [];
  // 同じ配色のまま模様だけ変える素材のため、先に色を決めて共有する。
  const palette = o.samePalette
    ? { top: hsv(0.58, 0.5, 0.72), bottom: hsv(0.62, 0.55, 0.34), blob: hsv(0.55, 0.45, 0.5) }
    : null;

  /**
   * カメラの横の位置（画面何枚ぶん動いたか）。
   *
   * `pan` はずっと同じ速さで流れる。`whip` を付けると、その区間だけ**速く振る**
   * （2026-09-23）。速さを時間で変えられないと「ブレているコマとブレていないコマが
   * 同じ素材の中に並ぶ」形が作れず、サムネイルの選び分けを測る相手が用意できない。
   * 区間の外では止まる（位置は保つ）ので、振り切った先の絵がそのまま続く。
   */
  const panAt = (t) => {
    let p = (o.pan ?? 0) * t;
    if (o.whip) {
      const { from, to, speed } = o.whip;
      p += speed * Math.min(Math.max(t - from, 0), to - from);
    }
    return p;
  };

  /**
   * シャッター（動きボケ）。`{ frames: k, open: 0.5 }` で、1 コマを k 枚の平均にする。
   *
   * **ボケの量を自分で決めない**のがここの要点で、サブコマの間にカメラが動いた
   * ぶんだけボケる。後からぼかすと「どれくらいボケているか」を作る側が決めてしまい、
   * 測る側はその数字を測り返すだけになる。`open` は 1 コマのうちシャッターが
   * 開いている割合（写真の 180 度シャッターが 0.5）。
   */
  const shutterFrames = Math.max(1, Math.round(o.shutter?.frames ?? 1));
  const shutterOpen = o.shutter?.open ?? 0.5;

  // パンで新しい中身が入ってくる素材では、帯をパンの距離ぶんだけ長く持つ。
  const span = o.panReveal ? 1 + panAt(SCENE_LENGTH) : 1;
  // 縦へ振る素材では、**必ず**振った距離ぶんの帯を持つ（縦は巻き戻せないので選択肢が無い）。
  const spanV = o.tilt ? 1 + o.tilt * SCENE_LENGTH : 1;

  // `shotOrder` は「区切りごとにどの場面を出すか」。同じ場面へ戻る（切り返し・インサート）ため。
  const order = o.shotOrder ?? null;
  const shotCount = order
    ? Math.max(...order) + 1
    : cutsAt.length + 1 + (o.dissolve || o.fadeBlack ? 1 : 0);
  const shots = [];
  if (o.sameLuma) {
    // 明るさを揃える素材では、場面の骨格（模様と配置）まで同じにする。
    // 骨格まで変えると「色が違うのか形が違うのか」が分からなくなるため。
    // 種を場面ごとに作り直すので、骨格（模様と配置）は 1 ビットも同じになる。
    for (let i = 0; i < shotCount; i += 1) {
      shots.push(
        makeShot(rng((o.seed ?? 1) + 1), { tint: lumaNeutralTint(i), span, spanV, fine: o.fine ?? 0, horizon: o.horizon ?? null }),
      );
    }
  } else {
    for (let i = 0; i < shotCount; i += 1) {
      shots.push(makeShot(rnd, { palette, dark: o.dark, span, spanV, fine: o.fine ?? 0, horizon: o.horizon ?? null }));
    }
  }

  // 横切る被写体は場面の一部ではなく、カメラの前を通るものとして別に持つ。
  //
  // 大きさも道筋も**正解を返す側（`scenes.mjs` の `subjectsOf`）から受け取る**
  // （2026-09-24・3 回目）。もとはここに `-0.3 + 1.6 * (t / SCENE_LENGTH)` と直に書いてあったが、
  // 自動リフレームを測るには「被写体がいまどこに居るか」が正解として要るので、
  // **描く側と測る側が同じ 1 か所を読む**形へ直した。
  // `crossing: 'vertical'`（長いほうの軸を入れ替えるだけ）もそちらで均してある。
  const subjects = subjectsOf(fixture).map((sub) => ({
    axis: sub.axis,
    rx: sub.rx,
    ry: sub.ry,
    keys: sub.keys,
    color: hsv(sub.hue ?? SUBJECT_HUE, 0.7, 0.95),
  }));
  const subjectPos = new Float64Array(subjects.length);

  // 焼き込みの文字帯。**切り出しより後に乗る**ものなので、画面の座標（u0・v0）で置く。
  //
  // `captionCover` は**どの素材にも帯を焼ける**つまみ（画面の高さの何割を覆うか）。
  // 帯が効くのは「もともと弱かったカット」のはずなので、
  // 強いカット 1 本（`cuts-captions`）だけを見ていても、破れる所は見えない。
  // 上下の割り振りは既定の帯と同じ 10:16（見出しより字幕のほうが厚い）。
  const cover = captionCover > 0 ? { top: (captionCover * 10) / 26, bottom: (captionCover * 16) / 26 } : null;
  // `captionAlpha` / `captionInkAlpha` は**帯を持つ素材の透け方だけ**を差し替えるつまみ
  // （2026-09-24）。帯の厚みと違って**帯の無い素材には何も足さない**ので、
  // 「同じ素材の帯を透かすと何が戻るか」が 1 本の差として出る。
  const sheer = {};
  if (captionAlpha !== null) sheer.alpha = captionAlpha;
  if (captionInkAlpha !== null) sheer.inkAlpha = captionInkAlpha;
  // 縁取りと分割数も同じ立場の口にしてある（2026-09-24・2 回目）。
  // 素材の一覧を書き換えずに振れないと、「縁取りだけを足した 1 本の差」が測れない。
  if (captionOutline !== null) sheer.outline = captionOutline;
  if (captionSamples !== null) sheer.samples = captionSamples;
  const captionSpec = cover || o.captions ? { ...(o.captions ?? {}), ...(cover ?? {}), ...sheer } : null;
  const captions = captionSpec ? buildCaptions(captionSpec, o.seed ?? 1, { width, height }) : null;

  const times = new Float64Array(total);
  const frames = [];
  const rgb = [0, 0, 0];
  const rgbB = [0, 0, 0];
  // 文字帯の受け皿。画素ごとに作らないよう 1 つを使い回す。
  const cap = { color: null, alpha: 1 };

  // 1 コマぶんの受け皿（RGB の生の値）。シャッターが開いているあいだの平均をここへ溜める。
  const acc = new Float64Array(width * height * 3);

  /**
   * 秒 `t` の絵を `acc` へ `weight` の重みで足す。
   *
   * 粒ノイズと文字帯をここへ入れていないのは、**どちらもシャッターの後に乗るもの**だから。
   * 粒は撮像素子がコマ単位で出すもので、平均すると本来より静かになってしまう。
   * 文字帯は編集で最後に乗るので、カメラがどれだけ振られていても鮮明なまま残る
   * ——その「帯だけ鮮明」がサムネイルの選び分けを潰す側の性質なので、消してはいけない。
   */
  function drawInto(t, frameIndex, weight) {
    // --- このコマで何が起きているか ---
    let index = 0;
    for (const c of cutsAt) if (t >= c - 1e-9) index += 1;
    let shot = order ? shots[order[Math.min(index, order.length - 1)]] : shots[Math.min(index, shots.length - 1)];
    let other = null;
    let mix = 0;

    if (o.dissolve) {
      const { at, seconds } = o.dissolve;
      const from = at - seconds / 2;
      if (t >= from + seconds) {
        shot = shots[1];
      } else if (t >= from) {
        other = shots[1];
        mix = (t - from) / seconds;
      }
    }

    let fade = 1;
    if (o.fadeBlack) {
      const { at, hold, ramp } = o.fadeBlack;
      const downFrom = at - hold / 2 - ramp;
      const downTo = at - hold / 2;
      const upFrom = at + hold / 2;
      const upTo = at + hold / 2 + ramp;
      if (t >= upTo) {
        shot = shots[1];
      } else if (t >= upFrom) {
        shot = shots[1];
        fade = (t - upFrom) / ramp;
      } else if (t >= downTo) {
        fade = 0;
      } else if (t >= downFrom) {
        fade = 1 - (t - downFrom) / ramp;
      }
    }

    // フラッシュは 2 コマで立ち上がって落ちる。1 コマだけだと「コマ落ち」と区別が付かない。
    let flash = 0;
    for (const at of o.flashes ?? []) {
      const d = Math.abs(t - at);
      if (d < 2.5 / fps) flash = Math.max(flash, 0.92 * (1 - d / (2.5 / fps)));
    }

    const pan = panAt(t);
    const tilt = (o.tilt ?? 0) * t;
    const zoom = 1 + (o.zoom ?? 0) * t;
    // 手ぶれはコマ**ごと**の揺れとして置いてある（シャッターの中では動かさない）。
    // 揺れの中身をサブコマごとに振り直すと、「コマとコマの間で跳ねる」はずの量が
    // 1 コマの中の平均に化けて、手持ちの素材の性質そのものが変わってしまう。
    const shakeRnd = rng((o.seed ?? 1) * 7919 + frameIndex);
    const shakeU = o.shake ? (shakeRnd() - 0.5) * o.shake : 0;
    const shakeV = o.shake ? (shakeRnd() - 0.5) * o.shake : 0;
    // 横切るものは 13 秒かけて画面の外から外へ抜ける。縦のときは同じ道筋を縦に置く。
    // 途中で止まる道筋（`subject-pause`）も折れ線として同じ口から出てくる。
    for (let si = 0; si < subjects.length; si += 1) subjectPos[si] = subjectTrackAt(subjects[si], t);

    for (let y = 0; y < height; y += 1) {
      const v0 = (y + 0.5) / height;
      for (let x = 0; x < width; x += 1) {
        const u0 = (x + 0.5) / width;
        // 切り出しはカメラの前ではなく後ろ（撮れた画面を切る）なので、
        // ズーム・パン・手ぶれより先に効かせる。こうすると縦型では
        // 揺れもパンも**画面に対して 3.16 倍**になる——それが切り出しの代価そのもの。
        const uFrame = 0.5 + (u0 - 0.5) * cropU;
        const u = 0.5 + (uFrame - 0.5) / zoom + pan + shakeU;
        const v = 0.5 + (v0 - 0.5) / zoom + shakeV + tilt;

        shotPixel(shot, u, v, t, rgb, span, spanV);
        if (other) {
          shotPixel(other, u, v, t, rgbB, span, spanV);
          for (let i = 0; i < 3; i += 1) rgb[i] += (rgbB[i] - rgb[i]) * mix;
        }

        for (let si = 0; si < subjects.length; si += 1) {
          // 横切る被写体は場面の一部ではなくカメラの前を通るものなので、
          // **切り出す前の画面**の座標で置く。横型では `uFrame === u0` なので
          // ここを切り替えても横型の絵は 1 ビットも変わらない。
          const sub = subjects[si];
          const at = subjectPos[si];
          const du = sub.axis === 'v' ? uFrame - 0.5 : uFrame - at;
          const dv = sub.axis === 'v' ? v0 - at : v0 - 0.5;
          const d = (du / sub.rx) * (du / sub.rx) + (dv / sub.ry) * (dv / sub.ry);
          if (d < 1) {
            const a = Math.min(1, (1 - d) * 3);
            // 重なったときは後ろに書いたものが上に乗る（おとりは主役より小さく・後ろ）。
            for (let i = 0; i < 3; i += 1) rgb[i] += (sub.color[i] - rgb[i]) * a;
          }
        }

        const q = (y * width + x) * 3;
        for (let i = 0; i < 3; i += 1) {
          let c = rgb[i] * fade;
          if (flash > 0) c += (255 - c) * flash;
          acc[q + i] += c * weight;
        }
      }
    }
  }

  for (let f = 0; f < total; f += 1) {
    const t = f / fps;
    times[f] = t;
    acc.fill(0);

    // シャッターが開いているあいだを等間隔に割って平均する。
    // 1 枚だけのときは**コマの頭そのもの**を描く（＝シャッターを足す前と 1 ビットも変わらない）。
    for (let s = 0; s < shutterFrames; s += 1) {
      const offset = shutterFrames === 1 ? 0 : (((s + 0.5) / shutterFrames) * shutterOpen) / fps;
      drawInto(t + offset, f, 1 / shutterFrames);
    }

    const data = new Uint8ClampedArray(width * height * 4);
    const grainRnd = rng((o.seed ?? 1) * 104729 + f);
    const grain = (o.grain ?? 0) * 255;
    for (let y = 0; y < height; y += 1) {
      const v0 = (y + 0.5) / height;
      for (let x = 0; x < width; x += 1) {
        const u0 = (x + 0.5) / width;
        const p = (y * width + x) * 4;
        const q = (y * width + x) * 3;
        // 粒ノイズは帯の下でも同じ数だけ引いておく（帯の有無で乱数の列がずれないように）。
        for (let i = 0; i < 3; i += 1) {
          let c = acc[q + i];
          if (grain > 0) c += (grainRnd() - 0.5) * grain;
          data[p + i] = c;
        }
        if (captions) {
          // 文字は**編集で最後に乗せる**ものなので、フェードもフラッシュも粒も通さない。
          // 不透明なら、ここが「カットしても 1 画素も動かない領域」になる。
          // 透けるときは下の絵（粒まで乗ったあとの値）と混ぜるので、
          // **その割合ぶんだけ動く領域**に変わる。混ぜ算は素直な α 合成。
          if (captions.samples > 1) {
            // 面積で混ぜる道（2026-09-24・2 回目）。**画素の中心が帯の外でも呼ぶ**ので、
            // 帯の縁にかかった画素もそのぶんだけ混ざる。点の道は 1 ビットも動かさない。
            overlayCaptionArea(captions, u0, v0, 1 / width, 1 / height, t, data, p, cap);
          } else if (captionAt(captions, u0, v0, t, cap)) {
            const a = cap.alpha;
            if (a >= 1) {
              for (let i = 0; i < 3; i += 1) data[p + i] = cap.color[i];
            } else if (a > 0) {
              // `data` は Uint8ClampedArray なので、読み戻すと丸めが 1 度入る。
              // 帯の外と同じ丸めなので、混ぜる前の値を別に持つ理由は無い。
              for (let i = 0; i < 3; i += 1) data[p + i] = data[p + i] + (cap.color[i] - data[p + i]) * a;
            }
          }
        }
        data[p + 3] = 255;
      }
    }

    // `ImageData` と同じ形で返す。本物の動画を縮めて `getImageData()` した結果と入れ替えられる。
    frames.push({ width, height, data });
  }

  return {
    name: fixture.name,
    aspect,
    width,
    height,
    fps,
    times,
    frames,
    cuts: fixture.cuts,
    note: fixture.note,
    hard: !!fixture.hard,
  };
}

// --- コマンドラインから呼ばれたとき ---
//
// 判定の側が `node:url` を使わないのは、**このファイルをブラウザからも読むため**
// （2026-09-22・2 回目）。画面の確認（`scene-cut/uitest.mjs`）は、ここで作ったコマを
// ブラウザ側で本物の動画に焼いてから画面へ食わせる。静的な `import 'node:url'` が 1 行あるだけで
// vite がその解決に失敗するので、実行中の名前で見分ける形にしてある。
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('make-frames.mjs')) {
  const only = process.argv[2];
  const aspect = process.argv[3] ?? 'landscape';
  const fps = Number(process.argv[4] ?? SCENE_FPS);
  // 自動リフレームの素材は別の列に置いてあるが（`scenes.mjs` の注）、
  // 一覧から漏れると「無い素材」に見えるので、ここでは続けて出す。
  const list = only ? [sceneFixture(only)] : [...SCENE_FIXTURES, ...REFRAME_FIXTURES];
  console.log(`向き: ${aspect}（${SCENE_ASPECTS[aspect]?.label ?? '?'}） ・ ${fps}fps\n`);
  for (const f of list) {
    const clip = renderFixture(f.name, { aspect, fps });
    const mb = (clip.frames.length * clip.width * clip.height * 4) / 1024 / 1024;
    console.log(
      `${f.name.padEnd(14)} ${clip.frames.length} コマ  ${clip.width}×${clip.height}  ` +
        `${mb.toFixed(1)}MB  正解 ${f.cuts.length} 本  ${f.hard ? '※ ' : ''}${f.note}`,
    );
  }
}
