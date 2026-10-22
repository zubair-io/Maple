import Darwin
import Foundation

/// Atomic sidecar publication shared by every local XMP writer. A durable
/// publish fully synchronizes the staged bytes before rename, then synchronizes
/// the parent directory and flushes the drive again after publication. Volumes
/// without F_FULLFSYNC support fail confirmation rather than silently weakening
/// the guarantee; unsupported directory fsync remains a volume limitation.
enum XMPSidecarFilePublication {
  typealias ReplaceDestination = (_ destination: URL, _ staged: URL) throws -> Void

  static func publish(_ xml: String, at destination: URL, durable: Bool) throws {
    try publish(xml, at: destination, durable: durable, replacing: replaceDestination)
  }

  static func publish(
    _ xml: String, at destination: URL, durable: Bool, replacing replace: ReplaceDestination
  ) throws {
    guard let data = xml.data(using: .utf8) else {
      throw XMPStoreError.encodingError
    }
    let stagedURL = stagingURL(for: destination)
    try data.write(to: stagedURL, options: .atomic)
    do {
      if durable { try synchronizeFile(stagedURL) }
      try replace(destination, stagedURL)
    } catch {
      try? FileManager.default.removeItem(at: stagedURL)
      throw error
    }
    if durable {
      try synchronizeDirectory(destination.deletingLastPathComponent())
      try synchronizeFile(destination)
    }
  }

  /// A sidecar already holding the expected bytes may still be undurable
  /// (restored, copied, or published without fsync). Reconfirm it in place.
  /// Also confirms idempotent workflow publications before acknowledging them.
  static func confirmExisting(_ xml: String, at destination: URL) throws {
    let handle = try FileHandle(forReadingFrom: destination)
    defer { try? handle.close() }
    let published = try handle.readToEnd() ?? Data()
    guard published == Data(xml.utf8) else {
      throw XMPStoreError.publishedContentMismatch(destination)
    }
    try synchronize(descriptor: handle.fileDescriptor)
    try synchronizeDirectory(destination.deletingLastPathComponent())
    try synchronize(descriptor: handle.fileDescriptor)
  }

  static func stagingURL(for destination: URL) -> URL {
    destination.deletingLastPathComponent()
      .appendingPathComponent(".\(destination.lastPathComponent).tmp")
  }

  private static func replaceDestination(_ destination: URL, with staged: URL) throws {
    if FileManager.default.fileExists(atPath: destination.path) {
      _ = try FileManager.default.replaceItemAt(destination, withItemAt: staged)
    } else {
      try FileManager.default.moveItem(at: staged, to: destination)
    }
  }

  private static func synchronizeFile(_ url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try synchronize(descriptor: handle.fileDescriptor)
  }

  /// Runs after the rename has already published the sidecar, so a volume
  /// that cannot fsync a directory (network mounts, FAT cards) must not turn a
  /// landed save into a reported failure.
  private static func synchronizeDirectory(_ directory: URL) throws {
    let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { throw posixError() }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 || errno == ENOTSUP || errno == EINVAL else {
      throw posixError()
    }
  }

  private static func synchronize(descriptor: Int32) throws {
    // No fsync-only fallback: unsupported media cannot acknowledge a strict save.
    guard fcntl(descriptor, F_FULLFSYNC) == 0 else { throw posixError() }
  }

  private static func posixError() -> POSIXError {
    POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }
}
