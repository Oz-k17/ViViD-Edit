/**
 * 「声らしさ」を測るための候補になる特徴量を、コマごとに並べる。
 *
 * どれを使うかは決め打ちにせず、正解の分かっている素材で
 * 実際にどれくらい分けられるかを測ってから選ぶ（probe.mjs）。
 * 思いつきで 1 つ選ぶと、たまたま手元の素材で効いただけのものを掴む。
 *
 * すべて loudness.ts と同じコマ割り（既定 20ms）に揃えてあるので、
 * 音量の列とそのまま並べて比べられる。
 */

import { fftScratch, magnitudes } from './fft.ts';
import { SILENCE_DB, type AudioLike, type LoudnessTrack } from './loudness.ts';

export interface FeatureTrack {
  hop: number;
  duration: number;
  /** 1 秒に何コマか。 */
  frameRate: number;
  /** 音量（dBFS）。loudness.ts と同じもの。 */
  level: Float32Array;
  /** 音量の揺れのうち、3〜6Hz（人が音節を刻む速さ）が占める割合。 */
  modulation: Float32Array;
  /** スペクトルの重心（Hz）。高いほど「明るい」音。 */
  centroid: Float32Array;
  /** スペクトルの平坦さ（0〜1）。1 に近いほど雑音的、0 に近いほど音程がある。 */
  flatness: Float32Array;
  /** 1 コマ前からのスペクトルの変化量。子音や打撃で跳ねる。 */
  flux: Float32Array;
  /**
   * スペクトルの**形**の変化量（0〜1）。
   *
   * `flux` との違いは、比べる前にスペクトルを自分の合計で割っていること。
   * こうすると**音量が何倍になっても値が変わらない**ので、
   * 「音量だけが揺れている」音（トレモロやビブラートのかかった楽器）には反応しない。
   * 人がしゃべると母音が移り変わってスペクトルの形そのものが動くので、そこで差が出る。
   */
  shapeFlux: Float32Array;
  /**
   * スペクトルの**包絡**（フォルマントの居場所）の動き。0 以上の距離で、割合ではない。
   *
   * `shapeFlux` との違いは、**倍音の細かい縞と音量を先に落としている**こと。
   * メル帯域でまとめて対数を取り、低い次数のケプストラムだけを残すと、
   * 残るのは「どの高さに共鳴の山があるか」というなだらかな形だけになる。
   * 音量は 0 次にしか出ないので、1 次以上を見るかぎり**音量倍率に不変**。
   *
   * 狙いは「背景に頼らずに声の音色の動きを拾う」こと。`shapeFlux` が動くのは
   * 主に声と背景の混ざり方が変わるからで、背景の無い素材では動きが小さい。
   * 実測（鳴っているコマの中央値。2026-09-11・2 回目に素材を作り直してから測り直した）:
   *
   * | 素材 | shapeChange | envelopeChange |
   * | --- | --- | --- |
   * | 乾いた声 | 0.188 | **0.270** |
   * | 震える楽器（声なし） | 0.050 | **0.009** |
   * | ※ 乾いた声・母音を長く伸ばす | 0.161 | **0.037** |
   *
   * 声と鳴りっぱなしの音楽は 30 倍開く。**背景がまったく無くても声の口の動きを拾える。**
   * ただし 3 行目に注意。**母音を伸ばしている間は口が動かないので、包絡も動かない。**
   * 伸ばした母音は本物の話し声にいくらでもあるので、これは素材の都合ではなく声の性質。
   * コマ単位の門にできない理由がここにある（詳しくは JOURNAL の 2026-09-11 の 2 回目）。
   *
   * **ただし音程の動きには不変ではない。** 口の形を止めたまま音程だけを 1 オクターブ
   * 動かしても、共鳴だけを動かしたときの 4〜8 割の大きさで反応する
   * （44.1kHz で 0.373 対 0.443、16kHz で 0.176 対 0.392。窓に入る波の数で変わる）。
   * メル帯域は低い所では倍音 1 本 1 本を分けてしまうので、音程が動くと帯域の中身も動く。
   * つまりこれは「口が動いた」ではなく「音色か音程が動いた」を測っている。
   *
   * **ここに「ビブラートのかかった楽器は区別できないはず」と 3 日置いてあったが、外れた。**
   * 2026-09-14 に `music-vibrato.wav`（声の抑揚と同じ ±4%・1.7Hz で音程が動き、
   * 共鳴は固定の楽器・声なし）を作って測ると、音を伸ばしている間の中央値は **0.020** で、
   * 鳴りっぱなしの `music-chords`（0.010）とほとんど変わらない。
   * 上の「1 オクターブで 4〜8 割」は**動かす幅の話**で、ビブラートの幅（±4% ≒ 5Hz）は
   * いちばん狭いメル帯域（低い側で約 80Hz）の中に収まってしまう。**櫛はほとんど動かない。**
   *
   * **代わりに、音の変わり目で 1〜3 まで跳ねる**（隣の音へ渡るとき、倍音が固定の共鳴を滑るため）。
   * そこを均し（0.15 秒）と保持（0.5 秒）が引き伸ばすので、
   * 素材としては 13 秒中 10 秒ぶん門が開く。**破っているのはビブラートではなく音の変わり目。**
   * 壊れ方は `music-chords-faster` とまったく同じで、新しい穴ではなかった。
   * その実害は 2026-09-14 に `minEnvelopeRun`（silence.ts）で塞いだ。
   *
   * **「倍音の櫛を先に潰せば音程の動きを外せる」という手も、同じ日に測って捨てた。**
   * メル帯域に入れる前に、半幅 ±175Hz / ±300Hz の窓で最大値を取って櫛を均すと、
   * 声の側が下がり（`speech` 0.694 → 0.675 → 0.666）、
   * `music-vibrato` はむしろ上がる（0.210 → 0.248 → 0.259）。
   * **外すべきものが初めから乗っていなかった**ので、潰すだけ損になる。
   *
   * **和音が速く変わる音楽でも破れる。** 2026-09-11 の 3 回目にこれをコマ単位の門にしてから
   * `music-chords-fast.wav`（和音が 0.4 秒ごとに変わる・声なし）を作って確かめたところ、
   * 声だと判断されるコマが 51% に達した（たまにしゃべる本物の声は 29%）。
   * **音色が動くこと自体は、声に固有の性質ではない。**
   */
  envelopeFlux: Float32Array;
  /** 声の帯域（300〜3400Hz）が全体に占める割合。 */
  voiceBand: Float32Array;
  /** ゼロ交差率。高いほど雑音的・高域寄り。 */
  zcr: Float32Array;
  /** 倍音らしさ。基本周波数の整数倍にどれだけ energy が乗っているか（0〜1）。 */
  harmonicity: Float32Array;
  /** 音色の尖り具合（= 1 - flatness）。声や楽音で高く、雑音や打撃で低い。 */
  tone: Float32Array;
  /**
   * `shapeFlux` を 0.15 秒で均したもの。**素材が声を含むかを判断するのに使う。**
   *
   * コマごとの声らしさ（`speechScore`）には掛けない。2026-09-10 に試して駄目だった:
   * 当時の合成の声は発話中ずっと音色が変わらなかったので、乾いた素材では形の変化が
   * 0.011〜0.046 までしか上がらず、震える楽器（0.071 まで）より下に来てしまった。
   *
   * **その理由は 2026-09-11 の 2 回目に消えた**（素材の声を作り直したので、
   * 乾いた声でも中央値 0.188 まで動く）。それでも掛けていないのは、
   * 掛けるなら `shapeFlux` ではなく `envelopeFlux` のほうが筋がよいと分かったため
   * （音量の揺れだけの楽器を弾ける）。そちらはそちらで、母音を伸ばした声で止まっている。
   *
   * **素材の中でどれだけ動いたか**で見れば、鳴りっぱなしの音楽とは分けられる。
   * 声のある素材はどこかで必ず形が動く（語頭・語尾・母音の移り変わり）のに対し、
   * 鳴りっぱなしの音楽はどこにもそういう瞬間が無い。silence.ts はそちらを使う。
   *
   * **ただし、それは「声があるか」を見ているのではない。2026-09-12 に測って分かった。**
   * 均す窓（`SHAPE_SMOOTH` = 0.15 秒）より広い間隔でしか変化が来なければ、
   * 棘は均されて消える。窓より狭い間隔で来続ければ、均しても埋まらない。
   * つまりこの量が分けているのは**変化の間隔**であって、声かどうかではない。
   * 和音の切り替わる間隔だけを振ると、13 秒の素材で:
   *   間隔     0.8   0.6   0.5   0.4   0.35  0.3   0.25  0.2
   *   動いた秒 0.18  0.14  0.02  0.30  1.00  1.24  4.24  6.92
   * 声の音節は 0.16〜0.25 秒間隔なので、**刻みの速い伴奏は声と同じ側に落ちる**。
   * 窓を広げても、遅いほうの崖が動くだけで、速いほうは通る（詳しくは silence.ts）。
   */
  shapeChange: Float32Array;
  /** `envelopeFlux` を 0.15 秒で均したもの。1 コマの跳ねで決めないため。 */
  envelopeChange: Float32Array;
  /**
   * 重心が**下がり続けている割合**（0〜1）。0.3 秒の窓の中で
   * 「重心が 1 コマ前より下がった」歩みが何割あったかを数える。
   * 向きだけを見るので、重心が何 Hz 動いたかにも音量倍率にも依らない。
   *
   * **判定には使っていない。** 2026-09-13 の 2 回目に「打点の減衰と口の動きを分ける」
   * 当てとして入れ、測って捨てた量。残してあるのは `lab:probe` で測り続けるためで、
   * 次の回が同じ穴を掘らないための記録でもある。
   *
   * 狙いは `envelopeChange`（包絡の動き）が拾えなかった区別だった。包絡は「口が動いたか」の
   * 代理にしていたが、同日の 1 回目に**減衰する打点でも同じだけ動く**ことが分かった
   * （`music-hats` で 1.44 → 12.98 秒）。打点は立ち上がりで重心が一気に上がり、
   * 減衰のあいだ単調に下がり続ける。口の動きは向きがばらばらなので半々になる。
   * 筋は通っていて、最初の 2 段では実際にきれいに分かれた:
   *
   * | 素材 | 中央値 | 0.65 超えのコマ |
   * | --- | --- | --- |
   * | **`music-hats`（和音＋ハイハット・声なし）** | **0.824** | **97%** |
   * | ※ `speech-hats`（同じハイハットの上でしゃべる） | 0.588 | 29% |
   * | 声のある 12 本の声のコマ | 0.412〜0.588 | 0〜25% |
   * | ほかの音楽 8 本 | 0.417〜0.583 | 1〜34% |
   *
   * 2 行目が効いている。声を乗せると 97% → 29% まで落ちるので、
   * 「ハイハットがあるか」を見ているだけではない。**そこまでは正しかった。**
   *
   * **破れたのは「声が高い帯域を覆っているか」を見ていたから。**
   * 重心はいちばん高い所にある弱い音に引きずられる（和音に -34dB のハイハットを足すだけで
   * 素材の下降率が 0.493 → 0.749 に動く）。だから声が高い帯域に何も出していなければ、
   * 重心を動かすのは打点の減衰だけになる:
   *
   * | 素材 | 声のコマの中央値 | 0.65 超え |
   * | --- | --- | --- |
   * | ※ `speech-hats`（子音と息のある声） | 0.588 | 29% |
   * | ※ `speech-vowels-hats`（**子音も息も無い声**） | **0.765** | **83%** |
   * | ※ `speech-sustained` ＋ ハイハット（母音を伸ばす声） | 0.706 | 69% |
   *
   * ハミングや伸ばした母音を伴奏の上でやると、**声のコマの 7〜8 割が打点の側に落ちる**。
   * 検算にも固定してある（声でなくても、高い帯域に雑音を敷けば下降率は落ちる）。
   * つまりこの量は「口が動いたか」ではなく「**高い帯域が何かで覆われているか**」を見ている。
   *
   * 素材単位でも使えない。※ `speech-sparse-hats`（ハイハットの刻む音楽の上で
   * 13 秒中 2.6 秒だけしゃべる）は、声が入っているのに素材全体の 99% が 0.65 を超える
   * （`music-hats` の 97% より高い）。外せば声を丸ごと失う。詳しくは JOURNAL の同日。
   */
  centroidDescent: Float32Array;
  /** `bandLog` の 1 コマぶんの本数（= メル帯域の数）。 */
  bandCount: number;
  /** `bandLog` を低い側と高い側に分ける境目の帯域番号（この番号から上が高い側）。 */
  bandSplit: number;
  /**
   * 帯域ごとの対数エネルギーを、コマ順に並べたもの（`frames × bandCount`、行が 1 コマ）。
   *
   * 重心も平坦さも、**スペクトルを 1 つの数へ潰してから**時間で見る量だった。
   * その 2 つが同じ壊れ方をした（どちらも「倍音の上に何かあるか」しか見ていない）ので、
   * 潰す前の形をそのまま残して、「どの帯域がどう動いたか」を見られるようにした。
   *
   * **音量倍率に不変。** 下限をコマ全体のエネルギーに対する比で置いてあるので
   * （`log(E_b + MEL_FLOOR × 総和)`）、音量を a 倍すると全帯域・全コマに
   * `log a` が同じだけ乗るだけで、コマ間の差はまったく変わらない。
   * 絶対値の下限にすると、静かな素材でだけ下限が効いて不変性が崩れる。
   */
  bandLog: Float32Array;
  /**
   * **高い帯域だけが動いた歩みの割合**（0〜1）。0.3 秒の窓で数える。
   *
   * **判定には使っていない。** 2026-09-13 の 3 回目に「帯域ごとの時間の形を見る」
   * 当てとして入れ、コマ単位の門まで作って測り、**捨てた**量。
   * `centroidDescent` と同じく、次の回が同じ穴を掘らないために残してある。
   *
   * 狙いは打点と声の区別。ハイハットは高い帯域だけが立ち上がって減衰し、
   * その下の和音は動かない。人がしゃべると音節の切れ目で帯域をまたいで一緒に動く。
   * 向きだけを見るので、何 dB 動いたかにも音量倍率にも依らない。
   *
   * **最初は「高い側と低い側が同じ向きに動いた割合」で測ったが、それは駄目だった。**
   * 鳴りっぱなしの素材では歩みが 1 つも数えられず（`bgm` は 100%、`music-chords` は
   * 90% のコマでどちらの帯域も動かない）、出てくるのは「数えられなかったときの既定値」
   * だけになる。実際に `bgm`・`drums`・`tremolo`・`swell` が揃って 1.000 になり、
   * 声（0.60〜0.67）より高く出た。**分けているように見えて、中身が無い。**
   * 数えられた歩みの中身を割ると、意味があったのは 1 種類だけだった:
   *
   * | 素材 | 低だけ動 | 高だけ動 | 両方動 | どちらも動かず |
   * | --- | --- | --- | --- | --- |
   * | **`music-hats`** | 2% | **38%** | 26% | 35% |
   * | `drums` | 0% | 1% | 99% | 0% |
   * | `bgm` | 0% | 0% | 0% | 100% |
   * | 声のある素材（素） | 2〜9% | 2〜5% | 27〜80% | 4〜70% |
   *
   * 打点の素材でだけ「高だけ動」が突出する。そこで**それだけ**を数えている。
   *
   * **当ては当たった。前の 7 つより、はっきり当たった。**（0.5 超えのコマの割合）
   *
   * | 素材 | 0.5 超え |
   * | --- | --- |
   * | **`music-hats`**（和音＋ハイハット・声なし） | **72%** |
   * | ※ `speech-hats` の声のコマ（同じハイハットの上でしゃべる） | **1%** |
   * | ※ `speech-sparse-hats` の**声**のコマ | **0%** |
   * | ※ `speech-sparse-hats` の**それ以外**のコマ | **64%** |
   * | 声のある素材（ハイハット無し）の声のコマ | 0〜1% |
   * | ほかの音楽 8 本 | 0〜21% |
   *
   * 4 行目が効いている。`centroidDescent` は同じ素材で**全体の 99%** が超えてしまい、
   * 外せば声を丸ごと失った。この量は**素材の中で**声とそれ以外が割れる。
   *
   * **それでも入れなかった。破り方が 1 つ残っていて、そこが塞げなかったから。**
   * この量が見ているのは「低い帯域が動かないまま、高い帯域だけが動いたか」なので、
   * **低い帯域が動かない声**——伸ばした母音——を打点と区別できない:
   *
   * | 素材 | 声のコマの中央値 | 0.5 超え |
   * | --- | --- | --- |
   * | **`music-hats`**（声なし） | 0.571 | **72%** |
   * | ※ **`speech-sustained-hats`**（ハイハットの上で母音を伸ばす声） | **0.571** | **61%** |
   *
   * 中央値まで同じになる。この素材は**この量を潰すために同日に足した**もので、
   * `speech-sustained.wav` とハイハットの有無しか違わない（声は 1 ビットも同じ）。
   * 門を 0.5 に置くと `music-hats` の削減 0% → 35% と引き換えに、
   * この素材の**声を残せた率が 100% → 73%** に落ちる。
   * 緩めても駄目で、0.7 では `music-hats` の削減が 0% に戻るのに残せた率は 83% までしか戻らない
   * （**効きのほうが先に消える**）。包絡の門と同じ 0.5 秒の保持を足すと残せた率は 100% に戻るが、
   * そのとき `speech-sparse-hats` の削減が 13% → 0% になり、得たものが残らない。
   *
   * つまり `centroidDescent`（子音の無い声で破れる）と `envelopeChange`
   * （伸ばした母音で止まる）の**両方の穴を、同時に踏んでいる**。
   *
   * **2026-09-14 の 2 回目に、置き場所を変えて測り直した。それでも入れていない。**
   * 前の回に `minEnvelopeRun` が「門では交換、素材単位では片側だけの前進」になったので、
   * この量も素材単位の判定（`speechRatio` を数えるところ）へ移せば通るはず、という当てだった。
   * 門 0.3 で `music-hats` の割合は 99% → **4%** と 5% の線の下へ落ち、
   * そのとき声のある素材は（潰し素材を足す前の 15 本では）どれも 21% 以上で線の上に残る。
   * **ここまでは当たっていた。**
   *
   * 潰し素材を 2 本足したら、そうではなかった（`npm run lab:probe` の最後の段に表がある）:
   *
   * | 素材 | 声 | いま | 門 0.3 |
   * | --- | --- | --- | --- |
   * | ※ `music-hats`（声なし・削減 0%） | 無 | 99% | **4%** |
   * | ※ **`music-hats-break`**（和音が 2 回休む・声なし・**削減 3%**） | 無 | 93% | **9%** |
   * | ※ **`speech-sparse-sustained-hats`**（声あり 20%） | 有 | 98% | **9%** |
   *
   * **実害が出ているほうの音楽が落ちず、声のある素材とまったく同じ所に並ぶ。**
   * 落ちた `music-hats` はもともと削減 0%（13 秒ずっと同じ大きさで鳴っているだけ）なので、
   * 得たものは「止まっている素材の止まり方が変わった」だけだった。
   *
   * **なぜ余裕が消えたのかが、この回のいちばんの収穫。**
   * 素材単位の判定は「13 秒のうち 5% 残ればよい」ではなく、割合の分母が鳴っているコマ全部なので
   * **（声が尺に占める割合）×（その声を数えられた割合）** が 5% を超えればよい、が正しい。
   * 声がたっぷりある素材では前の項が 0.8〜0.9 あるので 8 割取りこぼしても平気だが、
   * 声が 2 割しか無い素材では、同じ取りこぼし率でそのまま線を割る。
   * この素材の声のコマは 100% → **17%** まで落ちるので、残った 9% は声の証拠ですらなく、
   * 落としきれなかった打点のコマのほうだった。検算にも固定してある
   * （「素材単位の余裕は、声がどれだけ入っているかに比例する」）。
   */
  highBandAlone: Float32Array;
  /**
   * 声らしさ。揺れの速さ（modulation）と音色の尖り具合（tone）の積。
   *
   * 片方だけでは足りないことが probe.mjs で分かったので掛け合わせている。
   * - modulation は BGM が大きい素材でよく効くが、声と同じ速さで刻む打楽器には無力
   * - tone は打楽器をきれいに弾くが、BGM が大きいと鈍る
   * 互いの穴が重ならないので、積を取ると両方でそこそこ効く。
   *
   * **ただし、この 2 つだけでは原理的に破れる。** 声らしさの定義が
   * 「音程のある音が音節の速さで揺れている」なので、音程のある楽器を
   * 同じ速さで震わせると、声が 1 つも無いのに満点が出る
   * （`music-tremolo.wav` は中央値 0.896 で、本物の声のどれよりも高い）。
   * ここはコマ単位では塞げなかったので、素材単位で `shapeChange` を見て弾く。
   */
  speechScore: Float32Array;
}

