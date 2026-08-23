// MuiHistogramMath.swift — pure binning math for MuiHistogram
// (unified-component-catalog.md §2.6). The web reference's histogram
// component takes already-binned per-channel count arrays; MuiHistogram
// additionally accepts raw 0...1 samples (e.g. a fixture's per-pixel
// values) and bins them itself so a caller — or the gallery's fixed sample
// data — never has to hand-roll a binning loop.

import Foundation

enum MuiHistogramMath {
    /// Buckets `samples` (each expected in `[0, 1]`; out-of-range values
    /// are clamped rather than dropped) into `binCount` equal-width bins
    /// and returns each bin's count. A sample of exactly `1.0` lands in the
    /// last bin rather than overflowing into a phantom `binCount`th bucket.
    /// Returns an empty array for `binCount <= 0`.
    static func bin(_ samples: [Double], binCount: Int) -> [Int] {
        guard binCount > 0 else { return [] }
        var counts = [Int](repeating: 0, count: binCount)
        for sample in samples {
            let clamped = Swift.max(0, Swift.min(1, sample))
            let index = clamped >= 1 ? binCount - 1 : Int(clamped * Double(binCount))
            counts[index] += 1
        }
        return counts
    }
}
