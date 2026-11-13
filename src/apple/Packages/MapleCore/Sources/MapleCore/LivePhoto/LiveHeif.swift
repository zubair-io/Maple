import Foundation

/// The Exif item of a HEIF still, located through the `meta` box's `iinf` and `iloc`. Reads the
/// top-level box headers, the `meta` box (at most 1 MB) and the item's own extents (at most
/// 1 MB), never the coded image.
enum LiveHeif {
  private static let maxTopLevelBoxes = 32
  private static let maxMetaBytes = 1024 * 1024
  private static let maxItemBytes = 1024 * 1024

  private struct Extent {
    let offset: UInt64
    let length: Int
  }

  private struct ItemLocation {
    let constructionMethod: Int
    let extents: [Extent]
  }

  /// The TIFF block inside the Exif item. The item opens with the byte count between that
  /// field and the TIFF header.
  static func exifTiff(_ source: LiveByteSource) async -> [UInt8]? {
    guard let item = await exifItem(source), let skip = LiveBinary.int(item, 0, 4) else {
      return nil
    }
    let tiffStart = 4 + skip
    return tiffStart < item.count ? Array(item[tiffStart...]) : nil
  }

  private static func exifItem(_ source: LiveByteSource) async -> [UInt8]? {
    guard let metaBox = await findMetaBox(source), metaBox.size <= maxMetaBytes,
      let meta = await source.read(metaBox.start, metaBox.size)
    else { return nil }
    let children = LiveIsoBoxes.children(meta, metaBox.headerSize + 4, meta.count)
    guard let iinf = children.first(where: { $0.type == "iinf" }),
      let iloc = children.first(where: { $0.type == "iloc" }),
      let itemID = exifItemID(meta, iinf),
      let location = itemLocation(meta, iloc, itemID)
    else { return nil }
    return await extentBytes(
      source, meta, children.first(where: { $0.type == "idat" }), location)
  }

  private static func findMetaBox(_ source: LiveByteSource) async
    -> (start: UInt64, size: Int, headerSize: Int)?
  {
    var offset: UInt64 = 0
    for _ in 0..<maxTopLevelBoxes {
      guard let box = await LiveIsoBoxes.header(source, at: offset), box.size != 0,
        box.size >= box.headerSize, box.size <= source.size - offset
      else { return nil }
      if box.type == "meta" {
        guard let size = Int(exactly: box.size) else { return nil }
        return (offset, size, Int(box.headerSize))
      }
      offset += box.size
    }
    return nil
  }

  /// The id of the first `infe` box (version 2 or 3) declaring an item of type `Exif`.
  private static func exifItemID(_ meta: [UInt8], _ iinf: LiveBox) -> Int? {
    guard iinf.start < meta.count else { return nil }
    let entriesStart = iinf.start + 4 + (meta[iinf.start] == 0 ? 2 : 4)
    return LiveIsoBoxes.children(meta, entriesStart, iinf.end)
      .filter { $0.type == "infe" }
      .lazy.compactMap { infe -> Int? in
        guard infe.start < meta.count, meta[infe.start] == 2 || meta[infe.start] == 3 else {
          return nil
        }
        let idWidth = meta[infe.start] == 3 ? 4 : 2
        let idOffset = infe.start + 4
        let typeOffset = idOffset + idWidth + 2
        guard let id = LiveBinary.int(meta, idOffset, idWidth), typeOffset + 4 <= infe.end,
          LiveBinary.latin1(meta, typeOffset, typeOffset + 4) == "Exif"
        else { return nil }
        return id
      }.first
  }

  private static func isSupportedWidth(_ width: Int) -> Bool { [0, 2, 4, 8].contains(width) }

  private static func itemLocation(_ meta: [UInt8], _ iloc: LiveBox, _ itemID: Int)
    -> ItemLocation?
  {
    guard iloc.start + 6 <= iloc.end, iloc.end <= meta.count else { return nil }
    let version = Int(meta[iloc.start])
    guard version <= 2 else { return nil }
    let sizes = Int(meta[iloc.start + 4])
    let bases = Int(meta[iloc.start + 5])
    let offsetWidth = sizes >> 4
    let lengthWidth = sizes & 0xf
    let baseWidth = bases >> 4
    let indexWidth = version == 0 ? 0 : bases & 0xf
    let idWidth = version == 2 ? 4 : 2
    guard [offsetWidth, lengthWidth, baseWidth, indexWidth].allSatisfy(isSupportedWidth),
      let count = LiveBinary.uint(meta, iloc.start + 6, idWidth)
    else { return nil }
    let methodWidth = version == 0 ? 0 : 2
    var offset = iloc.start + 6 + idWidth
    var remaining = count
    while remaining > 0 {
      defer { remaining -= 1 }
      guard let id = LiveBinary.int(meta, offset, idWidth),
        let method = version == 0 ? 0 : LiveBinary.int(meta, offset + idWidth, 2),
        let dataReference = LiveBinary.int(meta, offset + idWidth + methodWidth, 2)
      else { return nil }
      let baseAt = offset + idWidth + methodWidth + 2
      guard let base = LiveBinary.uint(meta, baseAt, baseWidth),
        let extentCount = LiveBinary.int(meta, baseAt + baseWidth, 2)
      else { return nil }
      let extentsAt = baseAt + baseWidth + 2
      let extentSize = indexWidth + offsetWidth + lengthWidth
      let extents = (0..<extentCount).map { index -> Extent? in
        let at = extentsAt + index * extentSize + indexWidth
        guard let extentOffset = LiveBinary.uint(meta, at, offsetWidth),
          let length = LiveBinary.int(meta, at + offsetWidth, lengthWidth), length > 0,
          length <= maxItemBytes
        else { return nil }
        let (absolute, overflow) = base.addingReportingOverflow(extentOffset)
        return overflow ? nil : Extent(offset: absolute, length: length)
      }
      guard !extents.contains(where: { $0 == nil }) else { return nil }
      if id == itemID {
        return dataReference == 0
          ? ItemLocation(constructionMethod: method & 0xf, extents: extents.compactMap { $0 })
          : nil
      }
      offset = extentsAt + extentCount * extentSize
    }
    return nil
  }

  private static func extentBytes(
    _ source: LiveByteSource, _ meta: [UInt8], _ idat: LiveBox?, _ location: ItemLocation
  ) async -> [UInt8]? {
    let total = location.extents.reduce(0) { $0 + $1.length }
    guard total <= maxItemBytes, !location.extents.isEmpty else { return nil }
    switch location.constructionMethod {
    case 1:
      guard let idat else { return nil }
      var bytes: [UInt8] = []
      for extent in location.extents {
        guard let offset = Int(exactly: extent.offset),
          offset + extent.length <= idat.end - idat.start
        else { return nil }
        bytes += meta[(idat.start + offset)..<(idat.start + offset + extent.length)]
      }
      return bytes
    case 0:
      var bytes: [UInt8] = []
      for extent in location.extents {
        guard let part = await source.read(extent.offset, extent.length) else { return nil }
        bytes += part
      }
      return bytes
    default:
      return nil
    }
  }
}