/** 窓の長さ（サンプル）。2048 なら 44.1kHz で約 46ms。音節より短く、母音より長い。 */
const WINDOW = 2048;
/** 音節の速さとみなす帯域（Hz）。 */
const MOD_LOW = 3;
const MOD_HIGH = 6;
/**
 * 揺れを見る窓の長さ（秒）。2 の冪に丸めるので、実際には 32 コマ = **0.64 秒**。
 *
 * **伸ばす手は 2026-09-12（3 回目）に測って捨てた。** 前の回には
 * 「0.64 秒だと遅い声の音節が窓に 1 つしか入らないので、1.28 秒に伸ばせば拾える」と
 * 書いてあったが、伸ばすと拾えるようになるどころか**全素材で取りこぼしが増えた**
 * （声のある 11 本の平均で 96.9% → 77.4%。`speech.wav` は 98% → 66%）。
 *
 * 理由は「窓に何が入るか」ではなく「取り分がどこへ移るか」だった。
 * 窓を伸ばすと刻みが細かくなり、**いちばん遅い帯（0.78Hz）へ取り分が移る**。
 * そこに乗っているのは音節ではなく、発話そのものの入り切りと音量の流れ。
 * `speech.wav` の声のコマで測った取り分:
 *   窓 0.64 秒: 3〜6Hz 50.9% / それより遅い帯 34.9%
 *   窓 1.28 秒: 3〜6Hz 27.5% / それより遅い帯 63.6%（うち 0.78Hz だけで 36.0%）
 * 音楽も同じだけ下がる（`bgm.wav` は 13.4% → 1.1%）ので、順位は保たれる。
 * ところが判定は固定のしきい値（0.2）で線を引くので、**声のほうが先に線を割る。**
 * 窓の長さは目盛りそのものを動かす。伸ばすなら、しきい値ごと引き直す話になる。
 */
