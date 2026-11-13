// RawExifDates.swift — a file's EXIF capture-date strings, read from the tag
// bytes themselves (#5090).
//
// The server dates a file from exifr's string for ExifIFD tags 0x9003 /
// 0x9004, and the primary maple_id hashes that date. ImageIO's metadata
// dictionary is not those bytes: it repairs `2024:6:1 12:34:56`, drops
// `2024:06:01T12:34:56`, and finds a date in a DNG whose ExifIFD exifr's
// chunked reader never reaches. So the device reads the tag bytes the way the
// server does: IFD0 -> ExifIFD through ranged reads, ASCII only. The rules
// are those of the shared TypeScript reader (`exif-capture-dates.ts`) and
// are pinned against it by `test-fixtures/ids/derivation.json`; the
// containers the server hands exifr as a bare TIFF block (HEIC, WebP — via
// `heic-exif.ts` / `webp-exif.ts`) and exifr's own PNG chunk walk are
// reproduced here.

import Foundation

enum RawExifDates {
  /// Both fields are `nil` for a container this reader does not know and for
  /// a known container without the tags. Throws only what `reader` throws.
  static func read(from reader: ByteRangeReader) async throws
    -> ImageMetadataReader
    .RawCaptureDateStrings
  {
    guard let block = try await locateTiffBlock(in: reader) else {
      return ImageMetadataReader.RawCaptureDateStrings(dateTimeOriginal: nil, createDate: nil)
    }
    return try await dates(in: block)
  }

  // MARK: - Containers

  /// A TIFF block inside a file: where its header sits and where it ends.
  private struct TiffBlock {
    let reader: ByteRangeReader
    let base: UInt64
    let end: UInt64
  }

