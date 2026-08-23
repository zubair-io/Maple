import XCTest
@testable import MapleUI

final class MuiHistogramMathTests: XCTestCase {
    func testEmptySamplesProducesAllZeroBins() {
        XCTAssertEqual(MuiHistogramMath.bin([], binCount: 4), [0, 0, 0, 0])
    }

    func testZeroBinCountReturnsEmptyArray() {
        XCTAssertEqual(MuiHistogramMath.bin([0.2, 0.5], binCount: 0), [])
    }

    func testSamplesLandInExpectedBin() {
        // 4 bins over [0,1]: [0, .25), [.25, .5), [.5, .75), [.75, 1].
        let counts = MuiHistogramMath.bin([0.1, 0.3, 0.6, 0.9], binCount: 4)
        XCTAssertEqual(counts, [1, 1, 1, 1])
    }

    func testExactUpperBoundLandsInLastBinNotOverflow() {
        let counts = MuiHistogramMath.bin([1.0], binCount: 4)
        XCTAssertEqual(counts, [0, 0, 0, 1])
    }

    func testZeroLandsInFirstBin() {
        let counts = MuiHistogramMath.bin([0.0], binCount: 4)
        XCTAssertEqual(counts, [1, 0, 0, 0])
    }

    func testOutOfRangeSamplesAreClampedNotDropped() {
        let counts = MuiHistogramMath.bin([-0.5, 1.5], binCount: 4)
        XCTAssertEqual(counts, [1, 0, 0, 1])
        XCTAssertEqual(counts.reduce(0, +), 2)
    }

    func testDuplicateSamplesAccumulateInTheSameBin() {
        let counts = MuiHistogramMath.bin([0.1, 0.12, 0.14], binCount: 4)
        XCTAssertEqual(counts[0], 3)
    }
}