const MOD_WINDOW = 1.0;
/** 人の声の基本周波数として探す範囲（Hz）。 */
const F0_LOW = 70;
const F0_HIGH = 320;
/**
 * 包絡（フォルマントの居場所）を見る帯域の数と範囲。
 *
 * メル尺度（人の耳の分解能に近い）で等間隔に並べる。低い所を細かく、高い所を粗く見るので、
 * フォルマントの居る 300〜3000Hz あたりに帯域が集まる。
 * 上を 8000Hz で止めるのは、それより上に口の形の手がかりがほとんど無いわりに、
 * 息や環境ノイズが乗って値が暴れるため。下は部屋の唸りを避けて 50Hz から。
 *
 * **「線形周波数では駄目」という当初の根拠は、測り直したら消えた。** 2026-09-11 の 1 回目には
 * 「歪めずに 50〜8000Hz を並べると開きが 17 倍から 2.5 倍に落ちる」と測れていたが、
 * その日の 2 回目に合成の声を本物に近づけてから同じ比較をすると、ほとんど差が無い
 * （乾いた声 対 震える楽器が メル 30 倍・線形 90 倍、
 * いちばん苦しい「母音を伸ばす声」で見ると メル 4.1 倍・線形 8.5 倍）。
 * 当時の結論は**平板な合成音の性質を測っていた**もので、声の作りが変わると成り立たなくなった。
 * メル尺度のままにしてあるのは値そのものが大きく（雑音に対する余裕がある）、
 * 尺度を選び直すなら判定ごと測り直す回を取るべきだから。
 */
