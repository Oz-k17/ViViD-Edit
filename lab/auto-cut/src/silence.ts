/**
 * 無音カット（ジェットカット）の計画を立てる。
 *
 * やることは 4 段だけ:
 *   1. しきい値を決める（自動なら音量の分布から）
 *   2. しきい値を超えたコマを「鳴っている」とする
 *   3. 前後に余白を足し、短い切れ目は繋いで、鳴っている区間をまとめる
 *   4. 残りを「削る区間」とする
 *
 * 実際に切るのは呼び出し側（edits.ts）。ここは秒の並びを返すだけなので、
 * タイムラインの実装が変わっても使い回せる。
 */

import { percentileDb, SILENCE_DB, type LoudnessTrack } from './loudness.ts';

export interface Range {
  start: number;
  end: number;
}

export interface JetCutOptions {
  /** しきい値（dBFS）。null なら音量の分布から自動で決める。 */
  thresholdDb: number | null;
  /** 自動しきい値の位置。0 = 無音の底ぎりぎり、1 = 声と同じ大きさ。 */
  sensitivity: number;
  /** これより短い無音は繋いだままにする（秒）。息継ぎで切らないため。 */
  minSilence: number;
  /** 声の前後に残す余白（秒）。0 だと語頭・語尾が食われて不自然になる。 */
  padding: number;
  /** これより短くなった残し区間は捨てる（秒）。物音 1 発で 1 カットできるのを防ぐ。 */
  minKeep: number;
  /**
   * 何を見て「鳴っている」と決めるか。
   * - `level`（既定）: 音量だけ。素材が声だけなら、これがいちばん素直で速い
   * - `speech`: 音量に加えて「声らしさ」も見る。BGM や環境音が乗った素材で効く
   */
  mode: 'level' | 'speech';
  /**
   * `speech` のとき、声らしさをどこで切るか（0〜1）。
   * 既定の 0.2 は勘ではなく、正解の分かっている素材で取りこぼしと誤検出の
   * 釣り合いがいちばん良くなる値を探して決めた（probe.mjs）。
   * 2026-09-11 の 2 回目に素材の声を作り直して測り直したところ、
   * 7331 コマで最良は 0.250（声を拾えた率 95% / 声でないのに拾った率 27%）。
   * 0.2 のままにしてあるのは、**取りこぼす側に倒れないほうを選んでいる**ため。
   */
  speechThreshold: number;
  /**
   * いったん声だと判断したあと、どこまで下がったら声でないとするか（0〜1）。
   *
   * 入る値と出る値を分けるのは、しゃべっている最中に声らしさが一瞬へこんでも
   * そこで切らないため。1 つのしきい値だけだと、へこむたびに切れ目ができる。
   * `speechThreshold` より大きい値を渡しても、入る値まで引き下げて扱う。
   */
  speechExit: number;
  /**
   * 「声が 1 つも見つからなかった」とみなす下限（0〜1）。
   *
   * 鳴っているコマのうち、声らしいと判断できたものがこの割合に満たなければ、
   * 声の入っていない素材とみなして**何もしない**（丸ごと消してしまうより安全）。
   *
   * 既定が 0.05 と低いのは、**包絡の門を入れる前はこの割合で音楽と声を分けられなかった**ため。
   * 当時の実測は 音楽だけ 28% / BGM の上でたまにしゃべる（20%）43% / よくしゃべる 63〜100% で、
   * 線を引けば必ずどちらかを壊した。そこで誰が見ても声の無い場合（打楽器だけ = 0%）だけを拾い、
   * 判断に迷う範囲は `speechRatio` として返して呼ぶ側に任せている。
   *
   * 門（`minEnvelopeChange`）を入れて割合は大きく動いたが、**線を引けないことは変わらなかった**:
   *   音楽だけ 0% / 震える楽器 0% / 和音が 1.5 秒ごとに変わる音楽 7%
   *   → ここまでは下がったが、
   *   **和音が 0.4 秒ごとに変わる音楽 51% / たまにしゃべる声 29% / `music-wah` 100%**
   * **声の無い素材が、声のある素材を追い越す。** 締めれば本物の声を弾く、緩めれば音楽を通す。
   * 2026-09-11 の 3 回目に `music-chords-fast.wav` を作って確かめた（作る前は
   * 「門を入れたから 9% 以下と 29% 以上で切れる」と思っていた）。0.05 のままにしてある。
   *
   * **この 5% にどれだけ余裕があるかは、素材によって違う**（2026-09-14・2 回目に測った）。
   * 分母は鳴っているコマ全部なので、割合の上限はその素材で声が鳴っている割合で決まる。
   * つまり余裕は「13 秒のうち 5%」ではなく
   * **（声が尺に占める割合）×（その声を数えられた割合）** が 5% を超えること。
   * びっしりしゃべる素材なら前の項が 0.8〜0.9 あるので 8 割取りこぼしても線の上に残るが、
   * 声が 2 割しか無い素材（`speech-sparse-*`）は、同じ取りこぼし率でそのまま線を割る。
   * **数える条件を厳しくするときは、声の薄い素材で余裕がいくつ残るかを先に見ること。**
   */
  minSpeechRatio: number;
  /**
   * 「スペクトルの形が動いた」とみなす下限（`FeatureTrack.shapeChange` の値）。
   *
   * 声らしさ（modulation × tone）は「音程のある音が音節の速さで揺れている」だけを見るので、
   * 音程のある楽器を同じ速さで震わせると、声が 1 つも無いのに満点が出る。
   * 割合でも弾けない（`music-tremolo.wav` は 100%）。
   *
   * そこで**別の性質**を見る。形の変化はスペクトルを自分の合計で割ってから比べるので、
   * **音量が何倍になっても動かない**。トレモロは音量が変わっているだけなので反応しない。
   * 一方、声のある素材はどこかで必ず形が動く（語頭・語尾・母音の移り変わり）。
   *
   * なお見ているのは 0.15 秒で均したあとの値なので、**一瞬の棘は数えない**。
   * そこは偶然ではなく効いていて、和音が変わる音楽は切り替わりの生の値が 0.337 まで跳ね、
   * これは BGM 込みで録った声のどのコマ（最大 0.371）とほぼ並ぶ。
   * 生の値で「一度でも動いたか」を見ていたら、この素材で破れていた。
   *
   * **ただし、均していることが効きのすべてでもある。** 2026-09-12 に生の値と
   * 均したあとを分けて測ったところ、和音の音楽で 0.09 を超える生の棘は
   * 切り替わり 1 回につき 0.06 秒ぶんしか立たず、回数に比例して増えるだけだった
   * （13 秒で 1.5 秒ごと 0.52 秒 / 0.4 秒ごと 1.94 秒 / 0.2 秒ごと 3.88 秒）。
   * 一方**声は棘ではなく動きが続いている**（鳴っている 7.20 秒のうち生で 5.94 秒）。
   * だから均すと音楽の棘だけが薄まる……はずが、棘の間隔が窓より狭くなると
   * 均したほうが逆に埋まる（0.2 秒ごとの和音は生 3.88 秒 → 均して 6.92 秒）。
   * **均す工程は「変化の間隔」で選り分けているだけで、声を見ているわけではない。**
   */
  minShapeChange: number;
  /**
   * 形が動いた時間がこれに満たなければ、声の入っていない素材とみなす（秒）。
   *
   * **素材の中の最大値ではなく「長さ」で見る**のは、1 コマの外れ値で決めないため。
   *
   * 実測（鳴っているコマで `shapeChange` が 0.09 以上だった秒数。13 秒の素材）:
   *   音楽だけ 0.00 秒 / 震える楽器 0.00 秒 / 和音が 1.5 秒ごとに変わる音楽 0.04 秒
   *   和音が 0.4 秒ごとに変わる音楽 0.30 秒
   *   **和音が 0.2 秒ごとに変わる音楽 6.90 秒** ← 声がゼロなのに素通りする
   *   声のある素材は、いちばん少ない「BGM の上でたまにしゃべる」でも 2.76 秒
   *
   * **この判定は「声があるか」を見ていない。2026-09-12 に測って分かった。**
   * 見ているのは**スペクトルの変化がどれくらいの間隔で来るか**で、
   * 分かれ目は `SHAPE_SMOOTH`（0.15 秒。features.ts）の窓の幅にある。
   * 変化がその窓より広い間隔でしか来なければ、棘は均されて消える。
   * 窓より狭い間隔で来続ければ、均しても埋まらず、声がゼロでも秒数が伸びる。
   *
   * 和音の切り替わる間隔だけを振ると、崖が 0.4 秒と 0.3 秒の間にある:
   *   間隔     0.8   0.6   0.5   0.4   0.35  0.3   0.25  0.2
   *   動いた秒 0.18  0.14  0.02  0.30  1.00  1.24  4.24  6.92
   * 声の音節は 1 秒に 4〜6 個（0.16〜0.25 秒間隔）なので、**刻みの速い伴奏は
   * 声と同じ側に落ちる。** 0.2 秒ごとの和音は 16 分音符（BPM 150）くらいで、珍しくもない。
   *
   * **窓を広げても直らない。** 均す窓を 0.15 → 0.25 → 0.4 秒と広げると、
   * 0.3〜0.4 秒ごとの和音は落とせるようになる（しかも今日の素材では声側の数字が 1 つも動かない）。
   * ところが 0.2 秒ごとの和音は逆に伸びる（6.92 → 7.44 → 7.84 秒）。
   * 窓を広げることは「もっと遅い変化まで棘とみなす」ことなので、
   * **声の音節と同じ速さで動くものはどうやっても残る。** つまみの位置の問題ではない。
   *
   * ここは**声のある素材を弾かない**ことだけを見ればよい。声の無い素材を通しても
   * 害は無い（そのあとの声らしさで弾かれる）**はずだったが、それも崩れている**
   * （`music-chords-faster.wav` は声らしさ 69%・包絡の門 8.9 秒で、そちらも素通りする）。
   * 声のある素材を弾くと、その素材では機能そのものが働かなくなるので、下限は上げない。
   *
   * ただしこれは**尺の長い素材での話**なので、短い素材では
   * `SHAPE_SECONDS_OF_DURATION` のぶんまで引き下げる（下の定数を参照）。
   */
  minShapeSeconds: number;
  /**
   * コマ単位の門。包絡（フォルマントの居場所）がこれだけ動いたコマだけを声とみなす
   * （`FeatureTrack.envelopeChange` の値）。0 にすると門を開けっぱなしにできる。
   *
   * 素材単位の `minShapeChange` との違いは、**そのコマを残すかどうかを直に決める**こと。
   * 素材単位の判定は「この素材に声があるか」しか言えないので、`music-wah` のように
   * 声が無いのに声らしく見える素材を通してしまうと、そこから先は何も守れない。
   *
   * 値が 0.09 なのは、2026-09-11 の 2 回目に測った分かれ目から採った
   * （鳴っているコマの中央値で、乾いた声 0.270 に対し震える楽器 0.009・音楽だけ 0.003）。
   * ただし**この門だけでは母音を伸ばす声を切る**（残せた率 41%）。下の保持と必ず対で使う。
   */
  minEnvelopeChange: number;
  /**
   * 包絡の門がいったん開いたら、そのあと何秒は開けたままにするか（秒）。
   *
   * **母音を伸ばしている間は口が動かないので、包絡も動かない。** 門だけを置くと
   * 「あー」と伸ばした所で声を切る。ところが**伸ばした母音の前には必ず声の立ち上がりがある**
   * ので、いったん開いたら少し開けておけば、伸ばしている間も通る。
   *
   * 長くするほど声を取りこぼさなくなるが、余計なものも残るようになる。素直な交換。
   * 実測（余白と「短い無音は残す」を外し、門の効きだけを裸で見たもの）:
   *   保持                 0 秒  0.2  0.3  0.4  **0.5**  0.6  0.8
   *   母音を伸ばす声の残せた率  56%  80%  85%  92%  **97%**  97%  97%
   *   たまにしゃべる素材の精度  84%  76%  74%  72%  **70%**  68%  68%
   * **0.5 秒で残せた率が頭打ちになる。** そこから先は精度が落ちるだけなので 0.5 を採った。
   *
   * なお JOURNAL の 2026-09-11（2 回目）に「0.6 秒」と見積もってあったが、
   * それはコマ単位で数えた値で、**実際の切り口はそこまで悪くならない**
   * （区間をまとめる工程が短い穴を埋めるため。既定の設定なら 0.2 秒で 100% に届く）。
   * 裸で測り直して、頭打ちの位置を採り直した。
   *
   * **この保持には、鎖のように繋がる弱点がある。** 保持より短い間隔で音色が動き続けると、
   * 門は一度も閉まらない。`music-chords-fast.wav`（和音が 0.4 秒ごとに変わる音楽・声なし）が
   * まさにそれで、声だと判断されるコマの割合が 保持 0 秒で 23% → 0.5 秒で 51% まで伸びる。
   * ただし**保持を 0 にしても 23% で、たまにしゃべる声（24%）と並ぶ**ので、
   * これは保持のせいではなく門そのものの限界。保持を短くしても解決しない。
   *
   * **2026-09-14 に、この弱点の実害だけは別の場所で塞いだ**（下の `minEnvelopeRun`）。
   * 門はいまも開けっぱなしになるが、素材単位の判定がその素材を止めるので、
   * 声の無い素材が切り刻まれることはなくなった。**門そのものの限界は残っている。**
   */
  envelopeHold: number;
  /**
   * 「この素材に声があるか」を数えるとき、包絡の動きが**何秒続いている**ことを要求するか（秒）。
   * 0 にすると「1 コマでも動けば数える」＝ 2026-09-14 以前の振る舞いに戻る。
   *
   * **コマ単位の門（上の `minEnvelopeChange` ＋ `envelopeHold`）には効かせていない。**
   * そこが要点なので、先にその理由を書く。
   *
   * 生の `FeatureTrack.envelopeFlux` の上で数える。均したほう（`envelopeChange`）では
   * 数えられない——**均しは 1 コマの棘を 15 コマに広げてしまう**ので、
   * 「一瞬だけ動いた」と「動き続けた」が同じ形になる。
   *
   * 置いた理由は、保持の弱点（保持より短い間隔で動きが来ると門が閉まらない）が
   * **保持の長さの問題ではなく、開ける条件の問題**だったと測れたため（2026-09-14）。
   * 音楽が門を開けるのは音の変わり目だけで、そこは必ず一瞬で終わる。
   * 声は口が動き続けるので、動きも続く。生の動きが 0.09 を超えたコマの
   * 「続いた長さ」をコマ数で数えると、そこがきれいに割れた:
   *
   * | 素材 | 1 コマ | 2 | 3 | 4 以上 |
   * | --- | --- | --- | --- | --- |
   * | ※ `music-vibrato`（音程が動く楽器・声なし） | **24** | 8 | 2 | **1** |
   * | ※ `music-chords-faster`（0.2 秒ごとに和音） | 2 | 5 | **59** | **0** |
   * | ※ `music-chords-fast`（0.4 秒ごとに和音） | 2 | 2 | **30** | **0** |
   * | `bgm` / ※ `music-tremolo` / ※ `music-swell` | 2 | 0 | 0 | **0** |
   * | `speech` の声の区間 | 3 | 0 | 4 | **27** |
   * | ※ `speech-vowels-only`（ハミング。いちばん苦しい声） | 7 | 1 | 2 | **24** |
   * | ※ `speech-sustained`（母音を伸ばす声） | 0 | 0 | 4 | **10** |
   *
   * **和音の素材は 3 コマで必ず終わる**（音の変わり目そのものの長さ）。
   * 声はいちばん苦しい `speech-vowels-only` でも 4 コマ以上が 24 本ある。
   * そこで 4 コマ（**0.08 秒**）を採った。
   *
   * **コマ単位の門に入れるのは、測って捨てた。** 割れているのだから門にも使えるはずだと
   * 思って先に入れ、声を切った（`lab:bench` の「声を残せた率」）:
   *
   * | 素材 | いまの門 | 続きの終わりで開ける | 続きの**頭まで遡って**開ける |
   * | --- | --- | --- | --- |
   * | ※ `speech-sustained` | 75% | **42%** | **64%** |
   * | ※ `speech-vowels-only` | 100% | 87% | 91% |
   * | `speech` | 98% | 90% | 94% |
   * | `speech-noisy` | 100% | 90% | 96% |
   *
   * 2 列目がひどいのは、続いたと分かるのが最後のコマなので**動き始めの 3 コマが毎回落ちる**ため。
   * 遡って開ければそこは戻るが（3 列目）、それでも戻りきらない。
   * 残る差は**声にも 1〜3 コマで終わる動きが 2〜3 割ある**ことで、
   * そこを落とすぶんはどう並べ替えても戻らない。**門に入れるかぎり交換になる。**
   *
   * **同じ量でも、要求を厳しくしてよい場所とそうでない場所がある。**
   * コマ単位の門は 1 コマ落とせばそこで声が切れる（取り返しがつかない）。
   * 素材単位の判定は 13 秒のうち 5%（`minSpeechRatio`）残っていればよいので、
   * 2〜3 割取りこぼしても結論は変わらない。**厳しい条件はこちらにだけ置く。**
   * （**ただし、その余裕は声がたっぷり入っている素材でしか無い。**
   *  声の薄い素材では 2〜3 割でも線を割る。`minSpeechRatio` の注を参照。
   *  この条件は声のある 16 本で割合をほとんど動かさない（最大 1 ポイント）ので、そこは問題にならない。）
   * そうしたら、声のある 15 本は削減も残せた率も精度も**1 ポイントも動かないまま**、
   * `music-chords-faster` の削減 18% → 0%、`music-vibrato` の 4% → 0% になった。
   *
   * **この条件が閉められるのは「変わり目だけの音楽」に限る。**
   * 減衰する打点（`drums` は 9 コマ、`music-hats` は 6 コマ）や、
   * 鳴っている間ずっと息が揺れる `music-flute`（11 コマ以上が 18 本）は、これでは弾けない。
   *
   * **余裕は広くない。** `music-vibrato` の割合は 4% で、5% の線のすぐ下にいる
   * （声のある素材でいちばん低いのは `speech-sparse-bgm` の 26%）。
   * 音の間隔がもう少し詰まれば通る。ここは数字を見ながら扱うこと。
   */
  minEnvelopeRun: number;
  /**
   * 声だと判断できたコマから、**鳴っているあいだだけ遡って拾う**長さ（秒）。
   *
   * `speech` モードの取りこぼしは、2026-09-15 に測ったら**全部が発話の頭**だった
   * （8 本・10 区間、発話の中も尻も 1 つも無い）。偶然ではなく、
   * **この判定の仕組みがどれも前方向にしか伸びない**ため:
   *   - 揺れを見る窓（実効 0.64 秒）は中心が `i` なので、発話の頭では半分が発話の前で埋まる
   *   - ヒステリシスは入る値 0.2 で開き、出る値 0.1 で閉じる（頭は厳しく、尻は緩い）
   *   - 包絡の保持（`envelopeHold`）は動いたコマから**後ろへ** 0.5 秒
   * 後ろへ伸びるものばかりで、**前へ戻すものが 1 つも無い**。だから頭だけが削れる。
   *
   * ここで戻すのは「鳴っていたのに、まだ声だと言えていなかったコマ」だけ。
   * 無音は遡らない（`sounding` でないコマで止まる）ので、前の発話との間や
   * 素材の頭の無音までは伸びない。
   *
   * **既定の 0.32 秒は、揺れを見る窓の半分**（`MOD_WINDOW` は 1.0 秒だが、FFT の格子に
   * 合わせて 32 コマ＝0.64 秒に丸められる）。窓の中心が `i` である以上、
   * 判定が間に合うのは**発話が窓の半分を埋めてから**なので、遅れの上限がここになる。
   * つまみを回して決めた値ではない。
   *
   * 測った表（**遡りを潰す素材を足す前**の 28 本で振った。
   * 声のある 16 本の平均 / 声の無い 12 本の合計。2026-09-15）:
   *   | 遡り | 声を残せた率 | 残したうち声だった率 | 声ゼロを切った秒 |
   *   | 0（入れる前） | 97.8% | 71.5% | 0.98s |
   *   | 0.2s  | 98.9% | 71.1% | 0.76s |
   *   | **0.32s** | **99.2%** | **70.9%** | **0.64s** |
   *   | 0.5s  | 99.7% | 70.6% | 0.46s |
   *   | 0.7s  | 100.0% | 70.2% | 0.42s |
   *
   * 潰す素材（`speech-chord-into.wav`）を足したあとの 29 本では
   * **残せた率 97.9% → 99.3% / 声だった率 71.2% → 70.2% / 声ゼロを切った秒 0.98s → 0.64s**。
   *
   * **残せた率と「声ゼロを切った秒」が同時に良くなる**（ふつうは交換になる）。
   * 声の無い素材で切っていたのも発話の頭と同じ現象（`music-flute` の 0.78 秒は素材の両端）
   * だったので、同じ手で両方が戻る。
   *
   * **代わりに測って捨てた手が 2 つある:**
   * - **余白（`padding`）を左右いっしょに広げる。** 同じ残せた率 99.0% のところで（同じ 28 本）
   *   声だった率が **60.4%**（遡りなら 70.9%）。尻は保持で足りているので、
   *   そちらまで伸ばすぶんが丸損になる。
   * - **定数を置かず、出る値（0.1）を保っているあいだ遡る。** 自己完結して見えるが、
   *   残せた率 99.1% / 声だった率 70.5% / 声ゼロ 0.84s と全部の列で負ける。
   *   `speech-sustained` は 88% で頭打ちになる（頭では声らしさが 0.1 も割っている）。
   *   **遅れの大きさは声らしさの値ではなく窓の幅で決まる**ので、値から遡り幅は出せない。
   *
   * 0 にすれば入れる前の振る舞いに戻る（`LAB_NO_LEAD=1 npm run lab:bench`）。
   */
  speechLeadIn: number;
}

