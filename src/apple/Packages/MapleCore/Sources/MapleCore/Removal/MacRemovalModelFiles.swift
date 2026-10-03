#if os(macOS)
  import Darwin
  import Foundation

  /// Bounded file copies for the offline model installer and its document snapshot.
  enum MacRemovalModelFiles {
    static func copy(from source: URL, to target: URL, limit: UInt64?) throws {
      // Nonblocking open lets us reject a FIFO/device before any read can wait
      // for a writer. Model symlinks still resolve to regular pinned bytes.
      let descriptor = Darwin.open(source.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
      guard descriptor >= 0 else {
        throw NSError(
          domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: source.path])
      }
      let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
      defer { try? input.close() }
      var attributes = stat()
      guard fstat(input.fileDescriptor, &attributes) == 0,
        (attributes.st_mode & S_IFMT) == S_IFREG
      else { throw RemovalError.invalid("\(source.lastPathComponent): choose a regular file") }
      guard FileManager.default.createFile(atPath: target.path, contents: nil) else {
        throw RemovalError.invalid("Could not stage \(target.lastPathComponent)")
      }
      let output = try FileHandle(forWritingTo: target)
      defer { try? output.close() }
      var copied: UInt64 = 0
      while let bytes = try input.read(upToCount: 1 << 20), !bytes.isEmpty {
        try Task.checkCancellation()
        copied += UInt64(bytes.count)
        if let limit, copied > limit {
          throw RemovalError.invalid("\(source.lastPathComponent): file exceeds its size limit")
        }
        try output.write(contentsOf: bytes)
      }
      try output.synchronize()
    }

    static func type(at url: URL) throws -> FileAttributeType? {
      try FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType
    }
  }
#endif
