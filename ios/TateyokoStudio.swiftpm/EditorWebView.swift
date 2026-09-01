import SwiftUI
import WebKit

/// 同梱した Web 版エディタを表示し、保存要求だけネイティブ側で受け取る。
struct EditorWebView: UIViewRepresentable {
    let saver: VideoSaver

    func makeCoordinator() -> Coordinator {
        Coordinator(saver: saver)
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: Coordinator.bridgeName)

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        // 動画を全画面に奪われず、タップなしで再生できるようにする（プレビュー再生に必要）。
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        // エディタ自身がレイアウトを持っているので、ページ全体のスクロールは殺す。
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        context.coordinator.webView = webView

        // makeUIView は main actor なので、ここで結果の返し先をつないでおく。
        saver.reportResult = { [weak coordinator = context.coordinator] ok, detail in
            coordinator?.report(ok: ok, detail: detail)
        }

        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") else {
            webView.loadHTMLString(Coordinator.missingBundleHTML, baseURL: nil)
            return webView
        }
        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.bridgeName)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        static let bridgeName = "tateyoko"
        static let missingBundleHTML = """
            <html><body style="background:#15161a;color:#e7e5df;font-family:-apple-system;padding:24px">
            <h3>エディタ本体が見つかりません</h3>
            <p>Resources/web に Web 版のビルド結果が入っているか確認してください。</p>
            </body></html>
            """

        private let saver: VideoSaver
        weak var webView: WKWebView?

        init(saver: VideoSaver) {
            self.saver = saver
            super.init()
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            let filename = body["filename"] as? String ?? "movie.mp4"
            let chunk = body["data"] as? String
            let reason = body["message"] as? String ?? "保存を中止しました"
            let saver = self.saver

            // WKScriptMessageHandler は main で呼ばれるが、
            // VideoSaver が MainActor 隔離なのでコンパイラに分かる形で渡す。
            Task { @MainActor in
                switch type {
                case "begin": saver.begin(filename: filename)
                case "chunk": if let chunk { saver.append(base64: chunk) }
                case "end": saver.finish()
                case "abort": saver.abort(message: reason)
                default: break
                }
            }
        }

        /// 保存結果を Web 側の待ち受け関数へ返す。
        func report(ok: Bool, detail: String) {
            let escaped = detail
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            let js = "window.__tateyokoSaveDone && window.__tateyokoSaveDone(\(ok), \"\(escaped)\");"
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