const MEL_BANDS = 26;
const MEL_LOW = 50;
const MEL_HIGH = 8000;
/**
 * 対数を取るときの下限（そのコマの全エネルギーに対する割合）。
 *
 * **ここが効きを決める。** 低くすると、ほとんど鳴っていない帯域（倍音と倍音の間）が
 * 対数の底で暴れ、鳴りっぱなしの音楽まで「包絡が動いている」ことになる。
 * 実測（鳴っているコマでの `envelopeChange` の中央値）:
 *   下限        1e-7   1e-5   1e-4   1e-3   1e-2
 *   乾いた声      0.377  0.348  0.327  0.270  0.164
 *   ※ 母音を伸ばす声 0.115  0.067  0.048  0.037  0.023
 *   震える楽器     0.506  0.138  0.047  0.009  0.003
 *   音楽だけ      0.334  0.038  0.008  0.003  0.003
 * 1e-3 で、声と鳴りっぱなしの音楽が 30 倍開く。これ以上上げても開きは増えず、
 * 声の側が削られていくだけなので 1e-3 を採った。
 *
 * **いちばん苦しい声（母音を伸ばす声）と震える楽器の距離で見ても 1e-3 が最良**で、
 * 1e-4 では 0.048 対 0.047 とまったく並んでしまう。2026-09-11 の 2 回目に
 * 素材を本物の声に作り直したあとで測り直しても、選ぶ値は変わらなかった。
 */
const MEL_FLOOR = 1e-3;
/**
 * 残すケフレンシー（ケプストラムの次数）の数。
 *
 * 低い次数ほど「なだらかな山」を表す。12 次までなら倍音の細かい縞は残らず、
 * 共鳴の山のだいたいの居場所だけが残る。
 */
const CEPS_KEEP = 12;
/**
 * 声らしさの谷を埋める窓の長さ（秒）。
 *
 * 窓を広げるほど声を取りこぼさなくなるが、余計なものも残るようになる。
 * 実測（lab:bench の speech-drums.wav「声を残せた率 / 残したうち声だった率」）:
 *   窓なし 85% / 95%   0.06s 90% / 92%   0.10s 92% / 91%   0.15s 95% / 86%   0.25s 100% / 76%
 * **声を切ってしまうのは取り返しがつかない**（余分な無音はあとから詰められる）ので、
 * 取りこぼさない側へ寄せつつ、切れ味が落ちきらない 0.10 を選んだ。
 * なお平均で均すと端が引きずられて逆に悪化した（0.25s で 71%）。最大値で谷だけを埋める。
 */
