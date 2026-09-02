// SMBFileOperationsListingTests.swift — non-recursive subfolder listing
// for the SMB sidebar tree (#2697), against the in-memory `FakeSMBTransport`.
//
// `FakeSMBTransport.contentsOfDirectory` ignores the `recursive` flag
// entirely and always returns every descendant — so these tests are the
// only thing pinning that `SMBFileOperations.listSubdirectories` correctly
// narrows that down to DIRECT children itself, rather than trusting the
// transport to have already filtered (see that function's doc comment for
// why it self-filters).

import XCTest
@testable import MapleCore

final class SMBFileOperationsListingTests: XCTestCase {

  func testReturnsOnlyDirectChildDirectories() async throws {
    let t = FakeSMBTransport()
    await t.seed("a", at: "/2024/Paris/IMG_1.dng")
    await t.seed("b", at: "/2025/Tokyo/IMG_2.dng")

    let entries = try await SMBFileOperations.listSubdirectories(at: "/", transport: t)

    XCTAssertEqual(Set(entries.map(\.name)), ["2024", "2025"])
    XCTAssertFalse(
      entries.contains { $0.name == "Paris" || $0.name == "Tokyo" },
      "grandchildren must not appear in a non-recursive listing")
  }

  func testExcludesFiles() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/2024/IMG_1.dng")

    let entries = try await SMBFileOperations.listSubdirectories(at: "/2024", transport: t)

    XCTAssertTrue(entries.isEmpty, "a file must never surface as a subdirectory entry")
  }

  func testExcludesDotDirectories() async throws {
    let t = FakeSMBTransport()
    try await t.createDirectory(atPath: "/.maple")
    await t.seed("a", at: "/Album/IMG_1.dng")

    let entries = try await SMBFileOperations.listSubdirectories(at: "/", transport: t)

    XCTAssertEqual(entries.map(\.name), ["Album"])
  }

  func testEmptyForALeafDirectory() async throws {
    let t = FakeSMBTransport()
    await t.seed("a", at: "/Album/IMG_1.dng")

    let entries = try await SMBFileOperations.listSubdirectories(at: "/Album", transport: t)

    XCTAssertTrue(entries.isEmpty)
  }

  func testSortsCaseInsensitivelyByName() async throws {
    let t = FakeSMBTransport()
    await t.seed("a", at: "/banana/IMG_1.dng")
    await t.seed("b", at: "/Apple/IMG_2.dng")
    await t.seed("c", at: "/cherry/IMG_3.dng")

    let entries = try await SMBFileOperations.listSubdirectories(at: "/", transport: t)

    XCTAssertEqual(entries.map(\.name), ["Apple", "banana", "cherry"])
  }

  func testEntryPathIsShareRelative() async throws {
    let t = FakeSMBTransport()
    await t.seed("a", at: "/2024/Paris/IMG_1.dng")

    let entries = try await SMBFileOperations.listSubdirectories(at: "/", transport: t)

    XCTAssertEqual(entries.first?.path, "/2024")
  }

  /// Copilot review, #2697: `localizedStandardCompare` alone answers
  /// `.orderedSame` for names differing only by case, which isn't a
  /// strict ordering on its own — pins that the comparator breaks that
  /// tie deterministically (on `path`) instead of leaving relative order
  /// to depend on whatever order the transport happened to return them in.
  func testBreaksCaseInsensitiveTiesDeterministicallyByPath() async throws {
    let t = FakeSMBTransport()
    await t.seed("a", at: "/Album/IMG_1.dng")
    await t.seed("b", at: "/album/IMG_2.dng")

    let entries = try await SMBFileOperations.listSubdirectories(at: "/", transport: t)

    XCTAssertEqual(entries.map(\.path), ["/album", "/Album"], "Swift's String < ranks lowercase before uppercase")
  }
}
