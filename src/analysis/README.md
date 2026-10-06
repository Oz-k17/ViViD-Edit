# src/analysis — ラボの試作から持ってきた解析（試験的）

`lab/` で「実用ラインに乗った」と判断した 3 つを、本体で使えるように写したもの。

| ここ | 写し元 | 役目 |
| --- | --- | --- |
| `frames.ts` `scene.ts` | `lab/scene-cut/src/` | カットの切り替わり検出 |
| `thumb.ts` `pick.ts` | `lab/thumbnail/src/` | 表紙に使えるコマの選別 |
| `columns.ts` `reframe.ts` | `lab/reframe/src/` | 被写体を追う枠の置き所 |
| `audio/loudness.ts` `audio/lufs.ts` `audio/limiter.ts` | `lab/auto-cut/src/` | 音量の測り（LUFS）・倍率の決め方・真のピークのリミッタ |
| `decode.ts` | `lab/scene-cut/src/decode.ts` | 動画をコマの列にする（**本体で `from`/`to` を足した**） |
| `cover-export.ts` | `lab/thumbnail/src/export.ts` | コマを画像にする（**ラボの `saveBlob` は持ってきていない**） |
| `segments.ts` | **本体で足した** | 枠の中心の列を、止まった区間に畳む（下を参照） |

## 写しと原本がずれないように

判断の部分（`frames` `scene` `thumb` `pick` `columns` `reframe`）は**原本と 1 文字も違わない**ことを
`npm run test:model` が見ている（`pick.ts` の import の 1 行だけは直してある）。
ラボ側を直したら `npm run analysis:sync` で写し直す。**ここだけを直さないこと**——
ラボのセルフテスト（`npm run lab:test`）が見ているのは原本のほうで、写しは見ていない。

`decode.ts` と `cover-export.ts` は本体の都合で手を入れてあるので、同期の対象にしていない。
原本を直したときは差分を見て手で持ってくる。

## なぜ「区間に畳む」のか（`segments.ts`）

ラボの計画は「コマごとの枠の中心」で、**枠が滑らかに動く**前提。
本体は時間で変わる値（キーフレーム）を持っていない（`lab/keyframe/` は試作止まり）ので、
滑らかには動かせない。代わりに、中心がほぼ同じ所を 1 区間にまとめ、区間ごとに枠を止め、
区間の境目でクリップを割る。**暫定の形**で、キーフレームが入れば要らなくなる。

測った代価（ラボの正解付き 6 本・30fps、`npm run test:model` の外・手元で測定）:
被写体を枠に入れた率は 連続 **95.8%** → 区間に畳むと **95.2%**（−0.6 ポイント）。
素材ごとの区間数は 1〜7。**落ちるのは `subject-pause` の 96.1% → 91.5%** で、
止まっている被写体が短い区間に割られたとき。

## 数字の読み方

ラボの数字はすべて**合成した試し素材**で測ったもの。本物の配信アーカイブでは測っていない。
画面にも「試験的」と書いてあるのはそのため。結果は Undo 1 回で戻る。