const SCORE_SMOOTH = 0.1;
/**
 * 形の変化を均す窓の長さ（秒）。
 * 1 コマの値は行ったり来たりするので、そのまま比べると折り返し点を掴む。
 * 「この辺りが動いているか」を見たいので、谷を埋める最大値ではなく平均で均す。
 *
 * **この窓が、素材単位の形の判定の効きをそのまま決めている**（2026-09-12 に測った）。
 * 均すとは「窓より広い間隔で来る変化を棘とみなして薄める」ことなので、
 * ここを動かすと「どの速さの変化までを音楽とみなすか」が動く。
 * 声の無い音楽（和音が変わる）の「形が動いた秒数」。* は 0.5 秒を超えた＝素通り:
 *
 *   窓＼和音の間隔   0.8    0.6    0.5    0.4    0.35   0.3    0.25   0.2
 *   0.06s           1.66*  2.26*  2.64*  3.32*  4.18*  4.90*  5.32*  7.12*
 *   0.10s           0.84*  1.38*  1.56*  2.08*  3.74*  2.98*  5.30*  6.80*
 *   0.15s（既定）    0.18   0.14   0.02   0.30   1.00*  1.24*  4.24*  6.92*
 *   0.25s           0.02   0.00   0.02   0.26   0.78*  0.12   2.16*  7.44*
 *   0.40s           0.00   0.00   0.00   0.00   0.40   0.02   2.20*  7.84*
 *
 * **広げても速い側は塞がらない**（0.2 秒ごとの和音はむしろ伸びる）。
 * 広げて得をするのは 0.3〜0.4 秒ごとの帯だけで、しかも 0.35 秒が 0.25s の窓では
 * まだ通るなど、崖の位置がきれいに揃わない。
 *
 * それでも 0.15 のままにしてあるのは、**広げても本当の穴が塞がらない**からで、
 * 「広げると声が犠牲になる」からではない。声側は今日の 16 素材すべてで
 * 1 ポイントも動かず、むしろ余裕が増える（`speech-sparse-bgm` は 2.76 → 3.14 秒）。
 * ここを回して数字を良く見せると、**塞がっていない穴が塞がったように見える**ので回さない。
 */
const SHAPE_SMOOTH = 0.15;
/** 包絡の動きを均す窓の長さ（秒）。`shapeChange` と揃えてある（比べるため）。 */
const ENVELOPE_SMOOTH = 0.15;
/**
 * 重心の下降率を数える窓の長さ（秒）。
 *
 * **打点 1 つぶんが丸ごと入る長さが要る。** 窓が打点の間隔より短いと、
 * 立ち上がり（上がる 1 歩）を含む窓と含まない窓に分かれて、値が窓の置き場所で跳ねる。
 * 声の音節と同じ速さで刻む打楽器（4.2Hz = 0.238 秒ごと）を想定しているので、
 * それより少し長い 0.3 秒を採った。`shapeChange` の 0.15 秒と揃えていないのはこの理由。
 *
 * 逆に長くしすぎると、声と打楽器が入れ替わる境目がぼやける。
 */
const DESCENT_WINDOW = 0.3;
/**
 * 下降率を出すのに最低いくつの歩みが要るか。
 *
 * 足りないときは **0（＝打点の減衰ではない）** を返す。迷ったら声の側に倒す。
 * 声を切ってしまうのは取り返しがつかないので、「判断できない」を
 * 「打点だ」と読ませない（silence.ts が渡されない列を「動いていない」と読まないのと同じ考え）。
 */
const DESCENT_MIN_STEPS = 4;
/**
 * 高い帯域と低い帯域を分ける境目（Hz）。
 *
 * ハイハットの雑音がほぼこの上にしかなく、和音の基音と第 2 倍音までがこの下に入る所を採った。
 * 声はここをまたいで一緒に動く（音節の切れ目で全部が立ち上がる）ので、
 * 境目そのものの置き場所には鈍いはず。実際に振って確かめること。
 */
const HIGH_ALONE_SPLIT_HZ = 2000;
/** 歩みを数える窓の長さ（秒）。打点 1 つぶんが入るように `DESCENT_WINDOW` と揃えた。 */
const HIGH_ALONE_WINDOW = 0.3;
/**
 * 「動いた」とみなす最小の変化（対数エネルギー）。0.1 は約 0.43dB。
 *
 * ここが要るのは、**鳴りっぱなしの和音を「揃っている」と数えないため**。
 * 窓掛けと位相のせいで、まったく変化していない正弦波でも 1 コマごとに小さく揺れる。
 * その揺れの向きを数えると、動いていないものが半々（0.5）に見えてしまう。
 * 対数の差なので、この下限は音量倍率に依らない（そこが絶対値の下限と違う）。
 */
const HIGH_ALONE_DEAD_ZONE = 0.1;
/**
 * 割合を出すのに最低いくつの歩みが要るか。
 *
 * 足りないときは **0（＝打点だけが動いてはいない）** を返す。`centroidDescent` と同じで、
 * 「判断できない」を「声ではない」と読ませない。迷ったら声の側に倒す。
 */
const HIGH_ALONE_MIN_STEPS = 4;

/** 窓の中の平均。均一に均すので、山も谷も同じだけ動く。 */
function smoothMean(values: Float32Array, halfWidth: number): Float32Array {
  if (halfWidth < 1) return values;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let k = -halfWidth; k <= halfWidth; k += 1) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      sum += values[j];
      count += 1;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

/**
 * 重心が下がり続けている割合を、窓ごとに数える。
 *
 * 向き（下がったか）だけを見るので、対数を取る必要は無い
 * （log は単調なので `log a < log b` と `a < b` は同じこと）。
 * 重心が何 Hz 動いたかにも、音量倍率にも依らないのはそのため。
 *
 * 音が出ていないコマを挟んだ歩みは数えない。無音の重心はほぼ雑音の重心なので、
 * そこを繋げて数えると「鳴り始めの 1 歩」が巨大な向きになって混ざる
 * （`shapeFlux` が無音を挟んだときに前のコマを忘れるのと同じ理由）。
 */
export function centroidDescentRatio(
  centroid: Float32Array,
  level: Float32Array,
  hop: number,
  windowSeconds = DESCENT_WINDOW,
): Float32Array {
  const frames = centroid.length;
  const out = new Float32Array(frames);
  if (frames === 0) return out;
  // 歩みごとの向き。1 = 下がった、0 = 下がらなかった、-1 = 数えられない。
  // いちばん最初のコマには「1 つ前」が無いので、歩みとしては数えられない。
  const step = new Int8Array(frames);
  step[0] = -1;
  for (let i = 1; i < frames; i += 1) {
    const ok = level[i] > SILENCE_DB && level[i - 1] > SILENCE_DB && centroid[i] > 0 && centroid[i - 1] > 0;
    step[i] = ok ? (centroid[i] < centroid[i - 1] ? 1 : 0) : -1;
  }
  const half = Math.max(1, Math.round(windowSeconds / 2 / hop));
  for (let i = 0; i < frames; i += 1) {
    let down = 0;
    let counted = 0;
    for (let k = -half; k <= half; k += 1) {
      const j = i + k;
      if (j < 0 || j >= frames || step[j] < 0) continue;
      counted += 1;
      down += step[j];
    }
    out[i] = counted >= DESCENT_MIN_STEPS ? down / counted : 0;
  }
  return out;
}

