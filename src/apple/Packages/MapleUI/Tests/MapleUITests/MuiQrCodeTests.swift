import XCTest
@testable import MapleUI

final class MuiQrCodeTests: XCTestCase {
    func testGeneratesANonNilImageForAPayload() {
        let image = MuiQrCode.generateCGImage(value: "https://maple.app/pair/abc123", pixelSize: 128)
        XCTAssertNotNil(image)
    }

    func testGeneratedImageIsCloseToTheRequestedPixelSize() {
        // CoreImage's extent-to-pixel rounding can land within a pixel or
        // two of the requested size — assert "close", not bit-exact.
        guard let image = MuiQrCode.generateCGImage(value: "https://maple.app/pair/abc123", pixelSize: 96) else {
            XCTFail("expected a non-nil image")
            return
        }
        XCTAssertEqual(Double(image.width), 96, accuracy: 2)
        XCTAssertEqual(Double(image.height), 96, accuracy: 2)
    }

    func testEmptyPayloadReturnsNil() {
        let image = MuiQrCode.generateCGImage(value: "", pixelSize: 128)
        XCTAssertNil(image)
    }

    func testZeroPixelSizeReturnsNil() {
        let image = MuiQrCode.generateCGImage(value: "https://maple.app", pixelSize: 0)
        XCTAssertNil(image)
    }

    func testLongPayloadStillGeneratesAnImage() {
        let longValue = String(repeating: "a", count: 400)
        let image = MuiQrCode.generateCGImage(value: longValue, pixelSize: 128)
        XCTAssertNotNil(image)
    }
}
