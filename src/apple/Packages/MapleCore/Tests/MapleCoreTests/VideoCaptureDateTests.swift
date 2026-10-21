// VideoCaptureDateTests.swift — #5001: the device reads a video's capture
// date exactly as the server's `readVideoMetadata` + `asIsoDate` do, so a
// backed-up video derives the server's primary-form maple_id. Every expected
// string here was produced by the server's own `readExif` on the same bytes,
// except the timezone-less and JavaScript-only key cases, where the device
// deliberately uses mvhd and is known to differ.

import Foundation
import XCTest

@testable import MapleCore

final class VideoCaptureDateTests: XCTestCase {
  private func goldenURL() throws -> URL {
    try WorkflowFixture.root().appendingPathComponent("ids/dated-video.mov")
  }

  // MARK: - Shared golden (also pinned by tests/maple-id-contract.test.ts and raw-core)

  func testGoldenVideoDateMatchesTheServer() throws {
    let bytes = try Data(contentsOf: goldenURL())
    XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2026-04-05T18:26:20.000Z")
  }

  func testGoldenVideoDerivesTheServersPrimaryId() throws {
    let bytes = try Data(contentsOf: goldenURL())
    let date = try XCTUnwrap(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes))
    XCTAssertEqual(
      MapleId.primary(headBytes: Data(bytes.prefix(64 * 1024)), capturedAtISO8601: date),
      "01b176338229c1cb8b9ddfc6235e829d")
  }

  // MARK: - Parser branches, on hand-built boxes

  private func u32(_ value: UInt32) -> [UInt8] {
    [UInt8(value >> 24), UInt8(value >> 16 & 0xFF), UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF)]
  }

  private func box(_ type: String, _ payload: [UInt8]) -> [UInt8] {
    u32(UInt32(8 + payload.count)) + Array(type.utf8) + payload
  }

  private func mvhd(unix: UInt32, version: UInt8 = 0) -> [UInt8] {
    let seconds = UInt64(unix) + 2_082_844_800
    let time =
      version == 1
      ? u32(UInt32(seconds >> 32)) + u32(UInt32(seconds & 0xFFFF_FFFF))
      : u32(UInt32(seconds))
    return box("mvhd", [version, 0, 0, 0] + time + [UInt8](repeating: 0, count: 80))
  }

  private func meta(creationDate: String, fullBox: Bool = false) -> [UInt8] {
    let key = Array("com.apple.quicktime.creationdate".utf8)
    let keys = box(
      "keys", [0, 0, 0, 0] + u32(1) + u32(UInt32(8 + key.count)) + Array("mdta".utf8) + key)
    let data = box("data", u32(1) + u32(0) + Array(creationDate.utf8))
    let ilst = box("ilst", u32(UInt32(8 + data.count)) + u32(1) + data)
    let hdlr = box(
      "hdlr",
      [UInt8](repeating: 0, count: 8) + Array("mdta".utf8) + [UInt8](repeating: 0, count: 13))
    return box("meta", (fullBox ? [0, 0, 0, 0] : []) + hdlr + keys + ilst)
  }

  private func video(_ moovChildren: [UInt8]) -> Data {
    Data(
      box("ftyp", Array("qt  ".utf8) + u32(0)) + box("moov", moovChildren)
        + box("mdat", [1, 2, 3]))
  }

  func testCreationDateKeyWinsOverMvhd() {
    let bytes = video(mvhd(unix: 1_700_000_000) + meta(creationDate: "2024-03-01T10:00:00+0100"))
    XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2024-03-01T09:00:00.000Z")
  }

  func testMvhdIsTheFallbackWithoutAKey() {
    let bytes = video(mvhd(unix: 1_700_000_000))
    XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2023-11-14T22:13:20.000Z")
  }

  func testVersionOneMvhdUsesSixtyFourBitTime() {
    let bytes = video(mvhd(unix: 1_700_000_000, version: 1))
    XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2023-11-14T22:13:20.000Z")
  }

  func testMetaNestedUnderUdtaAndIsoFullBoxMetaAreBothRead() {
    let nested = video(box("udta", meta(creationDate: "2024-03-01T10:00:00Z")))
    XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: nested), "2024-03-01T10:00:00.000Z")
    let fullBox = video(meta(creationDate: "2024-03-01T10:00:00Z", fullBox: true))
    XCTAssertEqual(
      VideoCaptureDate.iso8601UTC(fromVideoBytes: fullBox), "2024-03-01T10:00:00.000Z")
  }

  func testFractionalSecondsTruncateToMilliseconds() {
    let bytes = video(meta(creationDate: "2024-03-01T10:00:00.1239Z"))
    XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2024-03-01T10:00:00.123Z")
  }

  func testATimezonelessKeyFallsBackToMvhdRatherThanGuessingAZone() {
    let bytes = video(mvhd(unix: 1_700_000_000) + meta(creationDate: "2024-03-01T10:00:00"))
    XCTAssertEqual(
      VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2023-11-14T22:13:20.000Z",
      "the server reads this in its own local zone, which the device cannot know")
  }

  func testKeyValuesReadToTheServersInstant() {
    let expected = [
      " 2024-03-01T10:00:00Z\n": "2024-03-01T10:00:00.000Z",
      "2024-03-01T10:00:00.5Z": "2024-03-01T10:00:00.500Z",
      "2024-03-01T10:00:00.9999Z": "2024-03-01T10:00:00.999Z",
      "2023-02-29T10:00:00Z": "2023-03-01T10:00:00.000Z",
      "2024-03-01T10:00:00+2359": "2024-02-29T10:01:00.000Z",
      "2024-03-01T10:00:00-0730": "2024-03-01T17:30:00.000Z",
    ]
    for (key, iso) in expected {
      let bytes = video(mvhd(unix: 1_700_000_000) + meta(creationDate: key))
      XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), iso, key)
    }
  }

  func testAKeyWithoutDigitsFallsBackToMvhdLikeTheServer() {
    for key in ["", "   ", "not-a-date", "Jan", "\u{85}", "\u{FEFF}"] {
      let bytes = video(mvhd(unix: 1_700_000_000) + meta(creationDate: key))
      XCTAssertEqual(
        VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2023-11-14T22:13:20.000Z",
        "no JavaScript Date parse succeeds without an ASCII digit, so the server uses mvhd: \(key)")
    }
  }

  /// JavaScript rejects these, so the server dates the clip from mvhd; the
  /// device must too (#5092 review).
  func testKeysJavaScriptRejectsFallBackToMvhdLikeTheServer() {
    let rejected = [
      "２０２４-03-01T10:00:00Z", "2024-03-01T10:00:00+24:00", "2024-03-01T10:00:00Z\u{85}",
      "2026-04-05T11:26:20-0700\u{85}",
    ]
    for key in rejected {
      let bytes = video(mvhd(unix: 1_700_000_000) + meta(creationDate: key))
      XCTAssertEqual(
        VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2023-11-14T22:13:20.000Z", key)
    }
  }

  /// The server's last meta carrying the key decides, even with an unusable
  /// value (its `keysDate` becomes null and it uses mvhd).
  func testAnUnusableKeyInALaterMetaOverridesAnEarlierMetasDate() {
    let bytes = video(
      mvhd(unix: 1_700_000_000) + meta(creationDate: "2024-03-01T10:00:00Z")
        + box("udta", meta(creationDate: "garbage")))
    XCTAssertEqual(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2023-11-14T22:13:20.000Z")
  }

  /// JavaScript reads these in ways the device cannot reproduce; mvhd is the
  /// device's only defensible date — a known mismatch either way.
  func testKeysOnlyJavaScriptReadsAlsoFallBackToMvhd() {
    let javaScriptOnly = [
      "March 1, 2024", "2024-03-01", "2024-03-01T24:00:00Z", "1899-12-31T00:00:00Z",
      "\u{FEFF}2024-03-01T10:00:00Z", "9999-12-31T23:00:00-05:00",
    ]
    for key in javaScriptOnly {
      let bytes = video(mvhd(unix: 1_700_000_000) + meta(creationDate: key))
      XCTAssertEqual(
        VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes), "2023-11-14T22:13:20.000Z", key)
    }
  }

  func testAnMvhdPastYear9999YieldsNoDate() {
    let seconds: UInt64 = 253_402_300_800 + 2_082_844_800
    let time = u32(UInt32(seconds >> 32)) + u32(UInt32(seconds & 0xFFFF_FFFF))
    let bytes = video(box("mvhd", [1, 0, 0, 0] + time + [UInt8](repeating: 0, count: 80)))
    XCTAssertNil(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes))
  }

  func testAHostileSixtyFourBitBoxSizeIsRejectedNotOverflowed() {
    let bytes = Data(
      box("free", []) + u32(1) + Array("mdat".utf8) + [
        0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      ])
    XCTAssertNil(VideoCaptureDate.iso8601UTC(fromVideoBytes: bytes))
  }

  func testFilesWithoutMoovHaveNoDate() {
    XCTAssertNil(VideoCaptureDate.iso8601UTC(fromVideoBytes: Data(box("ftyp", [0, 0, 0, 0]))))
    XCTAssertNil(VideoCaptureDate.iso8601UTC(fromVideoBytes: Data([0x00, 0x01])))
  }
}
