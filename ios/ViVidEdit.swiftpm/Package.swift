// swift-tools-version: 5.9

// Swift Playgrounds 用のアプリパッケージ。
// エディタ本体は Web 版をそのまま同梱し、WKWebView で表示する。
// ネイティブ側が受け持つのは「書き出した動画を端末に保存する」ところだけ。
// （ブラウザのサンドボックスではここが塞がれていて、iPhone に動画を残せないため）

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "ViVidEdit",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "ViViD Edit",
            targets: ["AppModule"],
            bundleIdentifier: "app.vivid.edit",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            accentColor: .presetColor(.green),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            // iPadOS は 4 方向すべてに対応していないと「フルスクリーンに対応していない」と扱う
            // （Split View などマルチタスクの要件）。1 つでも欠けると起動時に警告が出る。
            supportedInterfaceOrientations: [
                .portrait,
                .portraitUpsideDown,
                .landscapeRight,
                .landscapeLeft
            ],
            capabilities: [
                .photoLibraryAdd(purposeString: "書き出した動画をカメラロールに保存します。")
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: ".",
            exclude: ["README.md"],
            resources: [
                // web/ はディレクトリ構造を保ったまま入れたいので process ではなく copy。
                .copy("Resources/web")
            ]
        )
    ]
)
