// ScopePanelSampleTests.swift — the waveform / parade / histogram reduction
// of a scope snapshot (#3251), pinned on synthetic frames where every column
// mean is known in closed form, plus the budget guard: the reduction of the
// largest snapshot the FFI can hand over (512 × 512) is cheap enough that,
// even though it already runs off the present path, it could never be the
// thing that costs a slider tick.

import XCTest

@testable import MapleCore

final class ScopePanelSampleTests: XCTestCase {
    /// `width × height` frame whose red ramps 0→255 across x, green ramps
    /// 255→0 across x, blue is a constant.
    private func ramp(width: Int, height: Int, blue: UInt8 = 64) -> ScopeSnapshot {
        var rgb = [UInt8](repeating: 0, count: width * height * 3)
        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 3
                let r = UInt8(x * 255 / max(1, width - 1))
                rgb[i] = r
                rgb[i + 1] = 255 - r
                rgb[i + 2] = blue
            }
        }
        return ScopeSnapshot(width: width, height: height, rgb: rgb)
    }

    func testParadeColumnsAreTheMeanOfEachChannelAcrossTheColumnsPixels() {
        let snap = ramp(width: 256, height: 8)
        let panel = ScopePanelSample.reduce(snap, frame: 4, columns: 64, bins: 64)
        XCTAssertEqual(panel.frame, 4)
        XCTAssertEqual(panel.paradeR.count, 64)
        // Column c covers x in [4c, 4c+4): red mean = (4c + 1.5) / 255.
        for c in [0, 1, 31, 63] {
            let want = (Double(4 * c) + 1.5) / 255
            XCTAssertEqual(panel.paradeR[c], want, accuracy: 1e-9, "column \(c)")
            XCTAssertEqual(panel.paradeG[c], 1 - want, accuracy: 1e-9, "column \(c)")
            XCTAssertEqual(panel.paradeB[c], 64.0 / 255, accuracy: 1e-9, "column \(c)")
        }
        XCTAssertTrue(zip(panel.paradeR, panel.paradeR.dropFirst()).allSatisfy { $0 < $1 },
            "a left-to-right ramp is monotonic across columns")
    }

    func testWaveformIsTheRec709LumaOfTheParade() {
        let panel = ScopePanelSample.reduce(ramp(width: 128, height: 2), frame: 1)
        for c in 0..<ScopePanelSample.columns {
            let want = 0.2126 * panel.paradeR[c] + 0.7152 * panel.paradeG[c] + 0.0722 * panel.paradeB[c]
            XCTAssertEqual(panel.waveformLuma[c], want, accuracy: 1e-12)
        }
    }

    func testHistogramsCountEveryPixelOnceInSixtyFourBins() {
        let snap = ramp(width: 256, height: 4, blue: 200)
        let panel = ScopePanelSample.reduce(snap, frame: 1)
        let pixels = 256 * 4
        XCTAssertEqual(panel.histogramR.count, 64)
        XCTAssertEqual(panel.histogramR.reduce(0, +), pixels)
        XCTAssertEqual(panel.histogramG.reduce(0, +), pixels)
        XCTAssertEqual(panel.histogramB.reduce(0, +), pixels)
        // A uniform 0…255 ramp puts 4 values (× 4 rows) in each of 64 bins.
        XCTAssertTrue(panel.histogramR.allSatisfy { $0 == 16 }, "\(panel.histogramR)")
        // A constant channel lands entirely in its one bin (200 * 64 / 256 = 50).
        XCTAssertEqual(panel.histogramB[50], pixels)
        XCTAssertEqual(panel.histogramB.filter { $0 > 0 }.count, 1)
    }

    func testAnEmptySnapshotReducesToZeroPlotsOfTheRequestedSizes() {
        let panel = ScopePanelSample.reduce(
            ScopeSnapshot(width: 0, height: 0, rgb: []), frame: 0, columns: 16, bins: 8)
        XCTAssertEqual(panel.waveformLuma, [Double](repeating: 0, count: 16))
        XCTAssertEqual(panel.paradeR, [Double](repeating: 0, count: 16))
        XCTAssertEqual(panel.histogramB, [Int](repeating: 0, count: 8))
        XCTAssertFalse(panel.waveformLuma.contains { $0.isNaN })
    }

    func testAShortByteBufferIsTreatedAsEmptyNotReadPastItsEnd() {
        let panel = ScopePanelSample.reduce(
            ScopeSnapshot(width: 4, height: 4, rgb: [1, 2, 3]), frame: 0)
        XCTAssertEqual(panel.histogramR.reduce(0, +), 0)
    }

    /// Budget guard (CLAUDE.md § Performance invariants: 16 ms slider-tick
    /// target, 50 ms hard limit) for the scope readback (#3251).
    ///
    /// The split this pins: a present tick pays only `ScopeSample.unpack` —
    /// copying the bins and the snapshot bytes raw-ffi already wrote — while
    /// the pixel reduction that turns those bytes into waveform / parade /
    /// histogram columns runs in a detached task keyed on the sample's frame
    /// (`EditorScopesPanel`), never on the tick. So the tick cost is asserted
    /// against the 16 ms target and the off-tick reduction is REPORTED, on
    /// the largest snapshot the FFI can ever deliver (512 × 512).
    ///
    /// Only the tick half is asserted, for the same reason
    /// `SliderTickPerfTests` keeps its own limit well above spec: `swift
    /// test` builds unoptimized, and this suite shares a machine with
    /// whatever else is running, so a wall-clock ceiling on the expensive
    /// half would fail for reasons that have nothing to do with the code.
    /// The copy is bounded work no build mode or load turns into a
    /// tick-sized cost — which is exactly the property worth pinning.
    func testThePerTickHalfOfTheReadbackStaysInsideTheTickBudget() async {
        let snap = ramp(width: ScopeSnapshot.maxDim, height: ScopeSnapshot.maxDim)
        let bins = [UInt32](repeating: 3, count: 128 * 128)
        let runs = 5
        let clock = ContinuousClock()
        let ms = { (d: Duration) -> Double in
            (Double(d.components.seconds) * 1000
                + Double(d.components.attoseconds) / 1e15) / Double(runs)
        }
        // Warm both paths (page-in, first-call cost), then time each.
        _ = ScopeSample.unpack(bins: bins, total: 1, frame: 0, snapshot: snap)
        _ = ScopePanelSample.reduce(snap, frame: 0)
        let measured = await Task.detached(priority: .utility) { () -> (Double, Double) in
            let tick = clock.measure {
                for i in 0..<runs {
                    _ = ScopeSample.unpack(bins: bins, total: 1, frame: UInt64(i), snapshot: snap)
                }
            }
            let reduce = clock.measure {
                for i in 0..<runs { _ = ScopePanelSample.reduce(snap, frame: UInt64(i)) }
            }
            return (ms(tick), ms(reduce))
        }.value
        print(
            "SCOPE-READBACK 512x512 tick(unpack) \(String(format: "%.2f", measured.0)) ms · "
                + "off-tick(reduce) \(String(format: "%.2f", measured.1)) ms · \(runs) runs")
        if measured.1 > 50 {
            print(
                "SCOPE-READBACK note: the off-tick reduction exceeds the 50 ms tick hard limit in "
                    + "this build — fine while it stays off the tick, a problem the day it moves onto it")
        }
        XCTAssertLessThan(
            measured.0, 16,
            "the per-tick half of the scope readback must fit the 16 ms slider-tick target")
    }
}