/**
 * 形が動いた時間の下限を、尺に対する割合としても持つ。
 *
 * `minShapeSeconds` を固定値だけにすると、**短い素材で本物の声を弾いてしまう**。
 * 2026-09-10 の時点では、3 秒に切り詰めた `speech-dry.wav` が、声が入っているのに
 * 形が動いた時間が 0.40 秒しかなく、0.5 秒に届かなかった（ショート動画では
 * 3 秒の素材は普通にある）。
 *
 * **2026-09-11 の 2 回目に素材の声を作り直したら、同じ 3 秒で 1.30 秒動くようになった**
 * ので、いまの素材だけを見るならこの安全弁は要らない。それでも残してあるのは、
 * 当時弾かれたのが「平板な合成音だったから」なのか「尺が短いから」なのかを
 * 切り分けられていないため。落として困るのは声のある素材だけで、
 * 鳴りっぱなしの音楽は尺に関わらず 0 秒なので、下げておいても音楽は通らない。
 *
 * 声のある素材で形が動く時間は、いまは尺の 21〜81% ある
 * （いちばん少ないのは「BGM の上でたまにしゃべる」の 21%）。5% はそこから 4 倍の余裕。
 */
const SHAPE_SECONDS_OF_DURATION = 0.05;

export const DEFAULT_JET_CUT: JetCutOptions = {
  thresholdDb: null,
  sensitivity: 0.25,
  minSilence: 0.35,
  padding: 0.08,
  minKeep: 0.15,
  mode: 'level',
  speechThreshold: 0.2,
  speechExit: 0.1,
  minSpeechRatio: 0.05,
  minShapeChange: 0.09,
  minShapeSeconds: 0.5,
  minEnvelopeChange: 0.09,
  envelopeHold: 0.5,
  minEnvelopeRun: 0.08,
  speechLeadIn: 0.32,
};

