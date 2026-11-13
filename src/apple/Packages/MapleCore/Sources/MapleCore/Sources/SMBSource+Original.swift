import Foundation

extension SMBSource {
  /// AMSMB2 streams through an OutputStream in bounded chunks. The caller
  /// supplies an owned staging path, so an incomplete transfer cannot
  /// replace an existing file at the user's drop destination.
  public func writeOriginal(for ref: ImageRef, to destination: URL) async throws {
    guard let client else { throw SMBError.notConnected }
    try Task.checkCancellation()
    try await client.downloadItem(atPath: listedPath(for: ref), to: destination, progress: nil)
    try Task.checkCancellation()
  }
}
