import Foundation

/// A box inside a buffered region: its four-character type and payload span (header excluded).
struct LiveBox {
  let type: String
  let code: UInt32
  let start: Int
  let end: Int
}

/// The ISO-BMFF box walk shared by the HEIF and QuickTime identifier readers.
enum LiveIsoBoxes {
  struct Header {
    let type: String
    /// 0 is the open-ended "runs to the end of the file" form.
    let size: UInt64
    let headerSize: UInt64
  }

  static func header(_ source: LiveByteSource, at offset: UInt64) async -> Header? {
    guard offset <= source.size, source.size - offset >= 8,
      let head = await source.read(offset, 8),
      let size = LiveBinary.uint(head, 0, 4),
      let type = LiveBinary.latin1(head, 4, 8)
    else { return nil }
    guard size == 1 else { return Header(type: type, size: size, headerSize: 8) }
    guard source.size - offset >= 16,
      let extended = await source.read(offset + 8, 8),
      let large = LiveBinary.uint(extended, 0, 8)
    else { return nil }
    return Header(type: type, size: large, headerSize: 16)
  }

  /// Child boxes of `bytes[start..<end]`, stopping at the first malformed header.
  /// Uncapped: a tiled HEIC lists hundreds of items, and every box is at least 8 bytes.
  static func children(_ bytes: [UInt8], _ start: Int, _ end: Int) -> [LiveBox] {
    var found: [LiveBox] = []
    var offset = start
    while end - offset >= 8, let size = LiveBinary.uint(bytes, offset, 4),
      let code = LiveBinary.uint(bytes, offset + 4, 4),
      let type = LiveBinary.latin1(bytes, offset + 4, offset + 8)
    {
      let headerSize = size == 1 ? 16 : 8
      let total =
        size == 1
        ? LiveBinary.int(bytes, offset + 8, 8) : size == 0 ? end - offset : Int(exactly: size)
      guard let total, total >= headerSize, total <= end - offset else { break }
      found.append(
        LiveBox(type: type, code: UInt32(code), start: offset + headerSize, end: offset + total))
      offset += total
    }
    return found
  }
}
