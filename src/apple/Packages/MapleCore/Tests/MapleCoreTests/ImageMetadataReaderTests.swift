import XCTest
@testable import MapleCore

final class ImageMetadataReaderTests: XCTestCase {
    func testOrientedPixelSizeKeepsLandscapeOrientation() {
        let size = ImageMetadataReader.orientedPixelSize(
            width: 6000,
            height: 4000,
            orientationValue: 1
        )

        XCTAssertEqual(size.width, 6000, accuracy: 0.01)
        XCTAssertEqual(size.height, 4000, accuracy: 0.01)
    }

    func testOrientedPixelSizeSwapsPortraitOrientation() {
        let size = ImageMetadataReader.orientedPixelSize(
            width: 6000,
            height: 4000,
            orientationValue: 6
        )

        XCTAssertEqual(size.width, 4000, accuracy: 0.01)
        XCTAssertEqual(size.height, 6000, accuracy: 0.01)
    }
}
