import XCTest

@testable import MapleCore

/// #5849: a Self Hosted timeline or search hit for a RAW carries the JPEG the server folded into
/// it as `stack.companion`, and the timeline and search refs carry it as the listing's do.
final class RawJpegStackSearchHitTests: XCTestCase {
  private let responseJSON = """
    {"total":2,"page":0,"limit":200,"results":[
      {"id":"fs:/srv/photos/Library/Trip/IMG_1.CR3","folder_id":"f1",
       "abs_path":"/srv/photos/Library/Trip/IMG_1.CR3","address":"lib:Trip/IMG_1.CR3",
       "filename":"IMG_1.CR3","size":300,"mtime":1767225600000,"owner_id":null,"owner":null,
       "stack":{"companion":{"id":"0123456789abcdef01234567","name":"IMG_1.JPG",
         "address":"lib:Trip/IMG_1.JPG","path":"/srv/photos/Library/Trip/IMG_1.JPG","size":120,
         "mtime":"2026-01-01T00:00:00.000Z","ext":"jpg"}}},
      {"id":"fs:/srv/photos/Library/Trip/IMG_2.CR3","folder_id":"f1",
       "abs_path":"/srv/photos/Library/Trip/IMG_2.CR3","address":"lib:Trip/IMG_2.CR3",
       "filename":"IMG_2.CR3","size":50,"mtime":1767225600000,"owner_id":null,"owner":null}]}
    """

  private func results() throws -> [SearchAsset] {
    try JSONDecoder().decode(SearchResponse.self, from: Data(responseJSON.utf8)).results
  }

  func testAResponseDecodesTheCompanionOnTheRawHitOnly() throws {
    let results = try results()

    XCTAssertEqual(
      results[0].stack?.companion,
      SearchAssetStackCompanion(
        id: "0123456789abcdef01234567", name: "IMG_1.JPG", address: "lib:Trip/IMG_1.JPG",
        path: "/srv/photos/Library/Trip/IMG_1.JPG", size: 120, mtime: "2026-01-01T00:00:00.000Z",
        ext: "jpg"))
    XCTAssertNil(results[1].stack)
  }

  func testTheHitsStackCarriesBothFilesAndTheCompanionsServerLocation() throws {
    let hit = try XCTUnwrap(results().first)

    let stack = try XCTUnwrap(RawJpegStacking.cloudStack(for: hit))

    XCTAssertEqual(stack.primary, .init(name: "IMG_1.CR3", size: 300))
    XCTAssertEqual(stack.companion, .init(name: "IMG_1.JPG", size: 120))
    XCTAssertEqual(
      stack.location,
      .cloud(
        address: "lib:Trip/IMG_1.JPG", path: "/srv/photos/Library/Trip/IMG_1.JPG",
        id: "0123456789abcdef01234567"))
    XCTAssertEqual(stack.infoRows.map(\.name), ["IMG_1.CR3", "IMG_1.JPG"])
  }

  func testAHitWithoutAStackOrWithAnUnaddressedCompanionCarriesNone() throws {
    let unstacked = try results()[1]
    let unaddressed = SearchAsset(
      id: "fs:/l/IMG_3.NEF", folder_id: "f1", abs_path: "/l/IMG_3.NEF", filename: "IMG_3.NEF",
      size: 9,
      stack: SearchAssetStack(
        companion: SearchAssetStackCompanion(
          id: "jpeg", name: "IMG_3.JPG", address: nil, path: "/l/IMG_3.JPG", size: 4,
          mtime: "2026-01-01T00:00:00.000Z", ext: "jpg")))

    XCTAssertNil(RawJpegStacking.cloudStack(for: unstacked))
    XCTAssertNil(RawJpegStacking.cloudStack(for: unaddressed))
  }

  func testAHitRoundTripsItsStackThroughEncoding() throws {
    let hit = try XCTUnwrap(results().first)

    let decoded = try JSONDecoder().decode(SearchAsset.self, from: JSONEncoder().encode(hit))

    XCTAssertEqual(decoded, hit)
    XCTAssertNotNil(decoded.stack)
  }
}