  private static func locateTiffBlock(in reader: ByteRangeReader) async throws -> TiffBlock? {
    let magic = try await reader.read(offset: 0, length: 12)
    if magic.starts(with: [0xFF, 0xD8]) { return try await jpegBlock(in: reader) }
    if magic.starts(with: [0x49, 0x49]) || magic.starts(with: [0x4D, 0x4D]) {
      return TiffBlock(reader: reader, base: 0, end: reader.size)
    }
    if magic.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
      return try await pngBlock(in: reader)
    }
    if magic.count == 12, ascii(magic, 0, 4) == "RIFF", ascii(magic, 8, 12) == "WEBP" {
      return try await webpBlock(in: reader)
    }
    if magic.count >= 8, ascii(magic, 4, 8) == "ftyp" { return try await heifBlock(in: reader) }
    return nil
  }

  private static func ascii(_ data: Data, _ from: Int, _ to: Int) -> String {
    String(decoding: data[data.startIndex + from..<data.startIndex + to], as: UTF8.self)
  }

  private static func u16(_ data: Data, _ at: Int, littleEndian: Bool = false) -> Int {
    let bytes = [Int(data[data.startIndex + at]), Int(data[data.startIndex + at + 1])]
    return littleEndian ? bytes[1] << 8 | bytes[0] : bytes[0] << 8 | bytes[1]
  }

  private static func u32(_ data: Data, _ at: Int, littleEndian: Bool = false) -> UInt64 {
    let bytes = (0..<4).map { UInt64(data[data.startIndex + at + $0]) }
    return (littleEndian ? bytes.reversed() : bytes).reduce(0) { $0 << 8 | $1 }
  }

  /// The first APP1 `Exif\0\0` segment before the scan data, like exifr's.
  private static func jpegBlock(in reader: ByteRangeReader) async throws -> TiffBlock? {
    var at: UInt64 = 2
    while at + 4 <= reader.size {
      let head = try await reader.read(offset: at, length: 4)
      guard head.count == 4, head[head.startIndex] == 0xFF else { return nil }
      let marker = head[head.startIndex + 1]
      if marker == 0xD9 || marker == 0xDA { return nil }
      if marker == 0xFF {
        at += 1
        continue
      }
      if marker == 0x01 || (0xD0...0xD7).contains(marker) {
        at += 2
        continue
      }
      let length = UInt64(u16(head, 2))
      if marker == 0xE1, length >= 8 {
        let id = try await reader.read(offset: at + 4, length: 6)
        if id.elementsEqual([0x45, 0x78, 0x69, 0x66, 0, 0]) {
          return TiffBlock(reader: reader, base: at + 10, end: at + 2 + length)
        }
      }
      at += 2 + length
    }
    return nil
  }

  /// The first `eXIf` chunk (exifr matches the type case-insensitively), found
  /// by walking every chunk header like exifr's PNG parser.
  private static func pngBlock(in reader: ByteRangeReader) async throws -> TiffBlock? {
    var at: UInt64 = 8
    while at + 8 <= reader.size {
      let head = try await reader.read(offset: at, length: 8)
      guard head.count == 8 else { return nil }
      let length = u32(head, 0)
      if ascii(head, 4, 8).lowercased() == "exif" {
        return TiffBlock(reader: reader, base: at + 8, end: min(at + 8 + length, reader.size))
      }
      at += 12 + length
    }
    return nil
  }

  /// The RIFF `EXIF` chunk, past its optional `Exif\0\0` marker — the server's
  /// `extractWebpExifTiff`.
  private static func webpBlock(in reader: ByteRangeReader) async throws -> TiffBlock? {
    var at: UInt64 = 12
    while at + 8 <= reader.size {
      let head = try await reader.read(offset: at, length: 8)
      guard head.count == 8 else { return nil }
      let size = u32(head, 4, littleEndian: true)
      let payload = at + 8
      guard payload + size <= reader.size else { return nil }
      if ascii(head, 0, 4) == "EXIF" {
        var start = payload
        var length = size
        let marker = try await reader.read(offset: payload, length: 6)
        if size >= 6, marker.elementsEqual([0x45, 0x78, 0x69, 0x66, 0, 0]) {
          start += 6
          length -= 6
        }
        return length > 0 ? TiffBlock(reader: reader, base: start, end: start + length) : nil
      }
      at = payload + size + (size & 1)
    }
    return nil
  }

  // MARK: - HEIF

  private struct Box {
    let offset: Int
    let length: Int
    let kind: String
    let start: Int
  }

  private struct Truncated: Error {}

  /// `meta` -> `iinf` / `iloc` -> the Exif item's extent: a port of the server's
  /// `extractHeicExifTiff` (itself a port of exifr's HEIF walker), reading
  /// only the top-level box headers and the `meta` box.
  private static func heifBlock(in reader: ByteRangeReader) async throws -> TiffBlock? {
    var at: UInt64 = 0
    var meta: Data?
    while at + 8 <= reader.size, meta == nil {
      let head = try await reader.read(offset: at, length: 16)
      guard head.count >= 8 else { return nil }
      var length = u32(head, 0)
      if length == 1 {
        guard head.count >= 16 else { return nil }
        length = u32(head, 8) << 32 | u32(head, 12)
      } else if length == 0 {
        length = reader.size - at
      }
      guard length >= 8, at + length <= reader.size else { return nil }
      if ascii(head, 4, 8) == "meta" {
        meta = try await reader.read(offset: at, length: Int(length))
      }
      at += length
    }
    guard let meta, let extent = try? exifExtent(inMeta: [UInt8](meta)) else { return nil }
    let nameSize = try await reader.read(offset: extent.offset, length: 4)
    guard nameSize.count == 4 else { return nil }
    let shift = 4 + u32(nameSize, 0)
    guard extent.length > shift, extent.offset + extent.length <= reader.size else { return nil }
    return TiffBlock(
      reader: reader, base: extent.offset + shift, end: extent.offset + extent.length)
  }

  private static func u(_ buf: [UInt8], _ at: Int, _ size: Int) throws -> UInt64 {
    guard size >= 0, at >= 0, at + size <= buf.count else { throw Truncated() }
    return buf[at..<at + size].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
  }

  private static func boxHead(_ buf: [UInt8], _ offset: Int) throws -> Box {
    var length = Int(try u(buf, offset, 4))
    let kind = String(decoding: buf[offset + 4..<offset + 8], as: UTF8.self)
    var start = offset + 8
    if length == 1 {
      length = Int(try u(buf, offset + 8, 8))
      start += 8
    } else if length == 0 {
      length = buf.count - offset
    }
    guard length >= start - offset else { throw Truncated() }
    return Box(offset: offset, length: length, kind: kind, start: start)
  }

  private static func findBox(_ buf: [UInt8], _ start: Int, _ end: Int, _ kind: String) throws
    -> Box?
  {
    var offset = start
    while offset + 8 <= end {
      let box = try boxHead(buf, offset)
      guard box.offset + box.length <= end else { throw Truncated() }
      if box.kind == kind { return box }
      offset = box.offset + box.length
    }
    return nil
  }

  private static func exifExtent(inMeta data: [UInt8]) throws -> (offset: UInt64, length: UInt64)? {
    let meta = try boxHead(data, 0)
    let childStart = meta.start + 4
    guard let iinf = try findBox(data, childStart, meta.length, "iinf"),
      let iloc = try findBox(data, childStart, meta.length, "iloc"),
      let itemId = try exifItemId(data, iinf)
    else { return nil }
    return try extent(data, iloc, itemId)
  }

  private static func exifItemId(_ buf: [UInt8], _ iinf: Box) throws -> UInt64? {
    let version = try u(buf, iinf.start, 1)
    var offset = iinf.start + 4
    var count: Int
    if version == 0 {
      count = Int(try u(buf, offset, 2))
      offset += 2
    } else {
      count = Int(try u(buf, offset, 4))
      offset += 4
    }
    let end = iinf.offset + iinf.length
    while count > 0, offset + 8 <= end {
      count -= 1
      let infe = try boxHead(buf, offset)
      let contentStart = infe.start + 4
      if try u(buf, infe.start, 1) >= 2 {
        let idSize = try u(buf, infe.start, 1) == 3 ? 4 : 2
        let nameAt = contentStart + idSize + 2
        guard nameAt + 4 <= buf.count else { throw Truncated() }
        if String(decoding: buf[nameAt..<nameAt + 4], as: UTF8.self) == "Exif" {
          return try u(buf, contentStart, idSize)
        }
      }
      offset = infe.offset + infe.length
    }
    return nil
  }

  private static func extent(_ buf: [UInt8], _ iloc: Box, _ wanted: UInt64) throws -> (
    offset: UInt64, length: UInt64
  )? {
    let version = try u(buf, iloc.start, 1)
    var offset = iloc.start + 4
    let sizes = try u(buf, offset, 2)
    offset += 2
    let offsetSize = Int(sizes >> 12 & 0xF)
    let lengthSize = Int(sizes >> 8 & 0xF)
    let baseOffsetSize = Int(sizes >> 4 & 0xF)
    let indexSize = Int(sizes & 0xF)
    let itemIdSize = version == 2 ? 4 : 2
    let methodSize = version == 1 || version == 2 ? 2 : 0
    let extentSize = indexSize + offsetSize + lengthSize
    let countSize = version == 2 ? 4 : 2
    var items = Int(try u(buf, offset, countSize))
    offset += countSize
    while items > 0 {
      items -= 1
      let id = try u(buf, offset, itemIdSize)
      let baseOffset = try u(buf, offset + itemIdSize + methodSize + 2, baseOffsetSize)
      offset += itemIdSize + methodSize + 2 + baseOffsetSize
      let extentCount = Int(try u(buf, offset, 2))
      offset += 2
      if id == wanted {
        let extentOffset = try u(buf, offset + indexSize, offsetSize)
        let extentLength = try u(buf, offset + indexSize + offsetSize, lengthSize)
        return (baseOffset + extentOffset, extentLength)
      }
      offset += extentCount * extentSize
    }
    return nil
  }

  // MARK: - TIFF tags

  private static let exifIFDPointer = 0x8769
  private static let dateTimeOriginal = 0x9003
  private static let createDate = 0x9004
  private static let typeASCII = 2
  private static let typeLong = 4
  private static let typeIFD = 13

  private struct Entry {
    let type: Int
    let count: UInt64
    /// Absolute position of the entry's 4-byte value/offset field.
    let valueField: UInt64
  }

  private static func dates(in block: TiffBlock) async throws
    -> ImageMetadataReader
    .RawCaptureDateStrings
  {
    let none = ImageMetadataReader.RawCaptureDateStrings(dateTimeOriginal: nil, createDate: nil)
    let header = try await block.reader.read(offset: block.base, length: 8)
    guard header.count == 8 else { return none }
    let order = ascii(header, 0, 2)
    guard order == "II" || order == "MM" else { return none }
    let littleEndian = order == "II"
    let read16 = { (data: Data, at: Int) in u16(data, at, littleEndian: littleEndian) }
    let read32 = { (data: Data, at: Int) in u32(data, at, littleEndian: littleEndian) }

    func ifd(at offset: UInt64) async throws -> [Int: Entry] {
      var entries: [Int: Entry] = [:]
      let start = block.base + offset
      guard start + 2 <= block.end else { return entries }
      let countBytes = try await block.reader.read(offset: start, length: 2)
      guard countBytes.count == 2 else { return entries }
      let count = read16(countBytes, 0)
      let tableLength = count * 12
      guard start + 2 + UInt64(tableLength) <= block.end else { return entries }
      let table = try await block.reader.read(offset: start + 2, length: tableLength)
      guard table.count == tableLength else { return entries }
      for index in 0..<count {
        let entry = index * 12
        let tag = read16(table, entry)
        if entries[tag] == nil {
          entries[tag] = Entry(
            type: read16(table, entry + 2), count: read32(table, entry + 4),
            valueField: start + 2 + UInt64(entry) + 8)
        }
      }
      return entries
    }

    func string(of entry: Entry?) async throws -> String? {
      guard let entry, entry.type == typeASCII, entry.count > 0 else { return nil }
      let bytes: Data
      if entry.count <= 4 {
        bytes = try await block.reader.read(offset: entry.valueField, length: Int(entry.count))
      } else {
        let field = try await block.reader.read(offset: entry.valueField, length: 4)
        guard field.count == 4 else { return nil }
        let at = block.base + read32(field, 0)
        guard at + entry.count <= block.end else { return nil }
        bytes = try await block.reader.read(offset: at, length: Int(entry.count))
      }
      return String(decoding: bytes, as: UTF8.self)
    }

    let ifd0 = try await ifd(at: read32(header, 4))
    guard let pointer = ifd0[exifIFDPointer], pointer.type == typeLong || pointer.type == typeIFD
    else { return none }
    let field = try await block.reader.read(offset: pointer.valueField, length: 4)
    guard field.count == 4 else { return none }
    let exif = try await ifd(at: read32(field, 0))
    return ImageMetadataReader.RawCaptureDateStrings(
      dateTimeOriginal: try await string(of: exif[dateTimeOriginal]),
      createDate: try await string(of: exif[createDate]))
  }
}
