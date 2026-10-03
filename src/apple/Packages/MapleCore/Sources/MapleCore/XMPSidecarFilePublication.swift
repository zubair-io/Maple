// Atomic XML publication and removal durability, shared by bound variant writers (#3984).
import Darwin
import Foundation

enum XMPSidecarFilePublication {
  static func publish(_ xml: String, at destination: URL, durable: Bool) throws {
    guard let data = xml.data(using: .utf8) else {
      throw XMPStoreError.encodingError
    }
    let tmpURL = destination.deletingLastPathComponent()
      .appendingPathComponent(".\(destination.lastPathComponent).tmp")
    try data.write(to: tmpURL, options: .atomic)
    if durable {
      let handle = try FileHandle(forWritingTo: tmpURL)
      defer { try? handle.close() }
      try handle.synchronize()
    }
    // Atomic rename
    if FileManager.default.fileExists(atPath: destination.path) {
      _ = try FileManager.default.replaceItemAt(destination, withItemAt: tmpURL)
    } else {
      try FileManager.default.moveItem(at: tmpURL, to: destination)
    }
    if durable {
      let directoryFD = open(destination.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY)
      guard directoryFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
      defer { close(directoryFD) }
      guard fsync(directoryFD) == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
    }
  }
}
