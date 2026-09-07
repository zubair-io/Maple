// ScopeSample+Centroid.swift — the weighted mean chroma angle of a scope
// sample, in the SAME broadcast-graticule convention (0° = +cb axis, CCW)
// MuiVectorscopeMath uses (#3279, spec §8's objective demo assertion).
//
// Vector-sum, not an arithmetic mean of bin angles: averaging angles
// directly is wrong across the ±180° wrap (0° and 359° would average to
// ~180°, the opposite direction from either). Summing unit vectors weighted
// by bin mass and taking the angle of the RESULTANT avoids that — the
// textbook circular-mean construction.

import Foundation

extension ScopeSample {
    /// `nil` when `total == 0` (nothing to centre). Degrees, `(-180, 180]`.
    public var centroidAngleDeg: Double? {
        guard total > 0 else { return nil }
        let n = bins.count
        var sumX = 0.0, sumY = 0.0
        for row in 0..<n {
            // Bounded by the row's own length (never assumes a square grid),
            // and mapped to bin CENTRES like the renderers (#3292, #3305 review).
            for col in 0..<min(n, bins[row].count) where bins[row][col] > 0 {
                let cb = (Double(col) + 0.5) / Double(n) - 0.5
                let cr = 0.5 - (Double(row) + 0.5) / Double(n)
                let mag = (cb * cb + cr * cr).squareRoot()
                // Within one cell of the origin is achromatic — no hue to
                // contribute (with bin centres nothing sits exactly at 0).
                guard mag > 1.0 / Double(n) else { continue }
                let weight = Double(bins[row][col])
                sumX += weight * (cb / mag)
                sumY += weight * (cr / mag)
            }
        }
        guard sumX != 0 || sumY != 0 else { return 0 }
        return atan2(sumY, sumX) * 180 / .pi
    }
}
