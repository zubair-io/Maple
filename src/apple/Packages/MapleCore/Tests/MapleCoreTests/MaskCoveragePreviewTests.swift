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
  func testPresentedTintSamplesTheMaskThroughGeometryOffset() throws {
    let mask = LocalMask.radial(
      center: MaskPoint(x: 0.25, y: 0.5), radii: MaskPoint(x: 0.1, y: 0.1),
      angle: 0, feather: 0, invert: false)
    let projection = MaskProjection.presentationToFrame(
      crop: .identity, perspective: Perspective(x: 50),
      nativeSize: CGSize(width: 400, height: 300))
    let image = try XCTUnwrap(
      MaskCoveragePreview.image(
        mask: mask, imageSize: CGSize(width: 5, height: 5), rasters: [:],
        projection: projection))
    let data = try XCTUnwrap(image.dataProvider?.data) as Data
    let centre = (2 * 5 + 2) * 4
    XCTAssertEqual(data[centre], 255)
    XCTAssertEqual(data[0], 0)
  }
  func testPresentedTintClearsCoverageOutsideTheProjectedFrame() throws {
    let recipe = BitmapRecipe(
      person: 0, facialSkin: true, bodySkin: true, model: "vision", digest: "0123456789abcdef")
    let mask = LocalMask.bitmap(recipe: recipe, rasterId: 7)
    let projection = MaskProjection.presentationToFrame(
      crop: .identity, perspective: Perspective(x: 50),
      nativeSize: CGSize(width: 400, height: 300))
    let image = try XCTUnwrap(
      MaskCoveragePreview.image(
        mask: mask, imageSize: CGSize(width: 5, height: 5), rasters: [7: (1, 1, [255])],
        projection: projection))
    let data = try XCTUnwrap(image.dataProvider?.data) as Data
    XCTAssertEqual(data[0], 0)
    XCTAssertEqual(data[(2 * 5 + 4) * 4], 255)
  }
  func testStraightenedCropCornerStaysClearWhenGeometryScalesUp() throws {
    let crop = Crop(top: 0, left: 0, bottom: 1, right: 1, angle: 10)
    let size = CGSize(width: 400, height: 400)
    let point = MaskPoint(x: 0.01, y: 0.01)
    let intermediate = MaskAffine.cropToFullFrame(crop, nativeSize: size).apply(point)
    XCTAssertEqual(intermediate.x, -0.068, accuracy: 0.001)
    XCTAssertEqual(intermediate.y, 0.103, accuracy: 0.001)
    let projection = MaskProjection.presentationToFrame(
      crop: crop, perspective: Perspective(scale: 150), nativeSize: size)
    XCTAssertNil(projection.apply(point))
    let image = try XCTUnwrap(
      MaskCoveragePreview.image(
        mask: .everywhere, imageSize: CGSize(width: 51, height: 51),
        rasters: [:], projection: projection))
    let data = try XCTUnwrap(image.dataProvider?.data) as Data
    XCTAssertEqual(data[0], 0)
    XCTAssertEqual(data[(25 * 51 + 25) * 4], 255)
  }
}
