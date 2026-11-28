import Foundation

extension SMBSource {
  /// AMSMB2 streams through an OutputStream in bounded chunks. The caller
  /// supplies an owned staging path, so an incomplete transfer cannot
  /// replace an existing file at the user's drop destination.
  public func writeOriginal(
    for ref: ImageRef, to destination: URL,
    onProgress: @escaping AssetRef.OriginalFileProgress = { _, _ in }
  ) async throws {
    guard let client else { throw SMBError.notConnected }
    try Task.checkCancellation()
    let abort = TransferAbort()
    let path = try listedPath(for: ref)
    try await withTaskCancellationHandler {
      // AMSMB2 calls the handler on its own queue, where no Swift task is current, so
      // cancellation reaches it through `abort`; returning false stops the transfer.
      try await client.downloadItem(
        atPath: path, to: destination,
        progress: { received, total in
          onProgress(received, total > 0 ? total : nil)
          return !abort.isRequested
        })
    } onCancel: {
      abort.request()
    }
    try Task.checkCancellation()
  }
}

private final class TransferAbort: @unchecked Sendable {
  private let lock = NSLock()
  private var requested = false

  var isRequested: Bool { lock.withLock { requested } }
  func request() { lock.withLock { requested = true } }
}
