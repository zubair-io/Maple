import XCTest
@testable import MapleCore

final class ScopeSampleCentroidTests: XCTestCase {
    private func singleBinSample(row: Int, col: Int, weight: UInt32) -> ScopeSample {
        var flat = [UInt32](repeating: 0, count: 128 * 128)
        flat[row * 128 + col] = weight
        return ScopeSample.unpack(bins: flat, total: weight, frame: 1)
    }

    func testEmptySampleHasNoCentroid() {
        let empty = ScopeSample.unpack(bins: [UInt32](repeating: 0, count: 128 * 128), total: 0, frame: 1)
        XCTAssertNil(empty.centroidAngleDeg)
    }

    func testACentreBinHasNoCentroidHueIsUndefinedAtZeroChroma() {
        // Bin (64, 64) is the origin (cb=cr=0) — atan2(0,0) is conventionally
        // 0, but a mass concentrated exactly at zero chroma has no meaningful
        // hue; the API still returns SOME angle (0), callers gate on `total`.
        let sample = singleBinSample(row: 64, col: 64, weight: 100)
        XCTAssertEqual(sample.centroidAngleDeg ?? -999, 0, accuracy: 1.0)
    }

    func testAMassOnThePositiveCbAxisReadsZeroDegrees() {
        // Column > 64 at row 64 sits on the +cb axis (cr = 0).
        let sample = singleBinSample(row: 64, col: 100, weight: 100)
        XCTAssertEqual(sample.centroidAngleDeg ?? -999, 0, accuracy: 3.0)
    }

    func testTwoOpposedEqualMassesAverageToTheirMidpointAngle() {
        var flat = [UInt32](repeating: 0, count: 128 * 128)
        // One bin near 0°, one near 60° (both positive-cr side), equal mass —
        // the vector-sum centroid should land near 30°, not the arithmetic
        // mean of raw bin indices (which would be wrong across the wrap).
        flat[64 * 128 + 100] = 100  // ~0°
        flat[27 * 128 + 82] = 100   // ~60° (cb>0, cr>0, |cb|≈|cr|·related)
        let sample = ScopeSample.unpack(bins: flat, total: 200, frame: 1)
        let angle = sample.centroidAngleDeg ?? -999
        XCTAssertGreaterThan(angle, 15)
        XCTAssertLessThan(angle, 45)
    }
}
