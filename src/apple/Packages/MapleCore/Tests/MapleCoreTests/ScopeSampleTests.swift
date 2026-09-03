import XCTest

@testable import MapleCore

final class ScopeSampleTests: XCTestCase {
    func testUnpackReshapesTheFlatBinsIntoARowMajor128x128Grid() {
        var flat = [UInt32](repeating: 0, count: 128 * 128)
        flat[0] = 5
        flat[128 * 64 + 64] = 900
        let sample = ScopeSample.unpack(bins: flat, total: 905, frame: 3)
        XCTAssertEqual(sample.bins[0][0], 5)
        XCTAssertEqual(sample.bins[64][64], 900)
        XCTAssertEqual(sample.total, 905)
        XCTAssertEqual(sample.frame, 3)
    }
}