export interface JetCutPlan {
  /** 実際に使ったしきい値（自動決定の結果を見せるため）。 */
  thresholdDb: number;
  /** 残す区間。 */
  keep: Range[];
  /** 削る区間。 */
  cut: Range[];
  originalDuration: number;
  /** 削ったあとの尺。 */
  resultDuration: number;
  /** 削った秒数。 */
  removed: number;
  /**
   * 実際に使った判定のしかた。
   * `speech` を指定しても声らしさの列が渡されていなければ `level` に落ちる。
   * 黙って落ちると「効かないのはなぜか」が分からなくなるので、結果に残す。
   */
  usedMode: 'level' | 'speech';
  /**
   * `speech` で見たが、声らしいところが見つからなかった。
   * このとき keep は「全部残す」になっている（削らない）。
   * 音楽だけの素材を掛け違えて丸ごと消してしまうより、何もしないほうがよい。
   */
  noSpeechFound: boolean;
  /**
   * `noSpeechFound` になった理由。
   * - `ratio`: 声だと判断できたコマがほとんど無かった（打楽器だけなど）。
   *   包絡の門も判断の一部なので、**「音色がどこでも動かない」もここに入る**。
   *   門を入れてから、鳴りっぱなしの音楽と震える楽器はこちらで落ちるようになった
   *   （以前は下の `shape` で落ちていた）。
   * - `shape`: 声だと判断できたコマはあるが、素材のどこでもスペクトルの形が続けて動かなかった
   *
   * 分けて返すのは、同じ「何もしない」でも次にすべきことが違うため。
   */
  noSpeechReason: 'ratio' | 'shape' | null;
  /** スペクトルの形が動いていた秒数。`shape` の判断の根拠を見せるため。 */
  shapeSeconds: number;
  /**
   * 包絡の門が開いていた秒数（鳴っているコマのうち）。
   *
   * 保持のぶんも含む。**保持が音楽の一瞬の動きを引き伸ばしていないか**を
   * 外から確かめるために出している。声の無い素材でここが伸びていたら、
   * 保持が長すぎるということ。
   */
  envelopeSeconds: number;
  /**
   * 鳴っているコマのうち、声らしいと判断できたものの割合（0〜1）。
   * `level` のときは 1。低いときは「声の少ない素材に掛けていないか」を疑う手がかりになる。
   */
  speechRatio: number;
}

