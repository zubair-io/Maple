import CoreImage
import XCTest

@testable import MapleCore

final class GpuPrescaledExtentTests: XCTestCase {
  func testDimensionOnlyQueryMatchesActualLanczosCrop() {
    let pipeline = ImageEditPipeline()
    let extents = [
      CGRect(x: 0, y: 0, width: 12288, height: 8192),
      CGRect(x: 0, y: 0, width: 8688, height: 5792),
      CGRect(x: 0, y: 0, width: 801, height: 1203),
      CGRect(x: 7.25, y: -3.5, width: 1001, height: 667),
      CGRect(x: -17, y: 9, width: 1001.25, height: 667.5),
    ]
    for extent in extents {
      let decoded = CIImage(color: CIColor(red: 0.1, green: 0.2, blue: 0.3))
        .cropped(to: extent)
      let targets: [CGSize?] = [
        nil, extent.size,
        CGSize(width: extent.width * 2, height: extent.height * 2),
        CGSize(width: extent.width * 0.99, height: extent.height * 0.99),
        CGSize(width: extent.width * 0.9899, height: extent.height * 0.9899),
        CGSize(width: 1920, height: 1280), CGSize(width: 1500, height: 1500),
        CGSize(width: 200.5, height: 101.25), CGSize(width: 1, height: 1), .zero,
      ]
      for target in targets {
        let expected = ImageEditPipeline.prescaleForDisplay(decoded, targetSize: target).extent
        let actual = pipeline.prescaledExtent(of: decoded, targetSize: target)
        XCTAssertEqual(actual, expected, "source=\(extent), target=\(String(describing: target))")
      }
    }
    let empty = CIImage.empty()
    XCTAssertEqual(
      pipeline.prescaledExtent(of: empty, targetSize: CGSize(width: 100, height: 100)), empty.extent
    )
  }

  func testMetadataDimensionsMatchMaterializedUpload() throws {
    let pipeline = ImageEditPipeline()
    let decoded = CIImage(color: CIColor(red: 0.1, green: 0.2, blue: 0.3))
      .cropped(to: CGRect(x: 0, y: 0, width: 1001, height: 667))
    let target = CGSize(width: 96, height: 64)
    let extent = pipeline.prescaledExtent(of: decoded, targetSize: target)
    let upload = try XCTUnwrap(pipeline.sceneLinearFloats(from: decoded, targetSize: target))
    XCTAssertEqual(upload.width, Int(extent.width.rounded()))
    XCTAssertEqual(upload.height, Int(extent.height.rounded()))
    XCTAssertEqual(upload.pixels.count, upload.width * upload.height * 4)
    XCTAssertTrue(upload.pixels.allSatisfy(\.isFinite))
    XCTAssertGreaterThan(upload.pixels[0], 0)
  }
}
