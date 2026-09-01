import SwiftUI

@main
struct ViVidEditApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var saver = VideoSaver()

    var body: some View {
        ZStack {
            // Web 版が暗い前提の配色なので、下地も合わせて黒にしておく。
            Color(red: 0.082, green: 0.086, blue: 0.102).ignoresSafeArea()

            EditorWebView(saver: saver)
                .ignoresSafeArea(edges: .bottom)
        }
        .preferredColorScheme(.dark)
        .overlay(alignment: .bottom) {
            if let status = saver.status {
                Text(status)
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 28)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: saver.status)
        .sheet(isPresented: $saver.isSharing) {
            if let url = saver.shareURL {
                ShareSheet(items: [url])
            }
        }
    }
}

/// 「ファイル」アプリなどへ渡すための共有シート。
/// カメラロールへの保存を断られた場合の逃げ道として使う。
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
