// GpuPreviewPersistTests — the pure CIImage builder behind the #1665 GPU-live
// preview-cache populate. The readback + persist plumbing needs a GPU device +
// actors (covered by on-device verification); this pins the format contract of
// `ciImageFromGpuRgb`: size validation, dimensions, and channel preservation
// (so an R/B swap or a broken RGB→RGBA expansion fails here, not on a device).

import XCTest
import CoreImage
@testable import MapleCore

final class GpuPreviewPersistTests: XCTestCase {
    /// A `count != width·height·3` buffer (or a degenerate size) yields nil — the
    /// caller then leaves the cache unpopulated rather than building a garbage image.
    func testRejectsSizeMismatch() {
        XCTAssertNil(EditSession.ciImageFromGpuRgb([0, 0, 0], width: 2, height: 2),
                     "2x2 needs 12 bytes; 3 must be rejected")
        XCTAssertNil(EditSession.ciImageFromGpuRgb([], width: 0, height: 0),
                     "degenerate 0x0 must be rejected")
        XCTAssertNil(EditSession.ciImageFromGpuRgb([1, 2, 3, 4, 5, 6], width: 3, height: 1),
                     "3x1 needs 9 bytes; 6 must be rejected")
    }

    /// A valid `width·height·3` buffer builds a CIImage of exactly those dims.
    func testBuildsCorrectlySizedImage() {
        let w = 3, h = 2
        let rgb = [UInt8](repeating: 128, count: w * h * 3)
        guard let ci = EditSession.ciImageFromGpuRgb(rgb, width: w, height: h) else {
            return XCTFail("expected a CIImage for a valid w*h*3 buffer")
        }
        XCTAssertEqual(ci.extent.width, CGFloat(w))
        XCTAssertEqual(ci.extent.height, CGFloat(h))
    }

    /// The RGB channels survive the RGBA expansion + sRGB tag (catches an R/B
    /// swap or a stride bug): render the 1×1 image back to sRGB RGBA8 and compare.
    func testPreservesChannels() {
        let rgb: [UInt8] = [10, 200, 60]
        guard let ci = EditSession.ciImageFromGpuRgb(rgb, width: 1, height: 1) else {
            return XCTFail("nil image for valid 1x1 input")
        }
        let ctx = CIContext(options: [.workingColorSpace: NSNull()])
        var out = [UInt8](repeating: 0, count: 4)
        out.withUnsafeMutableBytes { ptr in
            ctx.render(
                ci, toBitmap: ptr.baseAddress!, rowBytes: 4, bounds: ci.extent,
                format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!
            )
        }
        XCTAssertEqual(Double(out[0]), 10, accuracy: 2, "R preserved")
        XCTAssertEqual(Double(out[1]), 200, accuracy: 2, "G preserved")
        XCTAssertEqual(Double(out[2]), 60, accuracy: 2, "B preserved")
        XCTAssertEqual(Double(out[3]), 255, accuracy: 1, "alpha opaque")
    }
}