/**
 * 音量の分布からしきい値を決める。
 * 下位 10% を「その素材の無音の底（部屋のノイズ）」、上位 10% を「声の大きさ」とみなし、
 * その間を sensitivity で内分する。録音レベルがバラバラな素材でも同じ感覚で効く。
 */
export function autoThresholdDb(track: LoudnessTrack, sensitivity: number): number {
  const floor = percentileDb(track, 0.1);
  const voice = percentileDb(track, 0.9);
  // ほぼ全編が同じ音量（無音だけ・BGM だけなど）のときは、分けようがないので底に張り付ける。
  if (voice - floor < 6) return floor - 1;
  const ratio = Math.max(0, Math.min(1, sensitivity));
  return floor + (voice - floor) * ratio;
}

/** 区間を繋いだり広げたりする小道具。start 昇順で重なりのない列を返す。 */
function mergeRanges(ranges: Range[], gap: number): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start - last.end <= gap) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/** keep の隙間を埋めるかたちで「削る区間」を作る。 */
function complement(keep: Range[], duration: number): Range[] {
  const cut: Range[] = [];
  let cursor = 0;
  for (const range of keep) {
    if (range.start > cursor) cut.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration) cut.push({ start: cursor, end: duration });
  return cut;
}

/**
 * 「動きが続いたコマ」を、コマごとの開閉として先に組み立てる。
 *
 * いまの使い道は**素材単位の判定（`speechRatio`）だけ**で、
 * コマ単位の門には使っていない（理由は `minEnvelopeRun` の注に測った表がある）。
 *
 * **1 コマずつ前から決められないので、別の工程に分けてある。** 開ける条件が
 * 「動きが `minRun` コマ続いたこと」なので、続いたと分かるのは最後のコマまで来たとき。
 * そこで開けると、**動き始めの数コマが毎回落ちる**（声の語頭がそこに当たる）。
 * 動きは続きの先頭から始まっているのだから、**遡って開ける**のが正しい。
 * 門に入れる案を測ったときは、ここを直すだけで取りこぼしが 3 分の 1 に減った。
 *
 * @param flux 均す前の包絡の動き。均したものでは「続いたか」を数えられない
 *   （均しは 1 コマの棘を 15 コマに広げるので、一瞬の動きが長く続いたように見える）。
 * @param sounding そのコマが鳴っているか。無音を挟んだら続きも保持も切る
 *   （別々の一瞬の動きが、無音をまたいで「続いた」ことにならないように）。
 */
