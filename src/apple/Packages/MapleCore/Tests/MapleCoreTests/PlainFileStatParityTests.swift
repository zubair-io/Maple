import XCTest

@testable import MapleCore

final class PlainFileStatParityTests: XCTestCase {
  private var scratch: URL!

  override func setUpWithError() throws {
    scratch = FileManager.default.temporaryDirectory
      .appendingPathComponent("plain-file-stat-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: scratch)
  }

  private func foundationStamp(_ path: String) -> String {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
      return "absent"
    }
    let size = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
    let modified =
      (attributes[.modificationDate] as? Date)?.timeIntervalSinceReferenceDate.bitPattern ?? 0
    let fileNumber = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
    return "\(fileNumber):\(size):\(modified)"
  }

  private func plainStamp(_ path: String) -> String {
    guard let stat = PlainFileStat.read(atPath: path) else { return "absent" }
    return
      "\(stat.fileNumber):\(stat.size):\(stat.modified.timeIntervalSinceReferenceDate.bitPattern)"
  }

  private func assertParity(_ path: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(plainStamp(path), foundationStamp(path), path, file: file, line: line)
    let attributes = try? FileManager.default.attributesOfItem(atPath: path)
    XCTAssertEqual(
      PlainFileStat.modificationDate(atPath: path), attributes?[.modificationDate] as? Date,
      path, file: file, line: line)
  }

  private func makeFile(_ name: String, contents: String = "maple") throws -> URL {
    let url = scratch.appendingPathComponent(name)
    try contents.write(to: url, atomically: true, encoding: .utf8)
    return url
  }

  private func setModified(_ url: URL, seconds: Int, nanoseconds: Int) throws {
    var times = [
      timespec(tv_sec: seconds, tv_nsec: nanoseconds),
      timespec(tv_sec: seconds, tv_nsec: nanoseconds),
    ]
    guard utimensat(AT_FDCWD, url.path, &times, AT_SYMLINK_NOFOLLOW) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }

  func testPackageTreeMatchesFoundation() throws {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let enumerator = try XCTUnwrap(FileManager.default.enumerator(atPath: packageRoot.path))
    var checked = 0
    for case let relative as String in enumerator {
      guard relative.hasPrefix("Sources") || relative.hasPrefix("Tests") else {
        enumerator.skipDescendants()
        continue
      }
      let path = packageRoot.appendingPathComponent(relative).path
      let readings = (foundationStamp(path), plainStamp(path), foundationStamp(path))
      if readings.0 == readings.2 {
        XCTAssertEqual(readings.1, readings.0, path)
      } else {
        assertParity(path)
      }
      checked += 1
    }
    XCTAssertGreaterThan(checked, 200)
  }

  func testStressedModificationTimesMatchFoundation() throws {
    let nanosecondValues = [0, 1, 7, 500_000_000, 123_456_789, 999_999_999, 999_999_000, 100]
    let secondValues = [
      -2_000_000_000, -1, 0, 1, 631_152_000, 978_307_199, 978_307_200, 978_307_201,
      1_000_000_000, 1_700_000_000, 1_795_000_000, 4_102_444_800, 32_503_680_000,
    ]
    let url = try makeFile("stressed.bin")
    for seconds in secondValues {
      for nanoseconds in nanosecondValues {
        try setModified(url, seconds: seconds, nanoseconds: nanoseconds)
        assertParity(url.path)
      }
    }
  }

  func testSemiRandomModificationTimesMatchFoundation() throws {
    let url = try makeFile("random.bin")
    var generator = SeededGenerator(state: 0x6078_6078)
    for _ in 0..<3000 {
      let seconds = Int.random(in: -1_000_000_000...4_000_000_000, using: &generator)
      let nanoseconds = Int.random(in: 0..<1_000_000_000, using: &generator)
      try setModified(url, seconds: seconds, nanoseconds: nanoseconds)
      XCTAssertEqual(
        plainStamp(url.path), foundationStamp(url.path), "seconds \(seconds) ns \(nanoseconds)")
    }
  }

