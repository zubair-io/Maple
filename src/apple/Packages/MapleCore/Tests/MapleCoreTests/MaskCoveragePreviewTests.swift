import CoreGraphics
import XCTest

@testable import MapleCore

final class MaskCoveragePreviewTests: XCTestCase {
  private func composed(id: UInt32 = 42) throws -> LocalMask {
    let recipe = BitmapRecipe(
      person: 0, facialSkin: true, bodySkin: true, model: "vision", digest: "0123456789abcdef")
    return .group(
      MaskGroup(
        components: [
          try XCTUnwrap(MaskComponent(mask: .everywhere)),
          try XCTUnwrap(
            MaskComponent(mask: .bitmap(recipe: recipe, rasterId: id), combine: .subtract)),
        ], opacity: 0.5))
  }
  func testBitmapCompositionCoverageAndPreviewAlphaAgree() throws {
    let mask = try composed()
    let rasters: [UInt32: MaskRasterStore.Raster] = [42: (2, 1, [255, 0])]
    XCTAssertEqual(MaskWeight.evaluate(mask, x: 0, y: 0, rasters: rasters), 0)
    XCTAssertEqual(MaskWeight.evaluate(mask, x: 1, y: 0, rasters: rasters), 0.5)
    XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.5, y: 0, rasters: rasters), 0.25)
    let image = try XCTUnwrap(
      MaskCoveragePreview.image(
        mask: mask, imageSize: CGSize(width: 3, height: 1), rasters: rasters))
    let data = try XCTUnwrap(image.dataProvider?.data) as Data
    XCTAssertEqual(Array(data), [0, 0, 0, 0, 64, 64, 64, 64, 128, 128, 128, 128])
  }
  func testMissingMalformedOrZeroHandleMakesWholeGroupInert() throws {
    for rasters: [UInt32: MaskRasterStore.Raster] in [[:], [42: (2, 1, [255])]] {
      let mask = try composed()
      XCTAssertEqual(MaskWeight.evaluate(mask, x: 1, y: 0, rasters: rasters), 0)
    }
    XCTAssertEqual(
      MaskWeight.evaluate(try composed(id: 0), x: 1, y: 0, rasters: [0: (1, 1, [255])]), 0)
  }
  func testPreviewPreservesAspectAndBoundsResolution() throws {
    let image = try XCTUnwrap(
      MaskCoveragePreview.image(
        mask: .everywhere,
        imageSize: CGSize(width: 12000, height: 9000), rasters: [:]))
    XCTAssertEqual(image.width, 512)
    XCTAssertEqual(image.height, 384)
    XCTAssertNil(MaskCoveragePreview.image(mask: .everywhere, imageSize: .zero, rasters: [:]))
  }
}
