import Foundation

/// Bounded random access to one file for Live Photo metadata reads. The head
/// is fetched once, so a JPEG segment walk or an ISO-BMFF header walk over
/// SMB costs one round trip until it leaves the head. Reads past the head are
/// charged against a byte budget, so a hostile length field can never make a
/// metadata read pull the whole file.
actor LiveByteSource {
  static let headBytes = 64 * 1024
  static let readBudgetBytes = 8 * 1024 * 1024

  nonisolated let size: UInt64
  private let head: [UInt8]
  private let fetch: LiveContentIdentifier.Fetch
  private var remainingBudget = LiveByteSource.readBudgetBytes

  private init(size: UInt64, head: [UInt8], fetch: @escaping LiveContentIdentifier.Fetch) {
    self.size = size
    self.head = head
    self.fetch = fetch
  }

  static func open(size: UInt64, fetch: @escaping LiveContentIdentifier.Fetch) async
    -> LiveByteSource?
  {
    let headLength = Int(min(size, UInt64(headBytes)))
    guard headLength > 0, let head = try? await fetch(0, headLength), head.count == headLength
    else { return nil }
    return LiveByteSource(size: size, head: [UInt8](head), fetch: fetch)
  }

  /// `length` bytes at `offset`, or nil when the range leaves the file, exceeds the read budget,
  /// or a read comes back short.
  func read(_ offset: UInt64, _ length: Int) async -> [UInt8]? {
    guard length >= 0, offset <= size, UInt64(length) <= size - offset else { return nil }
    let end = offset + UInt64(length)
    if end <= UInt64(head.count) { return Array(head[Int(offset)..<Int(end)]) }
    guard length <= remainingBudget else { return nil }
    remainingBudget -= length
    guard let bytes = try? await fetch(offset, length), bytes.count == length else { return nil }
    return [UInt8](bytes)
  }
}

/// Bounds-checked integer and text reads over a buffered region.
enum LiveBinary {
  static func uint(_ bytes: [UInt8], _ offset: Int, _ width: Int, littleEndian: Bool = false)
    -> UInt64?
  {
    guard offset >= 0, (0...8).contains(width), offset <= bytes.count - width else { return nil }
    let field = bytes[offset..<offset + width]
    let ordered = littleEndian ? Array(field.reversed()) : Array(field)
    return ordered.reduce(0) { $0 << 8 | UInt64($1) }
  }

  static func int(_ bytes: [UInt8], _ offset: Int, _ width: Int, littleEndian: Bool = false)
    -> Int?
  {
    uint(bytes, offset, width, littleEndian: littleEndian).flatMap { Int(exactly: $0) }
  }

  static func latin1(_ bytes: [UInt8], _ start: Int, _ end: Int) -> String? {
    guard start >= 0, start <= end, end <= bytes.count else { return nil }
    return String(bytes: bytes[start..<end], encoding: .isoLatin1)
  }
}
