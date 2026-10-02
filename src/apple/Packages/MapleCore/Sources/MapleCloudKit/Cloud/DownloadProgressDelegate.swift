import Foundation

/// One delegate-backed original download (#4004). The async convenience
/// download API does not forward download-progress callbacks. This bridge
/// starts a download task, preserves its finished temp file synchronously,
/// and resumes exactly once. Mutable state is protected by `lock`; callbacks
/// run on URLSession's queue and cancellation may arrive on another executor.
public final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate,
  @unchecked Sendable
{
  private let fallbackTotal: Int64?
  private let onProgress: @Sendable (Int64, Int64?) -> Void
  private let lock = NSLock()
  private var continuation: CheckedContinuation<(URL, URLResponse), Error>?
  private var session: URLSession?
  private var downloaded: (URL, URLResponse)?
  private var cancelled = false

  public init(fallbackTotal: Int64?, onProgress: @escaping @Sendable (Int64, Int64?) -> Void) {
    self.fallbackTotal = fallbackTotal
    self.onProgress = onProgress
  }

  /// Create a fresh delegate for each authenticated attempt. The caller owns
  /// the returned temporary file and removes it after consuming its bytes.
  public func download(for request: URLRequest) async throws -> (URL, URLResponse) {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task = lock.withLock { () -> URLSessionDownloadTask? in
          guard !cancelled && !Task.isCancelled else {
            continuation.resume(throwing: CancellationError())
            return nil
          }
          self.continuation = continuation
          let configuration = URLSessionConfiguration.ephemeral
          configuration.urlCache = nil
          configuration.httpCookieStorage = nil
          configuration.urlCredentialStorage = nil
          let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
          let task = session.downloadTask(with: request)
          self.session = session
          return task
        }
        task?.resume()
      }
    } onCancel: {
      self.lock.withLock { self.cancelled = true }
      self.finish(.failure(CancellationError()))
    }
  }

  private func finish(_ result: Result<(URL, URLResponse), Error>) {
    let state = lock.withLock {
      () -> (CheckedContinuation<(URL, URLResponse), Error>?, URLSession?, URL?) in
      let snapshot = (continuation, session, downloaded?.0)
      continuation = nil
      session = nil
      downloaded = nil
      return snapshot
    }
    guard let continuation = state.0 else { return }
    switch result {
    case .success(let value):
      state.1?.finishTasksAndInvalidate()
      continuation.resume(returning: value)
    case .failure(let error):
      state.1?.invalidateAndCancel()
      if let temporary = state.2 { try? FileManager.default.removeItem(at: temporary) }
      continuation.resume(throwing: error)
    }
  }

  public func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard lock.withLock({ continuation != nil && !cancelled }) else { return }
    let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : fallbackTotal
    onProgress(totalBytesWritten, total)
  }

  public func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-cloud-original-\(UUID().uuidString)")
    do {
      guard let response = downloadTask.response else { throw URLError(.badServerResponse) }
      // URLSession removes `location` as soon as this callback returns.
      try FileManager.default.moveItem(at: location, to: destination)
      let retained = lock.withLock { () -> Bool in
        guard continuation != nil else { return false }
        downloaded = (destination, response)
        return true
      }
      if !retained { try? FileManager.default.removeItem(at: destination) }
    } catch { finish(.failure(error)) }
  }

  public func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
  ) {
    if let error {
      finish(.failure(error))
      return
    }
    let result = lock.withLock { downloaded }
    guard let result else {
      finish(.failure(URLError(.badServerResponse)))
      return
    }
    finish(.success(result))
  }
}