/**
 * 高い帯域だけが動いた歩みの割合を、窓ごとに数える。
 *
 * 重心（`centroidDescent`）はスペクトルを 1 つの数へ潰してから向きを見る量だったので、
 * いちばん高い所にある弱い音に引きずられて壊れた。ここは潰さずに、
 * 低い側の束と高い側の束を別々に見て、**高い側だけが動いた歩み**を数える。
 * ハイハットは下の和音を動かさずに高い帯域だけを叩くので、そこが出るはず、という当て。
 *
 * **「同じ向きに動いた割合」で数えてはいけない。** 鳴りっぱなしの素材は
 * どちらの帯域も動かないので歩みが 1 つも数えられず、既定値が並ぶだけになる
 * （実測では `bgm`・`drums`・`tremolo`・`swell` が揃って満点になり、声より高く出た）。
 * 「動かなかった」を「揃った」と数えない、が要点。
 *
 * 音が出ていないコマを挟んだ歩みを数えないのは `centroidDescentRatio` と同じ理由
 * （無音の帯域は雑音なので、鳴り始めの 1 歩が巨大な向きとして混ざる）。
 */
export function highBandAloneRatio(
  bandLog: Float32Array,
  bandCount: number,
  splitBand: number,
  level: Float32Array,
  hop: number,
  windowSeconds = HIGH_ALONE_WINDOW,
  deadZone = HIGH_ALONE_DEAD_ZONE,
): Float32Array {
  const frames = level.length;
  const out = new Float32Array(frames);
  // 帯域の列が足りなければ、何も言わずに 0（＝打点ではない）を並べる。
  // 中途半端に読むと配列の外が NaN になって、黙って「何も動いていない」に化ける。
  if (frames === 0 || bandLog.length < frames * bandCount) return out;
  // 歩みごとの結果。1 = 高い側だけが動いた、0 = そうではない、-1 = 数えない。
  const step = new Int8Array(frames);
  step[0] = -1;
  for (let i = 1; i < frames; i += 1) {
    if (!(level[i] > SILENCE_DB && level[i - 1] > SILENCE_DB) || splitBand <= 0 || splitBand >= bandCount) {
      step[i] = -1;
      continue;
    }
    let low = 0;
    for (let b = 0; b < splitBand; b += 1) low += bandLog[i * bandCount + b] - bandLog[(i - 1) * bandCount + b];
    low /= splitBand;
    let high = 0;
    for (let b = splitBand; b < bandCount; b += 1) high += bandLog[i * bandCount + b] - bandLog[(i - 1) * bandCount + b];
    high /= bandCount - splitBand;
    const lowMoved = Math.abs(low) >= deadZone;
    const highMoved = Math.abs(high) >= deadZone;
    // どちらも動かなかった歩みは「何も起きていない」ので分母にも入れない。
    // 分母に入れると、鳴りっぱなしの素材ほど値が 0 に押し下げられて、
    // 「打点が無い」と「そもそも何も起きていない」が同じ顔になる。
    if (!lowMoved && !highMoved) step[i] = -1;
    else step[i] = highMoved && !lowMoved ? 1 : 0;
  }
  const half = Math.max(1, Math.round(windowSeconds / 2 / hop));
  for (let i = 0; i < frames; i += 1) {
    let alone = 0;
    let counted = 0;
    for (let k = -half; k <= half; k += 1) {
      const j = i + k;
      if (j < 0 || j >= frames || step[j] < 0) continue;
      counted += 1;
      alone += step[j];
    }
    out[i] = counted >= HIGH_ALONE_MIN_STEPS ? alone / counted : 0;
  }
  return out;
}

/** 窓の中の最大値で埋める。谷を埋めるが、山（＝声のある所）は削らない。 */
function smooth(values: Float32Array, halfWidth: number): Float32Array {
  if (halfWidth < 1) return values;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let best = 0;
    for (let k = -halfWidth; k <= halfWidth; k += 1) {
      const v = values[Math.max(0, Math.min(values.length - 1, i + k))];
      if (v > best) best = v;
    }
    out[i] = best;
  }
  return out;
}

/**
 * 音量の列から、3〜6Hz の揺れが占める割合を出す。
 *
 * 人がしゃべると、音量が 1 秒に 3〜6 回くらい上下する（音節の速さ）。
 * 伸ばしっぱなしの音楽や環境音にはこの揺れが無い……というのが狙いだが、
 * 同じ速さで刻む打楽器には引っかかる。そこは probe.mjs で確かめる。
 */
export function modulationRatio(track: LoudnessTrack, low = MOD_LOW, high = MOD_HIGH, windowSeconds = MOD_WINDOW): Float32Array {
  const fs = 1 / track.hop;
  // 窓は 2 の冪に丸める。FFT の格子と欲しい周波数をきちんと合わせるため。
  let n = 1;
  while (n * 2 <= Math.round(windowSeconds * fs)) n *= 2;
  n = Math.max(16, n);

  const out = new Float32Array(track.db.length);
  const scratch = fftScratch(n);
  const buffer = new Float64Array(n);
  const lowBin = Math.max(1, Math.round((low * n) / fs));
  const highBin = Math.min(n / 2, Math.round((high * n) / fs));

  for (let i = 0; i < track.db.length; i += 1) {
    // 端は値を引き伸ばして埋める。窓の長さを変えると FFT の格子がずれるため。
    let mean = 0;
    for (let k = 0; k < n; k += 1) {
      const at = Math.max(0, Math.min(track.db.length - 1, i - (n >> 1) + k));
      // 無音の底（-100dB）がそのまま入ると、そこだけで巨大な段差になる。
      buffer[k] = Math.max(SILENCE_DB + 40, track.db[at]);
      mean += buffer[k];
    }
    mean /= n;
    let total = 0;
    for (let k = 0; k < n; k += 1) {
      buffer[k] -= mean;
      total += buffer[k] * buffer[k];
    }
    if (total < 1e-6) {
      out[i] = 0;
      continue;
    }
    magnitudes(buffer, scratch.re, scratch.im, scratch.mag);
    let band = 0;
    for (let b = lowBin; b <= highBin; b += 1) band += scratch.mag[b] * scratch.mag[b];
    // 窓を掛けたぶん全体のエネルギーが落ちるので、割合として見るために
    // 同じ窓を掛けた全帯域の合計で割る。
    //
    // **分母をいちばん遅い帯（bin 1 = 1.5625Hz）から始める手は、2026-09-12（3 回目）に
    // 測って捨てた。** 遅く大きなうねりがあると音節帯の取り分が分母に食われるので、
    // 「うねりを分母から外せば、遅い声も拾えるはず」という筋は通って見えた。
    // 実際、集計は全面的に良くなった（取りこぼし 96.9% → 100%、声ゼロを切った秒 5.1 → 3.4）。
    // ところが**声らしさが音楽と声を分けなくなっていた**（AUC 0.993 → 0.967）。
    //   `music-swell.wav` の中央値 0.229 → **0.884**（本物の声のどれよりも高い）
    //   `bgm.wav` の声らしいコマ 14% → **95%** / `music-chords-fast` 36% → 82%
    // 集計が良く見えたのは、素材単位の形の判定が後ろで拾っていたから。
    // 声ゼロの素材では「全編が声」も「何も見つからない」も削減 0% になるので、
    // **bench の数字ではこの壊れ方がまったく見えない**（probe の割合でしか見えない）。
    // 分母は「ほかにどんな揺れがあるか」を見る場所で、削ると比べる相手が消える。
    let all = 0;
    for (let b = 1; b <= n / 2; b += 1) all += scratch.mag[b] * scratch.mag[b];
    out[i] = all > 0 ? Math.min(1, band / all) : 0;
  }
  return out;
}

