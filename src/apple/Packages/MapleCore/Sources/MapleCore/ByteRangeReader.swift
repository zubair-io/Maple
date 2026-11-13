// ByteRangeReader.swift — random access over one file's bytes, whatever
// holds them: a local file, an SMB share, or an in-memory buffer. The
// maple_id capture-date readers (`VideoCaptureDate`, #5079) walk container
// structure by ranged reads, so a clip whose `moov` atom follows a multi-GB
// `mdat` costs a handful of small reads on any transport.

import Foundation

public struct ByteRangeReader {
  /// Total file length in bytes.
  public let size: UInt64
  private let readRange: (_ offset: UInt64, _ length: Int) async throws -> Data

  /// `read` returns the bytes at `offset`, fewer than `length` only at the
  /// end of the file; it is never asked to read past `size`.
  public init(size: UInt64, read: @escaping (_ offset: UInt64, _ length: Int) async throws -> Data)
  {
    self.size = size
    self.readRange = read
  }

  /// Up to `length` bytes at `offset`, clamped to the end of the file.
  public func read(offset: UInt64, length: Int) async throws -> Data {
    guard offset < size, length > 0 else { return Data() }
    return try await readRange(offset, Int(min(UInt64(length), size - offset)))
  }

  public static func data(_ bytes: Data) -> ByteRangeReader {
    ByteRangeReader(size: UInt64(bytes.count)) { offset, length in
      let start = bytes.startIndex + Int(offset)
      return Data(bytes[start..<start + length])
    }
  }

  /// Runs `body` with a reader over the file at `url`; the handle closes
  /// when `body` returns.
  public static func withFile<T>(
    at url: URL, _ body: (ByteRangeReader) async throws -> T
  ) async throws -> T {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let reader = ByteRangeReader(size: try handle.seekToEnd()) { offset, length in
      try handle.seek(toOffset: offset)
      return try handle.read(upToCount: length) ?? Data()
    }
    return try await body(reader)
  }
}
