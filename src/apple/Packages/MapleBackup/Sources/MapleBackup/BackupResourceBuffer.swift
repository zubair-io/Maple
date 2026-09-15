import Foundation

/// Scratch storage for a streamed Photos resource. The caller serializes
/// append/finish/cancel. Mapping the completed local file avoids accumulating
/// several whole videos in heap memory while uploads run concurrently.
public final class BackupResourceBuffer {
  private let url: URL
  private var handle: FileHandle?

  public convenience init() throws {
    try self.init(directory: FileManager.default.temporaryDirectory)
  }

  init(directory: URL) throws {
    url = directory.appendingPathComponent("maple-backup-\(UUID().uuidString).resource")
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw CocoaError(.fileWriteUnknown)
    }
    do {
      handle = try FileHandle(forWritingTo: url)
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw error
    }
  }

  public func append(_ data: Data) throws {
    guard let handle else { throw CocoaError(.fileWriteUnknown) }
    try handle.write(contentsOf: data)
  }

  public func finish() throws -> Data {
    guard let handle else { throw CocoaError(.fileReadUnknown) }
    defer { cancel() }
    try handle.close()
    self.handle = nil
    // The mapping retains the file's contents after unlink. Only our scratch
    // directory entry is removed; PhotoKit originals are never written.
    return try Data(contentsOf: url, options: .alwaysMapped)
  }

  public func cancel() {
    try? handle?.close()
    handle = nil
    try? FileManager.default.removeItem(at: url)
  }

  deinit { cancel() }
}