export function envelopeGateFrames(
  flux: Float32Array,
  sounding: (i: number) => boolean,
  minChange: number,
  minRunFrames: number,
  holdFrames: number,
): Uint8Array {
  const open = new Uint8Array(flux.length);
  const run = Math.max(1, minRunFrames);
  let length = 0;
  let openUntil = -1;
  for (let i = 0; i < flux.length; i += 1) {
    if (!sounding(i)) {
      // 無音で、続きも保持も切る。またいで数えると、別々の一瞬の動きが「続いた」ことになる。
      length = 0;
      openUntil = -1;
      continue;
    }
    length = flux[i] >= minChange ? length + 1 : 0;
    // **遡るのは、続きがちょうど条件を満たした 1 回だけ。** 毎コマ頭まで戻ると、
    // 動き続ける素材で計算量が尺の 2 乗になる（10 分の素材で刺さる）。
    // ここを過ぎたあとは、保持が前へ伸びるだけなので遡る必要が無い。
    // 遡る範囲のコマは、続きを数えている間ずっと鳴っていたので、鳴っているか確かめ直さなくてよい。
    if (length === run) for (let k = i - run + 1; k < i; k += 1) open[k] = 1;
    if (length >= run) openUntil = i + holdFrames;
    if (i <= openUntil) open[i] = 1;
  }
  return open;
}

/**
 * @param speechScore コマごとの声らしさ（0〜1）。`mode: 'speech'` のときだけ使う。
 *   音そのものを見ないと出せない値なので、features.ts で作って渡してもらう。
 * @param shapeChange コマごとのスペクトルの形の変化。渡さなければ形での判断はしない
 *   （渡されないものを「動いていない」と読むと、丸ごと何もしなくなってしまう）。
 * @param envelopeChange コマごとの包絡の動き。渡さなければ包絡の門は置かない。
 *   `shapeChange` と同じ理由で、**渡されないものを「動いていない」と読まない**
 *   （読んでしまうと、列を渡し忘れただけで声が 1 コマも残らなくなる）。
 * @param envelopeFlux 均す前の包絡の動き。渡さなければ「動きが続いたか」は見ない
 *   （＝ `minEnvelopeRun` を 0 として扱う）。ここも**渡されないものを
 *   「続かなかった」と読まない**。読むと、列を渡し忘れただけで門が開かなくなる。
 */
