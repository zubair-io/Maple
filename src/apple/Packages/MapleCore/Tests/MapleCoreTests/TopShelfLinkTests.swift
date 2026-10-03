import XCTest

@testable import MapleCloudKit

final class TopShelfLinkTests: XCTestCase {
  func test_memoryIDsRoundTripIncludingReservedCharacters() {
    for id in ["memory-123", "a/b?#%", "Summer at the lake", "写真"] {
      let link = TVDeepLink.memory(id: id)
      XCTAssertEqual(TVDeepLink(url: link.url), link)
    }
  }

  func test_unknownDestinationsReturnToMemories() {
    XCTAssertEqual(TVDeepLink(url: URL(string: "maple-tv://memory")!), .memories)
    XCTAssertEqual(TVDeepLink(url: URL(string: "maple-tv://memory/a/b")!), .memories)
    XCTAssertEqual(TVDeepLink(url: URL(string: "maple-tv://retired")!), .memories)
    XCTAssertNil(TVDeepLink(url: URL(string: "https://memory/a")!))
  }
}
