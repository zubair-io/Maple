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
      try synchronizeDirectory(destination.deletingLastPathComponent())
    }
  }

  /// A matching workflow UUID can identify a lost acknowledgement, but it
  /// cannot prove a restored sidecar's durability. Reconfirm its exact inode
  /// and parent before adopting the already-published checkpoint (#3940).
  static func confirmExisting(_ xml: String, at destination: URL) throws {
    let handle = try FileHandle(forReadingFrom: destination)
    defer { try? handle.close() }
    guard try handle.readToEnd() == Data(xml.utf8) else { throw RemovalError.saveConflict }
    guard fsync(handle.fileDescriptor) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    try synchronizeDirectory(destination.deletingLastPathComponent())
  }

  private static func synchronizeDirectory(_ directory: URL) throws {
    let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }
}
