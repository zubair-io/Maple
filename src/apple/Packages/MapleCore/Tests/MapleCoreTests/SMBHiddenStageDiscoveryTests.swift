import Foundation
import XCTest

@testable import MapleCore

/// #4309: actual recursive discovery excludes private descendants of the selected root.
final class SMBHiddenStageDiscoveryTests: XCTestCase {
  func testReconnectExcludesHiddenAncestorsButRetainsVisibleNestedPhotos() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let xml = try Data(contentsOf: fixture.share.appendingPathComponent("photo.xmp"))
      let copies = try stageCopies(
        in: fixture,
        paths: [
          "visible/deep/photo.dng", ".maple-copy.tmp/partial.dng",
          "visible/.hidden/nested/photo.dng",
        ])
      await fixture.source.disconnect()
      try await fixture.source.connect(credentials: fixture.credentials)
      let images = try await fixture.source.images()
      let paths = await fixture.source.assets.map(\.path)
      XCTAssertEqual(images.count, 2)
      XCTAssertEqual(
        Set(paths.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }),
        ["photo.dng", "visible/deep/photo.dng"])
      try assertUnchanged(fixture, xml: xml, copies: copies)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testExplicitlySelectedDotNamedRootRetainsItsVisibleDescendants() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let xml = try Data(contentsOf: fixture.share.appendingPathComponent("photo.xmp"))
      let copies = try stageCopies(
        in: fixture,
        paths: [
          ".selected/photo.dng", ".selected/visible/deep/photo.dng",
          ".selected/.hidden/partial.dng",
        ])
      await fixture.source.disconnect()
      try await fixture.source.connect(credentials: fixture.credentials, remotePath: ".selected")
      let images = try await fixture.source.images()
      let paths = await fixture.source.assets.map(\.path)
      XCTAssertEqual(images.count, 2)
      XCTAssertEqual(
        Set(paths.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }),
        [".selected/photo.dng", ".selected/visible/deep/photo.dng"])
      try assertUnchanged(fixture, xml: xml, copies: copies)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  private func stageCopies(in fixture: OwnedSMBWorkflowFixture, paths: [String]) throws -> [URL] {
    try paths.map { path in
      let destination = fixture.share.appendingPathComponent(path)
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: fixture.raw, to: destination)
      return destination
    }
  }

  private func assertUnchanged(_ fixture: OwnedSMBWorkflowFixture, xml: Data, copies: [URL]) throws
  {
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    XCTAssertEqual(try Data(contentsOf: fixture.share.appendingPathComponent("photo.xmp")), xml)
    for copy in copies { XCTAssertEqual(try Data(contentsOf: copy), fixture.original) }
  }
}
