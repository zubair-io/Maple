import RawPipeline
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
        XCTAssertNil(sample.snapshot, "no snapshot unless the producer bound one")
    }

    func testUnpackCarriesTheSnapshotOfTheSameFrame() {
        let flat = [UInt32](repeating: 0, count: 128 * 128)
        let snap = ScopeSnapshot(width: 2, height: 1, rgb: [1, 2, 3, 4, 5, 6])
        let sample = ScopeSample.unpack(bins: flat, total: 0, frame: 9, snapshot: snap)
        XCTAssertEqual(sample.snapshot, snap)
        XCTAssertEqual(sample.frame, 9)
    }

    /// The FFI reports `0 × 0` when it did not copy bytes (null / too-small
    /// host buffer); the Swift side must then hand back `nil`, never a
    /// snapshot whose dims outrun its bytes.
    func testSnapshotUnpackTrustsOnlyDimsBackedByBytes() {
        var stats = MapleScopeStats()
        let buffer = [UInt8](repeating: 7, count: 12)
        XCTAssertNil(ScopeSnapshot.unpack(stats, from: buffer), "0 × 0 means nothing landed")

        stats.snapshot_width = 2
        stats.snapshot_height = 2
        let got = try? XCTUnwrap(ScopeSnapshot.unpack(stats, from: buffer))
        XCTAssertEqual(got?.rgb.count, 12)
        XCTAssertEqual(got?.width, 2)

        stats.snapshot_width = 3
        XCTAssertNil(
            ScopeSnapshot.unpack(stats, from: buffer),
            "dims claiming more bytes than the buffer holds are rejected")
    }

    func testSnapshotClampMirrorsTheFfiHeader() {
        XCTAssertEqual(ScopeSnapshot.maxDim, 512)
        XCTAssertEqual(ScopeSnapshot.bufferByteCount, 512 * 512 * 3)
    }
}
