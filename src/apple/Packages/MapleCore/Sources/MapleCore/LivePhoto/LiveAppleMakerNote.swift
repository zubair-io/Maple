import Foundation

/// Apple's content identifier (MakerNote tag `0x0011`) from a TIFF-structured Exif block. The
/// MakerNote is `Apple iOS\0`, a two-byte version, its own byte order mark, then an IFD whose
/// value offsets count from the MakerNote's start.
enum LiveAppleMakerNote {
  private static let exifIfdPointer = 0x8769
  private static let makerNoteTag = 0x927c
  private static let contentIdentifierTag = 0x0011
  private static let appleHeader: [UInt8] = Array("Apple iOS\0".utf8)
  private static let appleIfdOffset = 14
  private static let asciiType = 2
  private static let maxIfdEntries = 512
  private static let entryBytes = 12
  private static let typeBytes: [Int: Int] = [1: 1, 2: 1, 3: 2, 4: 4, 7: 1]

  private struct Reader {
    let bytes: [UInt8]
    let littleEndian: Bool

    func u16(_ offset: Int) -> Int? {
      LiveBinary.int(bytes, offset, 2, littleEndian: littleEndian)
    }

    func u32(_ offset: Int) -> Int? {
      LiveBinary.int(bytes, offset, 4, littleEndian: littleEndian)
    }

    init?(_ bytes: [UInt8], orderAt offset: Int) {
      guard let order = LiveBinary.latin1(bytes, offset, offset + 2),
        order == "II" || order == "MM"
      else { return nil }
      self.bytes = bytes
      littleEndian = order == "II"
    }
  }

  private struct Entry {
    let type: Int
    let count: Int
    let valueField: Int
  }

  static func contentIdentifier(_ tiff: [UInt8]) -> String? {
    guard let note = makerNote(of: tiff), note.starts(with: appleHeader),
      let reader = Reader(note, orderAt: 12),
      let entry = findEntry(reader, appleIfdOffset, contentIdentifierTag), entry.type == asciiType,
      let value = value(reader, entry)
    else { return nil }
    let text = value.prefix { $0 != 0 }
    return String(bytes: text, encoding: .isoLatin1)
  }

  private static func makerNote(of tiff: [UInt8]) -> [UInt8]? {
    guard tiff.count >= 8, let reader = Reader(tiff, orderAt: 0), reader.u16(2) == 42,
      let firstIfd = reader.u32(4),
      let pointer = findEntry(reader, firstIfd, exifIfdPointer),
      let exifIfd = reader.u32(pointer.valueField), exifIfd != 0,
      let note = findEntry(reader, exifIfd, makerNoteTag)
    else { return nil }
    return value(reader, note)
  }

  private static func findEntry(_ reader: Reader, _ ifdOffset: Int, _ tag: Int) -> Entry? {
    guard let count = reader.u16(ifdOffset) else { return nil }
    for index in 0..<min(count, maxIfdEntries) {
      let at = ifdOffset + 2 + index * entryBytes
      guard at + entryBytes <= reader.bytes.count else { return nil }
      guard reader.u16(at) == tag else { continue }
      guard let type = reader.u16(at + 2), let valueCount = reader.u32(at + 4) else { return nil }
      return Entry(type: type, count: valueCount, valueField: at + 8)
    }
    return nil
  }

  /// The value bytes of an entry: inline in its 4-byte field when they fit, else at the offset it holds.
  private static func value(_ reader: Reader, _ entry: Entry) -> [UInt8]? {
    guard let width = typeBytes[entry.type] else { return nil }
    let (length, overflow) = width.multipliedReportingOverflow(by: entry.count)
    guard !overflow else { return nil }
    if length <= 4 {
      guard entry.valueField + length <= reader.bytes.count else { return nil }
      return Array(reader.bytes[entry.valueField..<entry.valueField + length])
    }
    guard let offset = reader.u32(entry.valueField), offset + length <= reader.bytes.count
    else { return nil }
    return Array(reader.bytes[offset..<offset + length])
  }
}
