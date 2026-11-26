#if os(iOS)
  import MapleCore
  import XCTest

  @testable import Maple

  final class PhoneBatchExportRequestTests: XCTestCase {
    func testRequestCarriesEverySelectedPhotoInOrder() throws {
      let assets = ["a", "b", "c"].map {
        AssetRef(url: URL(fileURLWithPath: "/Photos/\($0).dng"))
      }
      let request = try XCTUnwrap(PhoneBatchExportRequest(assets: assets))
      XCTAssertEqual(request.assets.map(\.id), assets.map(\.id))
    }

    func testEmptySelectionProducesNoRequest() {
      XCTAssertNil(PhoneBatchExportRequest(assets: []))
    }

    func testEachRequestIsADistinctPresentation() throws {
      let assets = [AssetRef(url: URL(fileURLWithPath: "/Photos/a.dng"))]
      let first = try XCTUnwrap(PhoneBatchExportRequest(assets: assets))
      let second = try XCTUnwrap(PhoneBatchExportRequest(assets: assets))
      XCTAssertNotEqual(first.id, second.id)
    }
  }
#endif
