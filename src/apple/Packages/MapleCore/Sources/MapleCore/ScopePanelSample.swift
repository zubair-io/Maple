// ScopePanelSample.swift — the luma waveform, RGB parade and RGB histogram
// reductions of one `ScopeSnapshot` (#3251): the Swift twin of the web's
// `components/scopes/scope-sample.ts`, so the Apple scopes panel plots the
// same columns from the same snapshot contract. Pure and synchronous; the
// view drives it through `ScopePanelReducer` below, off the MainActor and
// off the present path, so a 512 px snapshot never costs the slider tick
// anything.

import Foundation

public struct ScopePanelSample: Sendable, Equatable {
    /// Columns in the waveform / parade plots — the web's `SCOPE_COLUMNS`.
    public static let columns = 64
    /// Bins per channel in the histogram.
    public static let histogramBins = 64

    public let histogramR: [Int]
    public let histogramG: [Int]
    public let histogramB: [Int]
    /// Per-column mean Rec.709 luma, `0...1`.
    public let waveformLuma: [Double]
    /// Per-column mean of each channel, `0...1`.
    public let paradeR: [Double]
    public let paradeG: [Double]
    public let paradeB: [Double]
    /// The scope frame this was reduced from.
    public let frame: UInt64

    private static let lumaR = 0.2126
    private static let lumaG = 0.7152
    private static let lumaB = 0.0722

    /// Reduce `snapshot`. A snapshot with no pixels (or too few bytes for
    /// its dims) reduces to all-zero plots of the requested sizes rather
    /// than NaN columns, matching the web's peak-relative guard.
    public static func reduce(
        _ snapshot: ScopeSnapshot,
        frame: UInt64,
        columns: Int = columns,
        bins: Int = histogramBins
    ) -> ScopePanelSample {
        let width = snapshot.width
        let height = snapshot.height
        var sumR = [Int](repeating: 0, count: columns)
        var sumG = [Int](repeating: 0, count: columns)
        var sumB = [Int](repeating: 0, count: columns)
        var count = [Int](repeating: 0, count: columns)
        var histR = [Int](repeating: 0, count: bins)
        var histG = [Int](repeating: 0, count: bins)
        var histB = [Int](repeating: 0, count: bins)
        if width > 0, height > 0, snapshot.rgb.count >= width * height * 3 {
            // Per-x column index and per-byte-value bin index, both hoisted
            // out of the pixel loop: the reduction visits up to 512 × 512
            // pixels, so a division per channel per pixel is the difference
            // between a cheap background pass and a visible one.
            let columnOf = (0..<width).map { min(columns - 1, $0 * columns / width) }
            let binOf = (0..<256).map { $0 * bins / 256 }
            snapshot.rgb.withUnsafeBufferPointer { px in
                for y in 0..<height {
                    var i = y * width * 3
                    for x in 0..<width {
                        let r = Int(px[i])
                        let g = Int(px[i + 1])
                        let b = Int(px[i + 2])
                        i += 3
                        let c = columnOf[x]
                        sumR[c] += r
                        sumG[c] += g
                        sumB[c] += b
                        count[c] += 1
                        histR[binOf[r]] += 1
                        histG[binOf[g]] += 1
                        histB[binOf[b]] += 1
                    }
                }
            }
        }
        let mean = { (sum: [Int]) -> [Double] in
            (0..<columns).map { count[$0] > 0 ? Double(sum[$0]) / Double(count[$0] * 255) : 0 }
        }
        let r = mean(sumR)
        let g = mean(sumG)
        let b = mean(sumB)
        let luma = (0..<columns).map { lumaR * r[$0] + lumaG * g[$0] + lumaB * b[$0] }
        return ScopePanelSample(
            histogramR: histR, histogramG: histG, histogramB: histB,
            waveformLuma: luma, paradeR: r, paradeG: g, paradeB: b, frame: frame)
    }
}

/// Runs [`ScopePanelSample.reduce`] off the MainActor, one at a time.
///
/// An actor rather than a bare `Task.detached` per frame: a slider drag
/// publishes a new scope sample every present, and a detached task per
/// sample would put several full-frame reductions on the CPU at once,
/// competing with the render for exactly the cores the 16 ms tick needs.
/// Serializing them means at most one is ever in flight; the caller
/// (`EditorScopesPanel`) coalesces to the newest sample rather than
/// queueing one call per frame, so the mid-drag frames a reduction ran
/// past are dropped, not backed up.
public actor ScopePanelReducer {
    public init() {}

    public func reduce(_ snapshot: ScopeSnapshot, frame: UInt64) -> ScopePanelSample {
        ScopePanelSample.reduce(snapshot, frame: frame)
    }
}
