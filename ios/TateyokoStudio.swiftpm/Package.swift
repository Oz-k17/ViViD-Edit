// swift-tools-version: 5.9

// Swift Playgrounds 用のアプリパッケージ。
// エディタ本体は Web 版をそのまま同梱し、WKWebView で表示する。
// ネイティブ側が受け持つのは「書き出した動画を端末に保存する」ところだけ。
// （ブラウザのサンドボックスではここが塞がれていて、iPhone に動画を残せないため）

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "TateyokoStudio",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "タテヨコ Studio",
            targets: ["AppModule"],
            bundleIdentifier: "studio.tateyoko.editor",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            accentColor: .presetColor(.green),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
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