export function planJetCut(
  track: LoudnessTrack,
  options: Partial<JetCutOptions> = {},
  speechScore?: Float32Array,
  shapeChange?: Float32Array,
  envelopeChange?: Float32Array,
  envelopeFlux?: Float32Array,
): JetCutPlan {
  const opts = { ...DEFAULT_JET_CUT, ...options };
  const thresholdDb = opts.thresholdDb ?? autoThresholdDb(track, opts.sensitivity);
  const duration = track.duration;
  const usedMode = opts.mode === 'speech' && speechScore && speechScore.length === track.db.length ? 'speech' : 'level';

  // 2. しきい値を超えたコマを拾い、そのまま 3. の余白を足す。
  const enter = opts.speechThreshold;
  const exit = Math.min(opts.speechExit, enter);
  let inSpeech = false;
  let soundingFrames = 0;
  let speechFrames = 0;
  // 「この素材に声があるか」を決めるほうの数。門の厳しい条件はこちらにだけ効かせる。
  let strictSpeechFrames = 0;
  const useShape = !!shapeChange && shapeChange.length === track.db.length;
  let shapeFrames = 0;
  // 包絡の門。開いたコマの番号を覚えておき、そこから holdFrames コマ先までは開けたままにする。
  const useEnvelope = !!envelopeChange && envelopeChange.length === track.db.length && opts.minEnvelopeChange > 0;
  const holdFrames = Math.max(0, Math.round(opts.envelopeHold / track.hop));
  // 「動きが続いたか」は均す前の列でしか数えられない（均しは棘を広げてしまう）。
  // 渡されなければ 1 コマで開く＝2026-09-14 以前の振る舞い。
  const useRun = !!envelopeFlux && envelopeFlux.length === track.db.length && opts.minEnvelopeRun > 0;
  const sounding = (i: number) => track.db[i] > thresholdDb && track.db[i] > SILENCE_DB;
  const runGate = useRun
    ? envelopeGateFrames(
        envelopeFlux as Float32Array,
        sounding,
        opts.minEnvelopeChange,
        Math.max(1, Math.round(opts.minEnvelopeRun / track.hop)),
        holdFrames,
      )
    : null;
  let envelopeOpenUntil = -1;
  let envelopeFrames = 0;
  // 発話の頭を遡って拾うぶん。level モードでは鳴っているコマをすべて拾うので出番が無い。
  const leadFrames = usedMode === 'speech' ? Math.max(0, Math.round(opts.speechLeadIn / track.hop)) : 0;
  // どこまで拾ったか。同じコマを二度拾わないため（重なっても mergeRanges が畳むが、
  // 数を膨らませるだけ無駄なので止めておく）。
  let lastKept = -1;

  const loud: Range[] = [];
  const keepFrame = (i: number) => {
    loud.push({
      start: Math.max(0, i * track.hop - opts.padding),
      end: Math.min(duration, (i + 1) * track.hop + opts.padding),
    });
    lastKept = i;
  };
  for (let i = 0; i < track.db.length; i += 1) {
    if (track.db[i] <= thresholdDb || track.db[i] <= SILENCE_DB) {
      inSpeech = false;
      // 無音を挟んだら保持も切る。前の発話の余韻で、そのあとに来た音楽まで通してしまわないため。
      // 保持が守りたいのは「ひと続きの声の中で伸ばした母音」だけで、無音をまたぐ必要は無い。
      envelopeOpenUntil = -1;
      continue;
    }
    soundingFrames += 1;
    // 形が動いたかは、声らしさの判定とは独立に数える。
    // 声らしさで絞ってから数えると、震える楽器では「声らしいコマ」が
    // 全編になるので、動かないことを見つけられなくなる。
    if (useShape && (shapeChange as Float32Array)[i] >= opts.minShapeChange) shapeFrames += 1;
    if (usedMode === 'speech') {
      // 入る値と出る値を分ける（ヒステリシス）。しゃべっている最中の
      // 一瞬のへこみで切れ目を作らないため。
      const score = (speechScore as Float32Array)[i];
      inSpeech = inSpeech ? score >= exit : score >= enter;
      if (!inSpeech) continue;
      // 包絡の門。声らしさ（揺れ × 音程）は「音色が動いているか」を見ていないので、
      // ここで口の動きを要求して、鳴りっぱなしの音を落とす。
      // inSpeech（声らしさ側の状態）はここでは触らない。門で閉めたことを
      // 「声でなくなった」と読むと、ヒステリシスが毎回入り直しになってしまう。
      if (useEnvelope) {
        if ((envelopeChange as Float32Array)[i] >= opts.minEnvelopeChange) envelopeOpenUntil = i + holdFrames;
        if (i > envelopeOpenUntil) continue;
        envelopeFrames += 1;
      }
      speechFrames += 1;
      // 素材単位の判定（「この素材に声があるか」）だけは、もっと厳しい条件で数える。
      //
      // **同じ量でも、要求を厳しくしてよい場所とそうでない場所がある。**
      // コマ単位の門は 1 コマ落とせばそこで声が切れる（取り返しがつかない）。
      // 素材単位の判定は 13 秒のうち 5% 残っていればよいので、
      // 取りこぼしても結論は変わらない。だから厳しい条件はこちらに置く。
      if (!runGate || runGate[i]) strictSpeechFrames += 1;
      // 発話の頭を遡って拾う。**鳴っていたのに声だと言えていなかったコマ**だけが対象で、
      // 無音に当たったらそこで止まる（`sounding` が false なら break）。
      //
      // ここで拾ったコマは `speechFrames` にも `strictSpeechFrames` にも数えない。
      // 数えると「この素材に声があるか」の割合が、判定していないコマで水増しされる。
      // 拾うのは**声だと判断できた場所の手前**に限るので、割合の意味は変えない。
      if (leadFrames > 0) {
        let from = i;
        const floor = Math.max(lastKept + 1, i - leadFrames);
        while (from > floor && sounding(from - 1)) from -= 1;
        for (let k = from; k < i; k += 1) keepFrame(k);
      }
    }
    keepFrame(i);
  }

  // 割合は厳しいほうで数える（上の strictSpeechFrames の注を参照）。
  // 門を渡されていなければ strictSpeechFrames === speechFrames なので、振る舞いは変わらない。
  const speechRatio = usedMode === 'speech' ? (soundingFrames > 0 ? strictSpeechFrames / soundingFrames : 0) : 1;
  const shapeSeconds = shapeFrames * track.hop;
  const envelopeSeconds = envelopeFrames * track.hop;

  // 声が 1 つも見つからなかったら、何もしない。理由は 2 通りあり、どちらも
  // 単独では取りこぼす（割合は音楽を、形は打楽器を見逃す）ので、両方を見る。
  const lowRatio = soundingFrames > 0 && speechRatio < opts.minSpeechRatio;
  const needShapeSeconds = Math.min(opts.minShapeSeconds, duration * SHAPE_SECONDS_OF_DURATION);
  const noShape = useShape && soundingFrames > 0 && shapeSeconds < needShapeSeconds;
  if (usedMode === 'speech' && (lowRatio || noShape)) {
    const whole = duration > 0 ? [{ start: 0, end: duration }] : [];
    return {
      thresholdDb,
      keep: whole,
      cut: [],
      originalDuration: duration,
      resultDuration: duration,
      removed: 0,
      usedMode,
      noSpeechFound: true,
      noSpeechReason: lowRatio ? 'ratio' : 'shape',
      speechRatio,
      shapeSeconds,
      envelopeSeconds,
    };
  }

  // 3. 隣り合うものと、minSilence より短い切れ目しかないものを繋ぐ。
  const keep = mergeRanges(loud, opts.minSilence).filter((r) => r.end - r.start >= opts.minKeep);
  const cut = complement(keep, duration);

  const kept = keep.reduce((sum, r) => sum + (r.end - r.start), 0);
  return {
    thresholdDb,
    keep,
    cut,
    originalDuration: duration,
    resultDuration: kept,
    removed: Math.max(0, duration - kept),
    usedMode,
    noSpeechFound: false,
    noSpeechReason: null,
    speechRatio,
    shapeSeconds,
    envelopeSeconds,
  };
}

