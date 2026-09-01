import Foundation
import Photos
import SwiftUI

/// 書き出した動画を受け取って端末に保存する。
///
/// WKWebView からは一度に全部渡さず、分割して受け取ってそのままファイルへ書き足していく。
/// 数十 MB の動画を base64 の文字列として丸ごとメモリに載せると、端末によっては落ちるため。
@MainActor
final class VideoSaver: ObservableObject {
    @Published var status: String?
    @Published var shareURL: URL?
    @Published var isSharing = false

    private var handle: FileHandle?
    private var destination: URL?
    private var receivedBytes = 0

    /// 保存の結果を Web 側へ返すためのコールバック（EditorWebView が差し込む）。
    var reportResult: ((Bool, String) -> Void)?

    func begin(filename: String) {
        closeHandle()
        let safeName = filename.isEmpty ? "movie.mp4" : filename
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        try? FileManager.default.removeItem(at: url)

        guard FileManager.default.createFile(atPath: url.path, contents: nil),
              let opened = try? FileHandle(forWritingTo: url) else {
            failed("保存先を用意できませんでした")
            return
        }
        handle = opened
        destination = url
        receivedBytes = 0
        show("保存の準備中…")
    }

    func append(base64: String) {
        guard let handle, let data = Data(base64Encoded: base64) else { return }
        do {
            try handle.write(contentsOf: data)
            receivedBytes += data.count
            show("受け取り中… \(byteText(receivedBytes))")
        } catch {
            failed("書き込みに失敗しました")
        }
    }

    func finish() {
        guard handle != nil, let target = destination else {
            failed("保存するデータがありません")
            return
        }
        closeHandle()

        guard receivedBytes > 0 else {
            failed("書き出したデータが空でした")
            return
        }

        show("カメラロールに保存中…")
        Task { await self.saveToPhotos(target) }
    }

    func abort(message: String) {
        failed(message)
    }

    // MARK: - 保存

    private func saveToPhotos(_ url: URL) async {
        let access = await Self.requestAddOnlyAccess()
        guard access == .authorized || access == .limited else {
            // 写真への追加を断られたときは、共有シートから「ファイル」などに保存できるようにする。
            offerShareSheet(url, message: "写真への保存が許可されていません。保存先を選んでください")
            return
        }

        do {
            try await Self.addVideoToPhotoLibrary(url)
            destination = nil
            show("カメラロールに保存しました")
            reportResult?(true, "saved")
        } catch {
            offerShareSheet(url, message: "カメラロールに保存できませんでした。保存先を選んでください")
        }
    }

    private func offerShareSheet(_ url: URL, message: String) {
        shareURL = url
        isSharing = true
        show(message)
        // 共有シートを出した時点で、Web 側の「保存できた」表示は出さない。
        reportResult?(false, "needs_manual_save")
    }

    private static func requestAddOnlyAccess() async -> PHAuthorizationStatus {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if current != .notDetermined { return current }
        return await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                continuation.resume(returning: status)
            }
        }
    }

    private static func addVideoToPhotoLibrary(_ url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
            } completionHandler: { success, error in
                if success {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: error ?? SaveError.photoLibraryRejected)
                }
            }
        }
    }

    // MARK: - 小物

    private enum SaveError: Error {
        case photoLibraryRejected
    }

    private func failed(_ message: String) {
        closeHandle()
        show(message)
        reportResult?(false, message)
    }

    private func closeHandle() {
        try? handle?.close()
        handle = nil
    }

    private func show(_ message: String) {
        status = message
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if self.status == message { self.status = nil }
        }
    }

    private func byteText(_ bytes: Int) -> String {
        let mb = Double(bytes) / 1_048_576
        return mb < 1 ? "\(bytes / 1024) KB" : String(format: "%.1f MB", mb)
    }
}