/** 基本周波数の整数倍にどれだけ乗っているか。声は倍音が並ぶ、打楽器は並ばない。 */
function harmonicityOf(mag: Float64Array, binHz: number): number {
  const from = Math.max(1, Math.round(F0_LOW / binHz));
  const to = Math.min(mag.length - 1, Math.round(F0_HIGH / binHz));
  let total = 0;
  for (let b = 1; b < mag.length; b += 1) total += mag[b] * mag[b];
  if (total <= 0) return 0;

  let best = 0;
  for (let f0 = from; f0 <= to; f0 += 1) {
    let sum = 0;
    // 5 倍音まで。それ以上は伸ばしても差が出ないわりに重くなる。
    for (let h = 1; h <= 5; h += 1) {
      const b = f0 * h;
      if (b >= mag.length) break;
      // 隣も拾う（ピークが格子の間に落ちることがある）。
      const peak = Math.max(mag[b - 1] ?? 0, mag[b], mag[b + 1] ?? 0);
      sum += peak * peak;
    }
    if (sum > best) best = sum;
  }
  return Math.min(1, best / total);
}

/** メル尺度への変換。人の耳は低い所ほど細かく聞き分けるので、それに合わせて帯域を並べる。 */
const toMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const fromMel = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

interface MelBank {
  /** 帯域の境目（bin 番号）。3 つ組で 1 つの三角形を作る。 */
  edges: Int32Array;
}

const melCache = new Map<string, MelBank>();

/** 三角形の窓を並べたメル帯域。窓の長さと標本化周波数が同じなら作り直さない。 */
function melBank(bins: number, binHz: number): MelBank {
  const key = `${bins}/${binHz.toFixed(4)}`;
  const found = melCache.get(key);
  if (found) return found;
  const lowMel = toMel(MEL_LOW);
  const highMel = toMel(Math.min(MEL_HIGH, binHz * (bins - 1)));
  const edges = new Int32Array(MEL_BANDS + 2);
  for (let i = 0; i < MEL_BANDS + 2; i += 1) {
    const mel = lowMel + ((highMel - lowMel) * i) / (MEL_BANDS + 1);
    edges[i] = Math.min(bins - 1, Math.max(1, Math.round(fromMel(mel) / binHz)));
  }
  const made = { edges };
  melCache.set(key, made);
  return made;
}

/**
 * 振幅スペクトル → 低次のケプストラム（＝なだらかな包絡の形）。
 *
 * **先に全体の合計で割ってから対数を取る。** こうしないと下限（MEL_FLOOR）が
 * 音量によって効いたり効かなかったりして、「音量倍率に不変」が崩れる。
 * 0 次（全体の大きさ＝音量）は初めから作らない。ここが不変性の要。
 *
 * 帯域が 26 本しかないので、DCT は素直な二重ループで足す（FFT を使うほどの量ではない）。
 */
function cepstrum(mag: Float64Array, bank: MelBank, energies: Float64Array, out: Float64Array): number {
  let total = 0;
  for (let b = 1; b < mag.length; b += 1) total += mag[b] * mag[b];
  const scale = total > 0 ? 1 / total : 0;
  for (let m = 0; m < MEL_BANDS; m += 1) {
    const from = bank.edges[m];
    const center = bank.edges[m + 1];
    const to = bank.edges[m + 2];
    let sum = 0;
    for (let b = from; b <= to; b += 1) {
      // 三角形の重み。中心で 1、両端で 0。
      const w = b <= center ? (center > from ? (b - from) / (center - from) : 1) : to > center ? (to - b) / (to - center) : 1;
      sum += w * mag[b] * mag[b];
    }
    energies[m] = Math.log(sum * scale + MEL_FLOOR);
  }
  for (let k = 1; k <= CEPS_KEEP; k += 1) {
    let sum = 0;
    for (let m = 0; m < MEL_BANDS; m += 1) {
      sum += energies[m] * Math.cos((Math.PI * k * (m + 0.5)) / MEL_BANDS);
    }
    out[k - 1] = (sum * 2) / MEL_BANDS;
  }
  // 帯域ごとの生の対数エネルギーを組み立て直せるように、割った量を返す。
  return total;
}

export interface FeatureOptions {
  /** 声らしさの谷を埋める窓の長さ（秒）。0 で無効。 */
  smoothSeconds: number;
  /** 形の変化を均す窓の長さ（秒）。0 で無効。 */
  shapeSmoothSeconds: number;
}

export const DEFAULT_FEATURES: FeatureOptions = {
  smoothSeconds: SCORE_SMOOTH,
  shapeSmoothSeconds: SHAPE_SMOOTH,
};