/**
 * 切った区間のうち、音が鳴っていた秒数。
 *
 * **声の無い素材で「削減 X%」を読むための数**（2026-09-14・3 回目に足した）。
 * 削減率だけでは、素材にもともと開いている無音を切ったのか、鳴っている音楽を
 * 切ったのかが分からない。無音を切るのは無音カットとして正しい振る舞いで、曲は壊れない。
 * 壊れるのは鳴っているところを切ったときだけなので、そこを分けて数える。
 *
 * これを出したその場で、**7 回ぶんの前提が 1 つ崩れた**。`music-wah.wav` の削減 21% は
 * 鳴っているコマを 1 つも切っておらず、全部この素材自身に開いている 5.32 秒の無音だった。
 * 「声がゼロなのに 7 本に切り刻む」と読んで 7 通りの手がかりを試してきたが、
 * 弾くべき実害はそこには無かった（level モードでも同じ 2.72 秒を切る）。
 * **声の無い素材の削減率は、単独では実害の大きさを表さない。**
 *
 * @param plan `track` と同じ素材に対する計画。`plan.thresholdDb` で鳴っているかを決めるので、
 *   別の素材の計画を渡すと意味のない数になる。`plan.cut` は昇順で重ならないことを当てにしている
 *   （`complement()` がそう作る）。手で組んだ区間を渡すときは、そこだけ守ること。
 */
export function cutSoundingSeconds(track: LoudnessTrack, plan: JetCutPlan): number {
  let seconds = 0;
  // `cut` は complement() が作るので昇順で重ならない。コマも前から見るので、
  // いちど通り過ぎた区間へ戻る必要はない（尺に比例した手間で済ませるため）。
  let head = 0;
  for (let i = 0; i < track.db.length; i += 1) {
    if (track.db[i] <= plan.thresholdDb || track.db[i] <= SILENCE_DB) continue;
    const from = i * track.hop;
    const to = from + track.hop;
    while (head < plan.cut.length && plan.cut[head].end <= from) head += 1;
    // コマと区間の重なりで足す。余白（padding）のぶん区間の端はコマ境界に乗らないので、
    // 「コマの頭が入っているか」で数えると 1 コマぶんずれる。
    for (let k = head; k < plan.cut.length && plan.cut[k].start < to; k += 1) {
      seconds += Math.min(to, plan.cut[k].end) - Math.max(from, plan.cut[k].start);
    }
  }
  return seconds;
}

/** 残した秒のうち、声でなかったぶんの内訳（`keepEdgeSeconds`）。 */
export interface KeepEdges {
  /** 発話の**手前**に付いていた秒（右どなりが声、左は声でない）。 */
  head: number;
  /** 発話の**うしろ**に付いていた秒（左どなりが声、右は声でない）。 */
  tail: number;
  /** 発話と発話の**あいだを渡った**秒（両どなりが声）。息継ぎを繋いだぶんはここ。 */
  bridge: number;
  /** どの発話にも**接していない**秒（丸ごと誤って残した区間）。 */
  stray: number;
}

/**
 * 残した区間のうち**声でなかった秒**を、発話との位置関係で 4 つに分ける。
 *
 * **「残したうち声だった率」（精度）が低いとき、どこで落としているかを見るための数**
 * （2026-09-15・2 回目に足した）。精度は 1 つの数なので、
 * 「頭に余白を付けすぎている」のか「発話の間を渡ってしまっている」のか
 * 「声と関係ない所を丸ごと残している」のかが区別できない。直す手はそれぞれ別なので、
 * 分けずに眺めているかぎり、どのつまみを回せばよいかが決まらない。
 *
 * **これを出して、前の回の読みが 1 つ外れた。** 「尻は保持とヒステリシスで足りている」と
 * 書いていたが、乾いた素材の尻に付いていたのは**余白（`padding`）ちょうどの 0.08 秒**で、
 * 保持もヒステリシスも 1 コマも伸ばしていなかった。どちらも「鳴っている」が前提なので、
 * 発話のあとが無音なら即座に閉じる。**足りていたのではなく、そもそも働いていなかった。**
 *
 * 尻が伸びるのは発話のあとも音が鳴り続ける素材だけで、そこでは 0.7〜1.4 秒まで伸びる。
 * ただし**それもヒステリシスのせいではない**（`keepScoreSeconds` の注を参照）。
 *
 * `bridge` を「余計」と読みすぎないこと。発話の間が `minSilence` より短ければ
 * 繋ぐのが正しい振る舞いで、正解の側が息継ぎを発話に含めていないだけ。
 * 実際いまの素材では 0.2 秒の切れ目が 2 つあり、そこは毎回ここに入る。
 *
 * @param keep 残す区間。昇順で重ならないこと（`planJetCut` の `keep` がそう作る）。
 * @param truth 発話の正解区間。こちらも昇順で重ならないこと。
 */
