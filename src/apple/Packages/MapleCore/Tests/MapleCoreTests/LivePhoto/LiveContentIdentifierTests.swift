import Foundation
import XCTest

@testable import MapleCore

final class LiveContentIdentifierTests: XCTestCase {
  private typealias Fixtures = LivePhotoFixtures
  private let id = "3F2A8C1E-9B47-4D55-A6E0-0C7D1B2E4F90"

  private func read(_ bytes: [UInt8], _ kind: LivePhotoPairing.Kind) async -> String? {
    let data = Data(bytes)
    return await LiveContentIdentifier.read(kind: kind, size: UInt64(data.count)) {
      offset, length in
      data.subdata(in: Int(offset)..<Int(offset) + length)
    }
  }

  func testReadsTag0x0011FromEveryByteOrderCombination() async {
    let orders: [(Fixtures.ByteOrder, Fixtures.ByteOrder)] = [
      (.big, .big), (.little, .little), (.big, .little),
    ]
    for (tiff, note) in orders {
      let block = Fixtures.appleTiff(contentID: id, tiffOrder: tiff, noteOrder: note)
      let jpeg = await read(Fixtures.jpeg(exif: block), .still)
      let heic = await read(Fixtures.heic(exif: block), .still)
      XCTAssertEqual(jpeg, id, "JPEG \(tiff)/\(note)")
      XCTAssertEqual(heic, id, "HEIC \(tiff)/\(note)")
    }
  }

  func testReadsTheClipKeyFromBothMetaLayoutsAndContainers() async {
    for style in [Fixtures.MetaStyle.quickTime, .iso] {
      for topLevel in [false, true] {
        let clip = Fixtures.clip(contentID: id, metaStyle: style, topLevelMeta: topLevel)
        let found = await read(clip, .clip)
        XCTAssertEqual(found, id, "\(style) topLevel=\(topLevel)")
      }
    }
  }

  func testUpperCasesTheIdentifier() async {
    let lower = id.lowercased()
    let still = await read(Fixtures.jpeg(exif: Fixtures.appleTiff(contentID: lower)), .still)
    let clip = await read(Fixtures.clip(contentID: lower), .clip)
    XCTAssertEqual(still, id)
    XCTAssertEqual(clip, id)
  }

  func testNilWhenTheFileCarriesNoIdentifier() async {
    let noTag = Fixtures.appleTiff(contentID: nil)
    let foreign = Fixtures.appleTiff(contentID: id, makerNoteHeader: "Nikon\0\u{2}\u{10}\0\0")
    let jpegNoTag = await read(Fixtures.jpeg(exif: noTag), .still)
    let heicNoTag = await read(Fixtures.heic(exif: noTag), .still)
    let jpegForeign = await read(Fixtures.jpeg(exif: foreign), .still)
    let jpegNoExif = await read(Fixtures.jpeg(exif: nil), .still)
    let heicNoExif = await read(Fixtures.heic(exif: nil), .still)
    let clipNoItem = await read(Fixtures.clip(contentID: nil), .clip)
    let clipWrongKey = await read(
      Fixtures.clip(contentID: id, key: "com.apple.quicktime.title"), .clip)
    XCTAssertNil(jpegNoTag)
    XCTAssertNil(heicNoTag)
    XCTAssertNil(jpegForeign)
    XCTAssertNil(jpegNoExif)
    XCTAssertNil(heicNoExif)
    XCTAssertNil(clipNoItem)
    XCTAssertNil(clipWrongKey)
  }

  func testNilForImplausibleTokensJunkAndEmptyFiles() async {
    for token in ["short", String(repeating: "A", count: 65), "has space in the token"] {
      let still = await read(Fixtures.jpeg(exif: Fixtures.appleTiff(contentID: token)), .still)
      let clip = await read(Fixtures.clip(contentID: token), .clip)
      XCTAssertNil(still, token)
      XCTAssertNil(clip, token)
    }
    let junk = [UInt8](repeating: 0x41, count: 4096)
    let stillJunk = await read(junk, .still)
    let clipJunk = await read(junk, .clip)
    let stillEmpty = await read([], .still)
    let clipEmpty = await read([], .clip)
    let truncated = Fixtures.appleTiff(contentID: id)
    let stillTruncated = await read(
      Fixtures.jpeg(exif: Array(truncated.prefix(truncated.count - 20))), .still)
    XCTAssertNil(stillJunk)
    XCTAssertNil(clipJunk)
    XCTAssertNil(stillEmpty)
    XCTAssertNil(clipEmpty)
    XCTAssertNil(stillTruncated)
  }

  func testReadsAFileOnDiskAndNothingFromAMissingOne() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("live-id-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let still = directory.appendingPathComponent("a.HEIC")
    let clip = directory.appendingPathComponent("a.MOV")
    try Fixtures.still("heic", contentID: id).write(to: still)
    try Data(Fixtures.clip(contentID: id)).write(to: clip)

    let stillID = await LiveContentIdentifier.read(fileAt: still, kind: .still)
    let clipID = await LiveContentIdentifier.read(fileAt: clip, kind: .clip)
    let missing = await LiveContentIdentifier.read(
      fileAt: directory.appendingPathComponent("gone.MOV"), kind: .clip)
    XCTAssertEqual(stillID, id)
    XCTAssertEqual(clipID, id)
    XCTAssertNil(missing)
  }

  func testAMetadataReadNeverPullsMoreThanItsBudgetOfAHugeFile() async {
    let clip = Data(Fixtures.clip(contentID: nil))
    let fetched = FetchCounter()
    let size = UInt64(2_000_000_000)
    _ = await LiveContentIdentifier.read(kind: .clip, size: size) { offset, length in
      await fetched.add(length)
      guard offset < UInt64(clip.count) else { return Data(count: length) }
      return clip.subdata(in: Int(offset)..<min(clip.count, Int(offset) + length))
        + Data(count: max(0, Int(offset) + length - clip.count))
    }
    let total = await fetched.total
    XCTAssertLessThanOrEqual(total, LiveByteSource.headBytes + LiveByteSource.readBudgetBytes)
  }
}

private actor FetchCounter {
  private(set) var total = 0
  func add(_ bytes: Int) { total += bytes }
}
