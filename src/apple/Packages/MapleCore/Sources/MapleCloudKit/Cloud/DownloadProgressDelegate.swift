// DownloadProgressDelegate.swift — URLSession download delegate that
// forwards byte-level progress for the cloud RAW fetch (#822).
//
// `CloudSource.rawBytesWithProgress` uses `URLSession.download(for:)` (the
// non-buffered transport) and needs `urlSession(_:downloadTask:didWriteData:
// totalBytesWritten:totalBytesExpectedToWrite:)` callbacks to know how many
// bytes have landed. That delegate method is only delivered to a session's
// delegate, so this small class bridges those callbacks to the caller's
// `onProgress` closure.
//
// `totalBytesExpectedToWrite` is `NSURLSessionTransferSizeUnknown` (`-1`)
// when the server sends no `Content-Length`; in that case we fall back to
// the catalog size the caller seeded (`fallbackTotal`) so the bar can still
// be determinate. The closure runs on the delegate queue (a background
// `OperationQueue`); the caller hops to its own actor and throttles.

import Foundation

public final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let fallbackTotal: Int64?
    private let onProgress: @Sendable (_ received: Int64, _ total: Int64?) -> Void

    public init(fallbackTotal: Int64?,
         onProgress: @escaping @Sendable (_ received: Int64, _ total: Int64?) -> Void) {
        self.fallbackTotal = fallbackTotal
        self.onProgress = onProgress
    }

    public func urlSession(_ session: URLSession,
                    downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        // `NSURLSessionTransferSizeUnknown` is `-1` — the server didn't send
        // a Content-Length. Fall back to the caller's seeded total so the
        // bar stays determinate; nil only if neither is known.
        let total: Int64? = totalBytesExpectedToWrite > 0
            ? totalBytesExpectedToWrite
            : fallbackTotal
        onProgress(totalBytesWritten, total)
    }

    // Required by the protocol. The downloaded file is consumed by the
    // `download(for:)` async API's returned URL, so there's nothing to do
    // here — but the method must exist for the delegate to be valid.
    public func urlSession(_ session: URLSession,
                    downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        // No-op: the async `session.download(for:)` API handles relocating the
        // temp file and hands it back through the async return value.
    }
}