export function keepEdgeSeconds(keep: Range[], truth: Range[]): KeepEdges {
  const edges: KeepEdges = { head: 0, tail: 0, bridge: 0, stray: 0 };
  // 秒は浮動小数なので、端が一致するかはコマ 1 つ（0.02 秒）よりずっと細かい幅で見る。
  const EPS = 1e-9;
  const add = (seconds: number, left: boolean, right: boolean) => {
    if (seconds <= 0) return;
    if (left && right) edges.bridge += seconds;
    else if (left) edges.tail += seconds;
    else if (right) edges.head += seconds;
    else edges.stray += seconds;
  };
  // keep も truth も昇順なので、いちど通り過ぎた発話へ戻る必要はない
  // （戻る書き方だと尺の 2 乗になり、長尺で刺さる。cutSoundingSeconds と同じ理由）。
  let head = 0;
  for (const r of keep) {
    while (head < truth.length && truth[head].end <= r.start) head += 1;
    // keep の頭が、ちょうど発話の終わりに接している場合（左どなりは声）。
    let leftIsSpeech = head > 0 && Math.abs(truth[head - 1].end - r.start) < EPS;
    let cursor = r.start;
    // r.end ちょうどから始まる発話も見る（右どなりが声なので、そこは「頭」）。
    for (let k = head; k < truth.length && truth[k].start <= r.end; k += 1) {
      const u = truth[k];
      if (u.start > cursor) add(u.start - cursor, leftIsSpeech, true);
      cursor = Math.max(cursor, Math.min(u.end, r.end));
      // 発話の終わりが keep の外なら、そこから先に隙間は無い（次の周で u.start > cursor にならない）。
      leftIsSpeech = u.end <= r.end;
    }
    add(r.end - cursor, leftIsSpeech, false);
  }
  return edges;
}

/** 残した秒のうち、声でなかったぶんを声らしさの値で分けたもの（`keepScoreSeconds`）。 */
export interface KeepScores {
  /** 入る値以上。**判定そのものが「声だ」と言っている**ぶん。 */
  above: number;
  /** 入る値と出る値のあいだ。**ヒステリシスが伸ばした**ぶん。 */
  between: number;
  /** 出る値未満。余白や区間の繋ぎが持ってきたぶん。 */
  below: number;
}

/**
 * 残した区間のうち**声でなかった秒**を、声らしさの値で 3 つに分ける。
 *
 * `keepEdgeSeconds` が「どこで」なら、こちらは「**何が**そこを残させたか」。
 * 直す手が値ごとに違うので分ける:
 * `above` は声らしさの中身を変えるしかなく、`between` はヒステリシスのつまみ、
 * `below` は余白と区間の繋ぎのつまみで動く。
 *
 * **この 3 つを並べたところで、この回の見立てが潰れた**（2026-09-15・2 回目）。
 * 声のある 17 本で余計に残した 54.88 秒の内訳は
 * **`above` 40.94 秒（75%）/ `between` 12.30 秒（22%）/ `below` 1.64 秒（3%）**。
 * 尻が 1.4 秒伸びていた素材でも、伸ばしていたのはヒステリシスではなく
 * **背景そのものが入る値を超えていた**（打楽器の上では、発話が終わったあとも
 * 声らしさが 0.2 を跨いで出入りし続ける）。
 *
 * だから「出る値で伸ばしてよい上限」を置いても効かない。実際に置いて振ったが、
 * 上限 0.2 秒まで 3 つの数字が 1 つも動かない（`auto-cut/README.md` に表がある）。
 * **端の扱いで拾えるのは残り 25% だけで、4 分の 3 は声らしさの中身の問題。**
 *
 * @param track `keep` と同じ素材の音量の列。コマの刻みをここから採る。
 * @param speechScore `track` と同じ長さの声らしさ。長さが違えば全部 0 を返す。
 * @param enter 入る値（`speechThreshold`）。 @param exit 出る値（`speechExit`）。
 */
export function keepScoreSeconds(
  track: LoudnessTrack,
  keep: Range[],
  truth: Range[],
  speechScore: Float32Array,
  enter: number,
  exit: number,
): KeepScores {
  const scores: KeepScores = { above: 0, between: 0, below: 0 };
  if (speechScore.length !== track.db.length) return scores;
  // 出る値が入る値を上回っていても、planJetCut と同じく入る値まで引き下げて扱う
  // （そうしないと between が負の幅になり、全部 below に落ちる）。
  const low = Math.min(exit, enter);
  let keepHead = 0;
  let truthHead = 0;
  for (let i = 0; i < track.db.length; i += 1) {
    const from = i * track.hop;
    const to = from + track.hop;
    // コマと区間の重なりで数える（余白のぶん、区間の端はコマ境界に乗らない）。
    while (keepHead < keep.length && keep[keepHead].end <= from) keepHead += 1;
    while (truthHead < truth.length && truth[truthHead].end <= from) truthHead += 1;
    let kept = 0;
    let keptVoice = 0;
    for (let k = keepHead; k < keep.length && keep[k].start < to; k += 1) {
      const a = Math.max(from, keep[k].start);
      const b = Math.min(to, keep[k].end);
      kept += b - a;
      // **声のぶんは「このコマにある声」ではなく「残したところにある声」で引く。**
      // コマの途中で発話も残しかたも切れると、同じコマの中で
      // 「声だが残していない」と「残したが声でない」が同時に立つ。
      // コマ単位で引くと、その 2 つが打ち消し合って数え落とす。
      for (let j = truthHead; j < truth.length && truth[j].start < b; j += 1) {
        keptVoice += Math.max(0, Math.min(b, truth[j].end) - Math.max(a, truth[j].start));
      }
    }
    const extra = kept - keptVoice;
    if (extra <= 0) continue;
    const score = speechScore[i];
    if (score >= enter) scores.above += extra;
    else if (score >= low) scores.between += extra;
    else scores.below += extra;
  }
  return scores;
}
