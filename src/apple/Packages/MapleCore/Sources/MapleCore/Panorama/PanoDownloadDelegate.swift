// PanoDownloadDelegate.swift — URLSession download plumbing for PanoProvisioner (#1234 M6).
//
// Bridges a `URLSessionDownloadTask` to async/await with byte-level progress.
// Kept separate from PanoProvisioner so the provisioner reads as pure
// download→verify→install policy.

import Foundation

/// Downloads a single URL to a caller-owned stable path, reporting fractional
/// progress. The finished temp file is moved inside the completion callback
/// (the delegate's temp is deleted once the callback returns).
///
/// `@unchecked Sendable`: the mutable state (`continuation`, `session`) is
/// guarded by `lock`. Delegate callbacks arrive on URLSession's background
/// queue while `run(url:)` sets up from the caller's context, so the lock plus
/// a single-resume latch (`finish`) keeps the continuation resumed exactly once.
final class PanoDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let stableDestination: URL
    private let onFraction: @Sendable (Double) -> Void

    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var session: URLSession?

    init(stableDestination: URL, onFraction: @escaping @Sendable (Double) -> Void) {
        self.stableDestination = stableDestination
        self.onFraction = onFraction
    }

    func run(url: URL) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            lock.lock()
            continuation = c
            let cfg = URLSessionConfiguration.ephemeral
            cfg.waitsForConnectivity = true
            cfg.timeoutIntervalForResource = 600
            let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
            session = s
            lock.unlock()
            // resume() only starts the task after the continuation is stored,
            // so no callback can fire before `continuation` is set.
            s.downloadTask(with: url).resume()
        }
    }

    /// Resume the continuation exactly once (later calls are no-ops).
    private func finish(_ result: Result<Void, Error>) {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        guard let c else { return }
        switch result {
        case .success: c.resume(returning: ())
        case let .failure(error): c.resume(throwing: error)
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
        // Move synchronously: `location` is deleted when this callback returns.
        do {
            if FileManager.default.fileExists(atPath: stableDestination.path) {
                try FileManager.default.removeItem(at: stableDestination)
            }
            try FileManager.default.moveItem(at: location, to: stableDestination)
        } catch {
            finish(.failure(error))
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        session.finishTasksAndInvalidate()
        finish(error.map { .failure($0) } ?? .success(()))
    }
}
