// RawExifDatesTests.swift — #5090: the device reads a file's EXIF capture-date
// strings from the tag bytes as the server's exifr does, so ImageIO's repairs
// and omissions no longer make the device and the server date one file two
// ways. Every expectation below was produced by exifr on the same bytes
// (src/api/tests/maple-id-exif-parity.test.ts builds the same shapes).

import Foundation
import XCTest

@testable import MapleCore

final class RawExifDatesTests: XCTestCase {
  private struct Tag {
    let id: Int
    var type = 2
    let value: [UInt8]
    var count: Int? = nil
  }

  private func ascii(_ text: String, nul: Bool = true) -> [UInt8] {
    Array(text.utf8) + (nul ? [0] : [])
  }

  private func tiff(exif: [Tag], littleEndian: Bool, padding: Int = 0) -> [UInt8] {
    func u16(_ n: Int) -> [UInt8] {
      let bytes = [UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)]
      return littleEndian ? bytes.reversed() : bytes
    }
    func u32(_ n: Int) -> [UInt8] {
      let bytes = [
        UInt8(n >> 24 & 0xFF), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF),
      ]
      return littleEndian ? bytes.reversed() : bytes
    }
    let exifOffset = 8 + 2 + 12 + 4 + padding
    var dataOffset = exifOffset + 2 + 12 * exif.count + 4
    var entries: [[UInt8]] = []
    var blobs: [UInt8] = []
    for tag in exif {
      let head = u16(tag.id) + u16(tag.type) + u32(tag.count ?? tag.value.count)
      if tag.value.count <= 4 {
        entries.append(head + tag.value + [UInt8](repeating: 0, count: 4 - tag.value.count))
      } else {
        entries.append(head + u32(dataOffset))
        blobs += tag.value
        dataOffset += tag.value.count
      }
    }
    let order: [UInt8] = littleEndian ? [0x49, 0x49] : [0x4D, 0x4D]
    return order + u16(42) + u32(8)
      + u16(1) + u16(0x8769) + u16(4) + u32(1) + u32(exifOffset) + u32(0)
      + [UInt8](repeating: 0, count: padding)
      + u16(exif.count) + entries.flatMap { $0 } + u32(0) + blobs
  }

  private func jpeg(_ tiff: [UInt8]) -> [UInt8] {
    let exif = Array("Exif".utf8) + [0, 0] + tiff
    let length = exif.count + 2
    return [0xFF, 0xD8, 0xFF, 0xE1, UInt8(length >> 8), UInt8(length & 0xFF)] + exif + [0xFF, 0xD9]
  }

  private func dates(_ bytes: [UInt8]) async throws -> (String?, String?) {
    let result = try await RawExifDates.read(from: .data(Data(bytes)))
    return (result.dateTimeOriginal, result.createDate)
  }

  private let original: UInt16 = 0x9003
  private let created: UInt16 = 0x9004

  private func shapes(littleEndian: Bool) async throws {
    let cases: [(label: String, tags: [Tag], original: String?, created: String?)] = [
      (
        "conformant",
        [
          Tag(id: 0x9003, value: ascii("2024:06:01 12:34:56")),
          Tag(id: 0x9004, value: ascii("2024:06:01 12:34:57")),
        ],
        "2024:06:01 12:34:56", "2024:06:01 12:34:57"
      ),
      (
        "non-padded fields is not repaired", [Tag(id: 0x9003, value: ascii("2024:6:1 12:34:56"))],
        "2024:6:1 12:34:56", nil
      ),
      (
        "T separator is not dropped", [Tag(id: 0x9003, value: ascii("2024:06:01T12:34:56"))],
        "2024:06:01T12:34:56", nil
      ),
      (
        "dashes are not dropped", [Tag(id: 0x9003, value: ascii("2024-06-01 12:34:56"))],
        "2024-06-01 12:34:56", nil
      ),
      (
        "no NUL terminator", [Tag(id: 0x9003, value: ascii("2024:06:01 12:34:56", nul: false))],
        "2024:06:01 12:34:56", nil
      ),
      (
        "unrelated tags only", [Tag(id: 0x829A, type: 5, value: [UInt8](repeating: 0, count: 8))],
        nil, nil
      ),
      (
        "undefined-typed value", [Tag(id: 0x9003, type: 7, value: ascii("2024:06:01 12:34:56"))],
        nil, nil
      ),
      (
        "first of a duplicated tag",
        [
          Tag(id: 0x9003, value: ascii("2024:06:02 12:34:56")),
          Tag(id: 0x9003, value: ascii("2023:06:01 12:34:56")),
        ],
        "2024:06:02 12:34:56", nil
      ),
    ]
    for entry in cases {
      let block = tiff(exif: entry.tags, littleEndian: littleEndian)
      for (container, bytes) in [("TIFF", block), ("JPEG", jpeg(block))] {
        let result = try await dates(bytes)
        let label = "\(entry.label) / \(container) / \(littleEndian ? "II" : "MM")"
        XCTAssertEqual(result.0.map(trimmed), entry.original, label)
        XCTAssertEqual(result.1.map(trimmed), entry.created, label)
      }
    }
  }

  private func trimmed(_ text: String) -> String {
    String(text.reversed().drop { $0 == "\u{0}" }.reversed())
  }

  func testLittleEndianTagShapes() async throws { try await shapes(littleEndian: true) }

  func testBigEndianTagShapes() async throws { try await shapes(littleEndian: false) }

  func testEveryShapeDatesAsTheServerDoes() async throws {
    let cases: [(label: String, original: [UInt8], expected: String)] = [
      (
        "non-padded fields fall through to the digitized date", ascii("2024:6:1 12:34:56"),
        "2024-06-01T12:34:57.000Z"
      ),
      ("a T separator dates the photo", ascii("2024:06:01T12:34:56"), "2024-06-01T12:34:56.000Z"),
      (
        "a space-padded hour falls through", ascii("2024:06:01  2:34:56"),
        "2024-06-01T12:34:57.000Z"
      ),
      (
        "a NUL then a space still matches", Array("2024:06:01 12:34:56\0 ".utf8),
        "2024-06-01T12:34:56.000Z"
      ),
      (
        "an interior NUL falls through", Array("2024:06:01\0 12:34:56\0".utf8),
        "2024-06-01T12:34:57.000Z"
      ),
      (
        "the zero placeholder rolls back", ascii("0000:00:00 00:00:00"),
        "1899-11-30T00:00:00.000Z"
      ),
    ]
    for entry in cases {
      let block = tiff(
        exif: [
          Tag(id: 0x9003, value: entry.original),
          Tag(id: 0x9004, value: ascii("2024:06:01 12:34:57")),
        ],
        littleEndian: false)
      let result = try await dates(jpeg(block))
      XCTAssertEqual(
        ExifCaptureDate.capturedAt(dateTimeOriginal: result.0, createDate: result.1),
        entry.expected,
        entry.label)
    }
  }

  func testAnExifIFDPastTheFirst64KilobytesIsRead() async throws {
    let block = tiff(
      exif: [Tag(id: 0x9003, value: ascii("2024:06:01 12:34:56"))], littleEndian: true,
      padding: 70_000)
    var requested: [UInt64] = []
    let data = Data(block)
    let reader = ByteRangeReader(size: UInt64(data.count)) { offset, length in
      requested.append(offset)
      return try await ByteRangeReader.data(data).read(offset: offset, length: length)
    }
    let result = try await RawExifDates.read(from: reader)
    XCTAssertEqual(result.dateTimeOriginal.map(trimmed), "2024:06:01 12:34:56")
    XCTAssertTrue(requested.contains { $0 >= 70_000 }, "the ExifIFD is reached by a ranged read")
  }

  func testUnknownContainersAndBadStructureYieldNoDates() async throws {
    let good = tiff(
      exif: [Tag(id: 0x9003, value: ascii("2024:06:01 12:34:56"))], littleEndian: true)
    var pastEnd = good
    pastEnd.replaceSubrange(18..<22, with: [0xFF, 0xFF, 0x00, 0x00])
    let cases: [(String, [UInt8])] = [
      ("GIF", Array("GIF89a......".utf8)),
      ("empty", []),
      ("truncated value", Array(good.dropLast(6))),
      ("ExifIFD offset past the end", pastEnd),
      (
        "JPEG without APP1",
        [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10] + [UInt8](repeating: 0, count: 14) + [0xFF, 0xD9]
      ),
      (
        "APP1 after the scan data",
        [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02] + Array(jpeg(good).dropFirst(2))
      ),
    ]
    for (label, bytes) in cases {
      let result = try await dates(bytes)
      XCTAssertNil(result.0, label)
      XCTAssertNil(result.1, label)
    }
  }
}
