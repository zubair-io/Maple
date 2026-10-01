import CoreImage
import Observation
import XCTest

@testable import MapleCore

@MainActor
final class DevelopedImageRevisionTests: XCTestCase {
  func testEditedBytesBypassTheStableIdDecodeCache() async throws {
    let revisions = DevelopedImageRevision()
    let url = URL(fileURLWithPath: "/photos/test_0002.dng")
    let id = UUID().uuidString
    let oldBytes = try encodedImage(size: 8)
    let editedBytes = try encodedImage(size: 16)
    let originalKey = revisions.decodedKey(for: id, url: url)
    let original = await ThumbnailDecoder.image(for: oldBytes, key: originalKey)
    let stale = await ThumbnailDecoder.image(for: editedBytes, key: originalKey)
    XCTAssertTrue(original === stale, "Stable asset IDs alone retain pre-edit pixels")

    revisions.didPersist(for: url)
    let edited = await ThumbnailDecoder.image(
      for: editedBytes, key: revisions.decodedKey(for: id, url: url))
    XCTAssertEqual(edited?.width, 16)
    XCTAssertEqual(original?.width, 8)
    XCTAssertFalse(original === edited)
  }

  func testSaveChangesOnlyTheEditedFilesLoadIdentity() {
    let revisions = DevelopedImageRevision()
    let first = URL(fileURLWithPath: "/first/IMG.dng")
    let second = URL(fileURLWithPath: "/second/IMG.dng")
    let changed = expectation(description: "Retained SwiftUI image observes save")
    withObservationTracking {
      _ = revisions.revision(for: first)
    } onChange: {
      changed.fulfill()
    }
    revisions.didPersist(for: first)
    XCTAssertEqual(revisions.revision(for: first), 1)
    XCTAssertEqual(revisions.revision(for: second), 0)
    XCTAssertEqual(revisions.decodedKey(for: "cloud", url: nil), "cloud")
    wait(for: [changed], timeout: 1)
  }

  private func encodedImage(size: Int) throws -> Data {
    let image = CIImage(color: .red).cropped(
      to: CGRect(x: 0, y: 0, width: size, height: size))
    return try XCTUnwrap(ThumbnailEncoder.encode(image, ctx: CIContext()))
  }
}