export function analyzeFeatures(
  buffer: AudioLike,
  track: LoudnessTrack,
  options: Partial<FeatureOptions> = {},
): FeatureTrack {
  const opts = { ...DEFAULT_FEATURES, ...options };
  const step = Math.max(1, Math.round(track.hop * buffer.sampleRate));
  const frames = track.db.length;
  const scratch = fftScratch(WINDOW);
  const window = new Float32Array(WINDOW);
  const binHz = buffer.sampleRate / WINDOW;

  const centroid = new Float32Array(frames);
  const flatness = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const shapeFlux = new Float32Array(frames);
  const envelopeFlux = new Float32Array(frames);
  const voiceBand = new Float32Array(frames);
  const zcr = new Float32Array(frames);
  const harmonicity = new Float32Array(frames);
  // 帯域ごとの対数エネルギー（frames × MEL_BANDS、行が 1 コマ）。
  const bandLog = new Float32Array(frames * MEL_BANDS);

  // 1ch にまとめる（左右で結論が変わる場面は想定していない）。
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
  const mono = (i: number) => {
    let v = 0;
    for (const data of channels) v += data[i] ?? 0;
    return v / channels.length;
  };

  const bank = melBank(scratch.mag.length, binHz);
  // 帯域ごとの対数エネルギーの入れ物。キャッシュ（melBank）には持たせない。
  // 書き換える配列を共有すると、呼び出しが重なったときに静かに壊れる。
  const melEnergies = new Float64Array(MEL_BANDS);
  const ceps = new Float64Array(CEPS_KEEP);
  const previousCeps = new Float64Array(CEPS_KEEP);
  let hasPreviousCeps = false;

  const previous = new Float64Array(scratch.mag.length);
  // 形の比較用。合計で割ったものを別に持つ（previous は生の大きさなので使い回せない）。
  const previousShape = new Float64Array(scratch.mag.length);
  let hasPreviousShape = false;
  const lowBin = Math.round(300 / binHz);
  const highBin = Math.min(scratch.mag.length - 1, Math.round(3400 / binHz));

  for (let i = 0; i < frames; i += 1) {
    const center = i * step + step / 2;
    const from = Math.round(center - WINDOW / 2);
    for (let k = 0; k < WINDOW; k += 1) {
      const at = from + k;
      window[k] = at >= 0 && at < buffer.length ? mono(at) : 0;
    }

    // ゼロ交差は窓を掛ける前の生の並びで数える。
    let crossings = 0;
    for (let k = 1; k < WINDOW; k += 1) {
      if ((window[k - 1] >= 0) !== (window[k] >= 0)) crossings += 1;
    }
    zcr[i] = crossings / WINDOW;

    magnitudes(window, scratch.re, scratch.im, scratch.mag);
    const mag = scratch.mag;

    let sum = 0;
    let weighted = 0;
    let logSum = 0;
    let bandSum = 0;
    let diff = 0;
    let counted = 0;
    for (let b = 1; b < mag.length; b += 1) {
      const m = mag[b];
      sum += m;
      weighted += m * b * binHz;
      logSum += Math.log(m + 1e-12);
      counted += 1;
      if (b >= lowBin && b <= highBin) bandSum += m;
      const d = m - previous[b];
      if (d > 0) diff += d; // 増えたぶんだけ見る（減衰は「変化」として数えない）
      previous[b] = m;
    }

    // 形の変化。合計で割ってから比べるので、音量倍率はここで消える。
    // 差の合計は最大 2（全部入れ替わったとき）なので、2 で割って 0〜1 に収める。
    if (sum > 0) {
      let shapeDiff = 0;
      if (hasPreviousShape) {
        for (let b = 1; b < mag.length; b += 1) shapeDiff += Math.abs(mag[b] / sum - previousShape[b]);
      }
      for (let b = 1; b < mag.length; b += 1) previousShape[b] = mag[b] / sum;
      hasPreviousShape = true;
      shapeFlux[i] = shapeDiff / 2;
    } else {
      // 無音を挟んだら「前のコマ」は無かったことにする。
      // 繋げて比べると、鳴り始めの 1 コマだけが巨大な変化になってしまう。
      hasPreviousShape = false;
      shapeFlux[i] = 0;
    }

    // 包絡（フォルマントの居場所）の動き。倍音の櫛と音量を落としてから比べる。
    if (sum > 0) {
      const total = cepstrum(mag, bank, melEnergies, ceps);
      // 帯域ごとの対数エネルギーは、ケプストラムが割ったぶんを掛け戻して残す。
      // `melEnergies` は log(E_b / 総和 + MEL_FLOOR) なので、log(総和) を足せば
      // log(E_b + MEL_FLOOR × 総和) に戻る。下限が総和に対する比のままなので、
      // 音量を何倍にしても全帯域に同じ定数が乗るだけで、コマ間の差は変わらない。
      // 鳴っていないコマ（sum === 0）はここへ来ないので、その行は 0 のまま残る。
      // 全帯域が同じ値なので、隣のコマとの差は低い側でも高い側でも同じだけ立つ。
      // つまり「高い側だけが動いた」にはならない ＝ 声の側に倒れる。
      const logTotal = total > 0 ? Math.log(total) : 0;
      for (let m = 0; m < MEL_BANDS; m += 1) bandLog[i * MEL_BANDS + m] = melEnergies[m] + logTotal;
      if (hasPreviousCeps) {
        let d = 0;
        for (let k = 0; k < CEPS_KEEP; k += 1) {
          const diff = ceps[k] - previousCeps[k];
          d += diff * diff;
        }
        envelopeFlux[i] = Math.sqrt(d);
      }
      previousCeps.set(ceps);
      hasPreviousCeps = true;
    } else {
      hasPreviousCeps = false;
      envelopeFlux[i] = 0;
    }

    centroid[i] = sum > 0 ? weighted / sum : 0;
    // 平坦さ＝幾何平均 ÷ 算術平均。雑音なら 1 に近づき、音程があると 0 に近づく。
    flatness[i] = sum > 0 ? Math.exp(logSum / counted) / (sum / counted) : 0;
    flux[i] = sum > 0 ? diff / sum : 0;
    voiceBand[i] = sum > 0 ? bandSum / sum : 0;
    harmonicity[i] = harmonicityOf(mag, binHz);
  }

  const modulation = modulationRatio(track);
  const tone = new Float32Array(frames);
  const raw = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    tone[i] = 1 - flatness[i];
    raw[i] = modulation[i] * tone[i];
  }
  // 人がしゃべっている間は続けてしゃべっている。1 コマだけ下がったからといって
  // そこで切ると、語中で切り刻むことになる。少し均してから使う。
  const speechScore = smooth(raw, Math.round(opts.smoothSeconds / track.hop));
  const shapeChange = smoothMean(shapeFlux, Math.round(opts.shapeSmoothSeconds / track.hop));
  const envelopeChange = smoothMean(envelopeFlux, Math.round(ENVELOPE_SMOOTH / track.hop));
  const centroidDescent = centroidDescentRatio(centroid, track.db, track.hop);
  // 高い側と低い側の境目は、帯域の中心（三角形の頂点）が HIGH_ALONE_SPLIT_HZ を越える所。
  // メル帯域の並びは標本化周波数に依らないが、勘で番号を書かずに毎回引き直す。
  let splitBand = MEL_BANDS;
  for (let m = 0; m < MEL_BANDS; m += 1) {
    if (bank.edges[m + 1] * binHz >= HIGH_ALONE_SPLIT_HZ) {
      splitBand = m;
      break;
    }
  }
  const highBandAlone = highBandAloneRatio(bandLog, MEL_BANDS, splitBand, track.db, track.hop);

  return {
    hop: track.hop,
    duration: track.duration,
    frameRate: 1 / track.hop,
    level: track.db,
    modulation,
    centroid,
    flatness,
    flux,
    shapeFlux,
    envelopeFlux,
    voiceBand,
    zcr,
    harmonicity,
    tone,
    shapeChange,
    envelopeChange,
    centroidDescent,
    bandCount: MEL_BANDS,
    bandSplit: splitBand,
    bandLog,
    highBandAlone,
    speechScore,
  };
}

/** probe.mjs から名前で回せるように。 */
export const FEATURE_NAMES = [
  'level',
  'modulation',
  'flatness',
  'tone',
  'shapeFlux',
  'envelopeFlux',
  'centroid',
  'zcr',
  'harmonicity',
  'speechScore',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
