// PanoDownloadDelegate.swift — URLSession download plumbing for PanoProvisioner (#1234 M6).
//
// Bridges a `URLSessionDownloadTask` to async/await with byte-level progress.
// Kept separate from PanoProvisioner so the provisioner reads as pure
// download→verify→install policy.

import Foundation

/// Downloads a single URL to a caller-owned stable path, reporting fractional
/// progress. The finished temp file is moved inside the completion callback
/// (the delegate's temp is deleted once the callback returns).
final class PanoDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let stableDestination: URL
    private let onFraction: @Sendable (Double) -> Void
    private var continuation: CheckedContinuation<Void, Error>?
    private var session: URLSession?

    init(stableDestination: URL, onFraction: @escaping @Sendable (Double) -> Void) {
        self.stableDestination = stableDestination
        self.onFraction = onFraction
    }

    func run(url: URL) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            self.continuation = c
            let cfg = URLSessionConfiguration.ephemeral
            cfg.waitsForConnectivity = true
            cfg.timeoutIntervalForResource = 600
            let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
            self.session = session
            session.downloadTask(with: url).resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0 else { return }
        onFraction(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        do {
            if FileManager.default.fileExists(atPath: stableDestination.path) {
                try FileManager.default.removeItem(at: stableDestination)
            }
            try FileManager.default.moveItem(at: location, to: stableDestination)
        } catch {
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        session.finishTasksAndInvalidate()
        guard let continuation else { return }
        self.continuation = nil
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume(returning: ())
        }
    }
}
