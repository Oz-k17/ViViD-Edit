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
        // 表示プロセスが OS に終了させられたときに、自動で立て直すため（Coordinator を参照）。
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        // makeUIView は main actor なので、ここで結果の返し先をつないでおく。
        saver.reportResult = { [weak coordinator = context.coordinator] ok, detail in
            coordinator?.report(ok: ok, detail: detail)
        }

        if !Coordinator.loadEditor(in: webView) {
            webView.loadHTMLString(Coordinator.missingBundleHTML, baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.bridgeName)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        static let bridgeName = "vividEdit"
        static let missingBundleHTML = """
            <html><body style="background:#15161a;color:#e7e5df;font-family:-apple-system;padding:24px">
            <h3>エディタ本体が見つかりません</h3>
            <p>Resources/web に Web 版のビルド結果が入っているか確認してください。</p>
            </body></html>
            """

        private let saver: VideoSaver
        weak var webView: WKWebView?
        /// 表示プロセスが終了させられ、立て直している最中か。読み込みが終わったら Web 側へ知らせる。
        private var recovering = false

        /// 同梱した Web 版を読み込む。見つからなければ false。
        @discardableResult
        static func loadEditor(in webView: WKWebView) -> Bool {
            guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") else {
                return false
            }
            webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
            return true
        }

        init(saver: VideoSaver) {
            self.saver = saver
            super.init()
        }

        // MARK: - 表示プロセスの立て直し

        /// iPad は、メモリが足りなくなると WKWebView の表示プロセスだけを終了させる。
        /// 何もしないと画面が真っ白のまま戻らず、アプリを入れ直すまで動かない。
        /// 同じ画面を読み込み直す。編集内容は Web 側が自動保存しているので、そこから復元される。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            recovering = true
            if !Coordinator.loadEditor(in: webView) {
                webView.loadHTMLString(Coordinator.missingBundleHTML, baseURL: nil)
            }
        }

        /// 立て直しが済んだら、Web 側に「いま再読み込みした」ことを知らせる（画面に出すため）。
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard recovering else { return }
            recovering = false
            let js = "window.__vividRecovered = true; window.dispatchEvent(new Event('vivid-recovered'));"
            webView.evaluateJavaScript(js, completionHandler: nil)
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
            let js = "window.__vividEditSaveDone && window.__vividEditSaveDone(\(ok), \"\(escaped)\");"
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
