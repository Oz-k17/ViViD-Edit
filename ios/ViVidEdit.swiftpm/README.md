# ViViD Edit — iOS 版（Swift Playgrounds）

Web 版のエディタをそのまま `WKWebView` で表示し、**書き出した動画を端末に保存する部分だけ**を
ネイティブで受け持つ薄いガワです。ブラウザのサンドボックスでは保存が塞がれていて iPhone に
動画を残せないため、そこだけネイティブに逃がしています。

| ファイル | 役割 |
| --- | --- |
| `Package.swift` | Swift Playgrounds 用のアプリ定義（写真への追加権限もここで宣言） |
| `App.swift` | 画面の組み立てと、保存状況のトースト表示・共有シート |
| `EditorWebView.swift` | WKWebView の設定と、JS ↔ ネイティブの受け渡し |
| `VideoSaver.swift` | 分割で届く動画をファイルに書き、カメラロールへ保存 |
| `Resources/web/` | Web 版のビルド結果（`npm run build:ios` で更新） |

## 入れ方

### iPad（いちばん簡単）

1. iPad の Safari で
   [**ViViD-Edit-main.zip**](https://github.com/Oz-k17/ViViD-Edit/archive/refs/heads/main.zip)
   を開く（「ファイル」アプリに保存されます）
2. 「ファイル」アプリで保存した ZIP をタップして展開する
3. `ios/ViVidEdit.swiftpm` をタップすると Swift Playgrounds が開く
4. 実行（▶）すると、その iPad にアプリとして入る

### iPhone

Swift Playgrounds は iPad と Mac 向けで、iPhone 版はありません。iPhone に入れるには
Mac の Xcode で `ios/ViVidEdit.swiftpm` を開き、iPhone を繋いで実行してください。
無料の Apple ID でも入れられますが、その場合 7 日で期限が切れるので、切れたら同じ手順で入れ直します。

## 保存のしくみ

書き出しが終わると、Web 側が動画を 512KB ずつに分けてネイティブへ送ります
（数十 MB の動画を一度に渡すとメモリを使い切って落ちるため）。ネイティブ側は受け取った分を
そのままテンポラリのファイルへ書き足し、最後にカメラロールへ保存します。
写真への保存を許可しなかった場合は、共有シートが開いて「ファイル」などに保存できます。

## 注意

- **カメラロールは WebM を受け付けません。** 書き出し形式は MP4 を選んでください
  （iOS アプリ版では既定で MP4 になります）。
- 書き出しは実時間です。60 秒の動画なら約 60 秒かかります。
- `Resources/web` は Web 版のビルド生成物です。ふつうビルド生成物はコミットしませんが、
  iPad には npm が無く、そのまま開いて動かせることを優先してリポジトリに含めています。
  作り直すときはリポジトリのルートで `npm run bundle` を実行してください。
