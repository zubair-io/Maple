// SMBSourceDiscoveryTests.swift — unit tests for SMB recursive library discovery
// filtering private staging directories and hidden subfolders (#4309).

import XCTest

@testable import MapleCore

final class SMBSourceDiscoveryTests: XCTestCase {

  func testExcludesPrivateStagingDirectoriesAtShareRoot() {
    let root = "/"
    let stagingPath = "/.maple-copy.tmp.control/test.dng"
    let visiblePath = "/Photos/test.dng"

    XCTAssertTrue(
      SMBSource.hasHiddenPathComponent(in: stagingPath, relativeTo: root),
      "Private staging directory at share root must be excluded from discovery"
    )
    XCTAssertFalse(
      SMBSource.hasHiddenPathComponent(in: visiblePath, relativeTo: root),
      "Normal RAW at root must not be excluded"
    )
  }

  func testExcludesNestedPrivateStagingDirectories() {
    let root = "/"
    let nestedStaging = "/Photos/2026/.maple-copy.tmp.control/test.dng"
    let nestedVisible = "/Photos/2026/Summer/test.dng"

    XCTAssertTrue(
      SMBSource.hasHiddenPathComponent(in: nestedStaging, relativeTo: root),
      "Nested private staging directory must be excluded"
    )
    XCTAssertFalse(
      SMBSource.hasHiddenPathComponent(in: nestedVisible, relativeTo: root),
      "Nested visible subfolder must be preserved"
    )
  }

  func testExcludesDotfilesInAnyDirectory() {
    let root = "/Photos"
    let dotfile = "/Photos/.DS_Store"
    let dotRaw = "/Photos/2026/._IMG_0001.dng"
    let visible = "/Photos/2026/IMG_0001.dng"

    XCTAssertTrue(SMBSource.hasHiddenPathComponent(in: dotfile, relativeTo: root))
    XCTAssertTrue(SMBSource.hasHiddenPathComponent(in: dotRaw, relativeTo: root))
    XCTAssertFalse(SMBSource.hasHiddenPathComponent(in: visible, relativeTo: root))
  }

  func testPreservesSourceRootedInsideDotNamedDirectory() {
    let root = "/.vault"
    let visibleUnderDotRoot = "/.vault/2026/IMG_0001.dng"
    let stagingUnderDotRoot = "/.vault/.maple-copy.tmp.control/IMG_0001.dng"
    let dotfileUnderDotRoot = "/.vault/2026/.DS_Store"

    XCTAssertFalse(
      SMBSource.hasHiddenPathComponent(in: visibleUnderDotRoot, relativeTo: root),
      "A source rooted inside a dot-named directory must preserve visible children below that root"
    )
    XCTAssertTrue(
      SMBSource.hasHiddenPathComponent(in: stagingUnderDotRoot, relativeTo: root),
      "Private staging directory below a dot-named root must still be excluded"
    )
    XCTAssertTrue(
      SMBSource.hasHiddenPathComponent(in: dotfileUnderDotRoot, relativeTo: root),
      "Dotfiles below a dot-named root must still be excluded"
    )
  }

  func testHandlesVariousSlashNormalizations() {
    // Both root and fullPath with trailing/leading slashes
    XCTAssertFalse(
      SMBSource.hasHiddenPathComponent(in: "Photos/2026/img.raw", relativeTo: "Photos")
    )
    XCTAssertFalse(
      SMBSource.hasHiddenPathComponent(in: "/Photos/2026/img.raw", relativeTo: "/Photos/")
    )
    XCTAssertTrue(
      SMBSource.hasHiddenPathComponent(in: "/Photos/.hidden/img.raw", relativeTo: "/Photos/")
    )
    XCTAssertFalse(
      SMBSource.hasHiddenPathComponent(in: "img.dng", relativeTo: "")
    )
    XCTAssertTrue(
      SMBSource.hasHiddenPathComponent(in: ".staging/img.dng", relativeTo: "")
    )
  }
}