  func testSymlinkAndDanglingSymlinkAreStatedWithoutFollowing() throws {
    let target = try makeFile("target.bin", contents: String(repeating: "x", count: 4096))
    let link = scratch.appendingPathComponent("link.bin")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
    let dangling = scratch.appendingPathComponent("dangling.bin")
    try FileManager.default.createSymbolicLink(
      atPath: dangling.path, withDestinationPath: scratch.appendingPathComponent("gone").path)
    assertParity(link.path)
    assertParity(dangling.path)
    XCTAssertNotEqual(plainStamp(link.path), plainStamp(target.path))
    XCTAssertNotEqual(plainStamp(dangling.path), "absent")
  }

  func testDirectoryAndMissingPathMatchFoundation() throws {
    assertParity(scratch.path)
    assertParity(scratch.appendingPathComponent("missing.bin").path)
    XCTAssertEqual(plainStamp(scratch.appendingPathComponent("missing.bin").path), "absent")
  }

  func testLargeExtendedAttributeDoesNotChangeTheStamp() throws {
    let url = try makeFile("tagged.bin")
    let payload = [UInt8](repeating: 0x41, count: 60_000)
    XCTAssertEqual(setxattr(url.path, "app.justmaple.test", payload, payload.count, 0, 0), 0)
    assertParity(url.path)
  }

  func testPathsWithUnicodeSpacesAndPercentCharactersMatchFoundation() throws {
    let names = [
      "caf\u{e9} photo.dng", "cafe\u{301} photo.dng", "100% real %20 name.dng", "日本語 写真.dng",
      "emoji \u{1F4F7}.dng",
    ]
    for name in names {
      let url = try makeFile(name)
      try setModified(url, seconds: 1_600_000_123, nanoseconds: 987_654_321)
      assertParity(url.path)
      let viaURL = URL(fileURLWithPath: url.path)
      assertParity(viaURL.path)
      XCTAssertNotEqual(plainStamp(viaURL.path), "absent")
    }
    let folder = scratch.appendingPathComponent("dir with 100% and spaces")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let nested = folder.appendingPathComponent("in side.dng")
    try "x".write(to: nested, atomically: true, encoding: .utf8)
    assertParity(nested.path)
  }

  func testSourceSignatureMatchesTheFoundationFormat() throws {
    let asset = try makeFile("frame.dng")
    try setModified(asset, seconds: 1_650_000_000, nanoseconds: 333_333_333)
    let withoutSidecar = LocalDerivativeSourceStamp.signature(for: asset)
    XCTAssertEqual(withoutSidecar, "source-v1|\(foundationStamp(asset.path))|absent")

    let sidecar = SidecarPath.sidecarURL(for: asset)
    try "<x/>".write(to: sidecar, atomically: true, encoding: .utf8)
    try setModified(sidecar, seconds: 1_650_000_001, nanoseconds: 1)
    XCTAssertEqual(
      LocalDerivativeSourceStamp.signature(for: asset),
      "source-v1|\(foundationStamp(asset.path))|\(foundationStamp(sidecar.path))")
  }

  func testUnrepresentablePathsMatchFoundation() {
    let paths = ["", "bad\0name", "/" + String(repeating: "a", count: 2000), "relative-missing"]
    for path in paths {
      assertParity(path)
      XCTAssertEqual(plainStamp(path), "absent")
    }
  }
}

private struct SeededGenerator: RandomNumberGenerator {
  var state: UInt64

  mutating func next() -> UInt64 {
    state = state &+ 0x9E37_79B9_7F4A_7C15
    var mixed = state
    mixed = (mixed ^ (mixed >> 30)) &* 0xBF58_476D_1CE4_E5B9
    mixed = (mixed ^ (mixed >> 27)) &* 0x94D0_49BB_1331_11EB
    return mixed ^ (mixed >> 31)
  }
}
