import Foundation

/// Structurally faithful Live Photo halves built from the published layouts, mirroring
/// `indexer/live-photo/live-photo.fixtures.ts`: an Exif block whose MakerNote is Apple's
/// (`Apple iOS\0`, IFD at byte 14, value offsets from the MakerNote start) carried in a JPEG APP1
/// segment or a HEIF `Exif` item, and a QuickTime clip whose `mdta` key table names
/// `com.apple.quicktime.content.identifier`. No real camera samples are committed.
enum LivePhotoFixtures {
  enum ByteOrder: String {
    case big = "MM"
    case little = "II"
  }

  static func box(_ type: String, _ payload: [UInt8]...) -> [UInt8] {
    let body = payload.flatMap { $0 }
    return be32(8 + body.count) + Array(type.utf8) + body
  }

  static func fullBox(_ type: String, _ version: UInt8, _ payload: [UInt8]...) -> [UInt8] {
    box(type, [version, 0, 0, 0] + payload.flatMap { $0 })
  }

  static func be32(_ value: Int) -> [UInt8] {
    (0..<4).map { UInt8((value >> (8 * (3 - $0))) & 0xff) }
  }

  static func be16(_ value: Int) -> [UInt8] {
    [UInt8((value >> 8) & 0xff), UInt8(value & 0xff)]
  }

  private static func u16(_ value: Int, _ order: ByteOrder) -> [UInt8] {
    order == .big ? be16(value) : be16(value).reversed()
  }

  private static func u32(_ value: Int, _ order: ByteOrder) -> [UInt8] {
    order == .big ? be32(value) : be32(value).reversed()
  }

  /// Apple's MakerNote: a version entry, then (sorted by tag) the 0x0011 content identifier.
  private static func appleMakerNote(contentID: String?, order: ByteOrder, header: String)
    -> [UInt8]
  {
    let entryCount = contentID == nil ? 1 : 2
    let stringAt = 14 + 2 + entryCount * 12 + 4
    var note = Array(header.utf8)
    note += be16(1)
    note += Array(order.rawValue.utf8)
    note += u16(entryCount, order)
    note += u16(0x0001, order) + u16(9, order) + u32(1, order) + u32(15, order)
    if let contentID {
      note += u16(0x0011, order) + u16(2, order)
      note += u32(contentID.utf8.count + 1, order) + u32(stringAt, order)
    }
    note += u32(0, order)
    if let contentID { note += Array(contentID.utf8) + [0] }
    return note
  }

  /// A TIFF whose IFD0 points at an Exif IFD whose MakerNote is Apple's.
  static func appleTiff(
    contentID: String?, tiffOrder: ByteOrder = .big, noteOrder: ByteOrder = .big,
    makerNoteHeader: String = "Apple iOS\0"
  ) -> [UInt8] {
    let note = appleMakerNote(contentID: contentID, order: noteOrder, header: makerNoteHeader)
    let exifIfdAt = 8 + 2 + 12 + 4
    let noteAt = exifIfdAt + 2 + 12 + 4
    let o = tiffOrder
    var tiff = Array(o.rawValue.utf8)
    tiff += u16(42, o) + u32(8, o)
    tiff += u16(1, o)
    tiff += u16(0x8769, o) + u16(4, o) + u32(1, o) + u32(exifIfdAt, o)
    tiff += u32(0, o)
    tiff += u16(1, o)
    tiff += u16(0x927c, o) + u16(7, o) + u32(note.count, o) + u32(noteAt, o)
    tiff += u32(0, o)
    return tiff + note
  }

