import Foundation

/// The content identifier of a QuickTime clip: the `com.apple.quicktime.content.identifier` entry
/// of the `mdta` key table in `moov/meta` (or a top-level `meta`). Reads top-level box headers
/// and the metadata containers (at most 1 MB each), never the media data.
enum LiveQuickTime {
  private static let identifierKey = "com.apple.quicktime.content.identifier"
  private static let maxTopLevelBoxes = 32
  private static let maxContainerBytes = 1024 * 1024
  private static let maxKeys = 256
  private static let utf8DataType: UInt64 = 1

  static func contentIdentifier(_ source: LiveByteSource) async -> String? {
    await metaPayloads(source).lazy.compactMap(identifier(inMeta:)).first
  }

  /// The `meta` payloads of the file, in order; a top-level one is read whole, a `moov` one by child.
  private static func metaPayloads(_ source: LiveByteSource) async -> [[UInt8]] {
    var found: [[UInt8]] = []
    var offset: UInt64 = 0
    for _ in 0..<maxTopLevelBoxes {
      guard let box = await LiveIsoBoxes.header(source, at: offset) else { break }
      let size = box.size == 0 ? source.size - offset : box.size
      guard size >= box.headerSize, size <= source.size - offset else { break }
      if box.type == "moov" || box.type == "meta", size <= UInt64(maxContainerBytes),
        let whole = await source.read(offset, Int(size))
      {
        if box.type == "meta" {
          found.append(Array(whole[Int(box.headerSize)...]))
        } else {
          found += LiveIsoBoxes.children(whole, Int(box.headerSize), whole.count)
            .filter { $0.type == "meta" }
            .map { Array(whole[$0.start..<$0.end]) }
        }
      }
      offset += size
    }
    return found
  }

  /// A QuickTime `meta` box is written without the ISO full-box version and flags that
  /// precede its first child.
  private static func identifier(inMeta payload: [UInt8]) -> String? {
    let firstChild = LiveBinary.latin1(payload, 4, 8) == "hdlr" ? 0 : 4
    let children = LiveIsoBoxes.children(payload, firstChild, payload.count)
    guard let keys = children.first(where: { $0.type == "keys" }),
      let ilst = children.first(where: { $0.type == "ilst" }),
      let index = identifierIndex(payload, keys)
    else { return nil }
    return utf8Value(payload, ilst, index)
  }

  /// The 1-based index of the content-identifier key in the `mdta` key table.
  private static func identifierIndex(_ meta: [UInt8], _ keys: LiveBox) -> Int? {
    guard let count = LiveBinary.int(meta, keys.start + 4, 4), count > 0 else { return nil }
    var offset = keys.start + 8
    for index in 1...min(count, maxKeys) {
      guard let size = LiveBinary.int(meta, offset, 4), size >= 8, offset + size <= keys.end
      else { return nil }
      if LiveBinary.latin1(meta, offset + 4, offset + 8) == "mdta",
        String(bytes: meta[(offset + 8)..<(offset + size)], encoding: .utf8) == identifierKey
      {
        return index
      }
      offset += size
    }
    return nil
  }

  /// The item-list entry for key `index`: its type is that index as a big-endian integer.
  private static func utf8Value(_ meta: [UInt8], _ ilst: LiveBox, _ index: Int) -> String? {
    guard
      let item = LiveIsoBoxes.children(meta, ilst.start, ilst.end).first(where: {
        Int($0.code) == index
      }),
      let data = LiveIsoBoxes.children(meta, item.start, item.end).first(where: {
        $0.type == "data"
      }),
      data.end - data.start > 8, LiveBinary.uint(meta, data.start, 4) == utf8DataType
    else { return nil }
    return String(bytes: meta[(data.start + 8)..<data.end], encoding: .utf8)
  }
}