  /// SOI, an APP1 Exif segment (omitted for nil), a quantisation table, a scan, EOI.
  static func jpeg(exif tiff: [UInt8]?) -> [UInt8] {
    var bytes: [UInt8] = [0xff, 0xd8]
    if let tiff {
      bytes += [0xff, 0xe1] + be16(tiff.count + 8)
      bytes += Array("Exif\0\0".utf8)
      bytes += tiff
    }
    bytes += [0xff, 0xdb] + be16(67)
    bytes += [UInt8](repeating: 1, count: 65)
    bytes += [0xff, 0xda] + be16(8)
    bytes += [UInt8](repeating: 2, count: 6)
    bytes += [UInt8](repeating: 0x5a, count: 256)
    bytes += [0xff, 0xd9]
    return bytes
  }

  /// A HEIC whose Exif item sits in `idat`. The item opens with the byte count between its
  /// offset field and the TIFF header: 6 for the `Exif\0\0` prefix iPhones write.
  static func heic(exif tiff: [UInt8]?) -> [UInt8] {
    let ftyp = box("ftyp", Array("heic".utf8), be32(0), Array("mif1heic".utf8))
    var item: [UInt8] = []
    if let tiff { item = be32(6) + Array("Exif\0\0".utf8) + tiff }
    func infe(_ id: Int, _ type: String) -> [UInt8] {
      fullBox("infe", 2, be16(id), be16(0), Array("\(type)\0\0".utf8))
    }
    let count = tiff == nil ? 1 : 2
    let iinf = fullBox("iinf", 0, be16(count), infe(1, "hvc1"), tiff == nil ? [] : infe(2, "Exif"))
    var tiled: [UInt8] = be16(1) + be16(0) + be16(0) + be16(1)
    tiled += be32(0) + be32(1)
    var exif: [UInt8] = []
    if tiff != nil {
      exif = be16(2) + be16(1) + be16(0) + be16(1)
      exif += be32(0) + be32(item.count)
    }
    let iloc = fullBox("iloc", 1, [0x44, 0x00], be16(count), tiled, exif)
    let zeros = [UInt8](repeating: 0, count: 13)
    let hdlr = fullBox("hdlr", 0, [0, 0, 0, 0], Array("pict".utf8), zeros)
    let meta = fullBox("meta", 0, hdlr, iinf, iloc, box("idat", item))
    return ftyp + meta + box("mdat", [UInt8](repeating: 7, count: 64))
  }

  enum MetaStyle {
    case iso
    case quickTime
  }

  /// A QuickTime clip: `ftyp`, `mdat`, and `moov` holding an `mdta` key table and item list.
  static func clip(
    contentID: String?, metaStyle: MetaStyle = .quickTime,
    key: String = "com.apple.quicktime.content.identifier", topLevelMeta: Bool = false
  ) -> [UInt8] {
    let keys = fullBox(
      "keys", 0, be32(1), be32(8 + key.utf8.count), Array("mdta".utf8), Array(key.utf8))
    let items =
      contentID.map {
        [box("\u{0}\u{0}\u{0}\u{1}", box("data", be32(1), be32(0), Array($0.utf8)))]
      } ?? []
    let ilst = box("ilst", items.flatMap { $0 })
    let hdlr = fullBox(
      "hdlr", 0, [0, 0, 0, 0], Array("mdta".utf8), [UInt8](repeating: 0, count: 13))
    let meta =
      metaStyle == .iso ? fullBox("meta", 0, hdlr, keys, ilst) : box("meta", hdlr, keys, ilst)
    return box("ftyp", Array("qt  ".utf8), be32(0), Array("qt  ".utf8))
      + box("mdat", [UInt8](repeating: 9, count: 128))
      + box("moov", box("mvhd", [UInt8](repeating: 0, count: 100)), topLevelMeta ? [] : meta)
      + (topLevelMeta ? meta : [])
  }

  /// A still with Apple's Exif block carrying `contentID`, as a JPEG or a HEIC.
  static func still(_ ext: String, contentID: String?) -> Data {
    let tiff = appleTiff(contentID: contentID)
    return Data(["jpg", "jpeg"].contains(ext.lowercased()) ? jpeg(exif: tiff) : heic(exif: tiff))
  }
}
