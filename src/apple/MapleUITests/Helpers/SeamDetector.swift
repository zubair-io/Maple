// SeamDetector.swift — row-luminance band/splice detector shared by the
// UITest seam gates (#1769 iPad present-path gate, #1805 sidecar gate).
//
// The metric is the max per-row SECOND DIFFERENCE of row-mean luminance
// inside the image band. Scene content varies smoothly row-to-row, so a
// clean render of a photographic fixture measures ≈0.6–1.1/255; a
// horizontal splice (two pipeline states in one drawable) or a hard tone
// band steps the row statistic by tens of levels. Nothing about the AgX
// look, the decode quality, or dither noise can manufacture a step edge in
// ROW MEANS, which is what makes the detector robust enough to gate on.
//
// Extracted from `IpadPresentSeamUITests` (where it was calibrated against
// real iPad captures) so the macOS sidecar-staged gate in
// `SidecarSeamUITests` measures the SAME statistic with the same
// calibration rather than a second, independently-drifting copy.
//
// Platform-neutral: CoreGraphics only, no UIKit/AppKit. Callers hand over a
// `CGImage` (`UIImage.cgImage` / `NSImage.cgImage(forProposedRect:…)`).

import CoreGraphics
import Foundation

struct SeamMetrics {
    /// Max |L[y+1] - 2·L[y] + L[y-1]| over interior rows of the image
    /// band, where L[y] is the trimmed-mean luminance (0–255) of row y
    /// over the analysis columns.
    let maxRowSecondDiff: Double
    let worstRow: Int
    let rowCount: Int
    /// max(L) - min(L) across the band rows — the non-vacuous floor. A
    /// blank or black canvas would trivially pass the seam check, so every
    /// gate asserts this is wide before trusting `maxRowSecondDiff`.
    let lumaSpread: Double
}

enum SeamDetector {

    /// Row-luminance seam metrics for `image`, measured over each of
    /// `strips` (normalized column ranges of the image width) and reduced
    /// by taking the strip with the SMALLEST maximum second difference.
    ///
    /// The min-of-strips reduction is the chrome-robustness device: a real
    /// splice/band is FULL-WIDTH by construction so it appears in every
    /// strip at full strength, while floating chrome (a control panel, a
    /// dock, a zoom badge) pollutes at most one strip. A caller whose
    /// canvas element carries no floating chrome passes a single strip and
    /// the reduction is the identity.
    ///
    /// Returns nil when the image is too small, undecodable, or has no
    /// usable image band (see `stripMetrics`).
    static func metrics(of image: CGImage,
                        strips: [ClosedRange<Double>]) -> SeamMetrics? {
        let width = image.width
        let height = image.height
        guard width >= 16, height >= 16, !strips.isEmpty else { return nil }
        let bytesPerRow = width * 4
        var buf = [UInt8](repeating: 0, count: bytesPerRow * height)
        guard let ctx = CGContext(
            data: &buf,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        let columnRanges: [Range<Int>] = strips.compactMap { strip in
            let lo = Int(Double(width) * strip.lowerBound)
            let hi = Int(Double(width) * strip.upperBound)
            return hi - lo >= 16 ? lo..<hi : nil
        }
        guard columnRanges.count == strips.count else { return nil }

        let perStrip = columnRanges.compactMap {
            stripMetrics(buf: buf, bytesPerRow: bytesPerRow, height: height, xs: $0)
        }
        guard perStrip.count == columnRanges.count else { return nil }
        return perStrip.min { $0.maxRowSecondDiff < $1.maxRowSecondDiff }
    }

    /// Row-luminance second-difference metrics for one column strip.
    ///
    /// The per-row statistic is a 25%-TRIMMED mean (mean of the middle 50%
    /// of the strip's column values): as smooth as the plain mean on scene
    /// content but immune to any overlay covering < 25% of the strip's
    /// columns. A splice shifts EVERY column, so the trimmed mean steps by
    /// tens. (A plain median was tried and proved JUMPIER on sharp
    /// horizontal content edges — ~7/255 at a hair/background boundary —
    /// eating the threshold's margin.)
    ///
    /// The image band is the LONGEST CONTIGUOUS RUN of rows whose per-row
    /// stddev clears the uniform-background floor. The canvas element spans
    /// the whole editor column, so black letterbox regions (stddev ≈ 0) fall
    /// out, and short varying runs OUTSIDE the image (a toolbar pill, a
    /// corner badge on black) lose to the tall image run — a plain
    /// first/last-index threshold wrongly bracketed pill→image and fired on
    /// the image's own top edge.
    ///
    /// The band interior is trimmed 10 rows at each end: the aspect-fit
    /// scaler smears the image's hard border over ~5–8 rows (a 3-row trim
    /// measured 26.8/255 of residual edge curvature at the band start). A
    /// splice sits mid-band — two scene regions meeting — and is never this
    /// close to the border.
    private static func stripMetrics(buf: [UInt8],
                                     bytesPerRow: Int,
                                     height: Int,
                                     xs: Range<Int>) -> SeamMetrics? {
        let stripWidth = xs.count
        var rowLumaMean = [Double](repeating: 0, count: height)
        var rowStd = [Double](repeating: 0, count: height)
        var rowVals = [Double](repeating: 0, count: stripWidth)
        for y in 0..<height {
            let rowStart = y * bytesPerRow
            var sum = 0.0
            for (i, x) in xs.enumerated() {
                let p = rowStart + x * 4
                let v = 0.299 * Double(buf[p])
                    + 0.587 * Double(buf[p + 1])
                    + 0.114 * Double(buf[p + 2])
                rowVals[i] = v
                sum += v
            }
            let mean = sum / Double(stripWidth)
            let varSum = rowVals.reduce(0.0) { $0 + (($1 - mean) * ($1 - mean)) }
            rowStd[y] = (varSum / Double(stripWidth)).squareRoot()
            rowVals.sort()
            let q1 = stripWidth / 4
            let q3 = (stripWidth * 3) / 4
            let mid = rowVals[q1..<q3]
            rowLumaMean[y] = mid.reduce(0, +) / Double(mid.count)
        }

        guard let band = longestSceneRun(rowStd: rowStd, height: height),
              band.len >= 64 else { return nil }

        let trim = 10
        let lo = band.start + trim
        let hi = band.start + band.len - 1 - trim
        guard hi - lo >= 8 else { return nil }
        let worst = ((lo + 1)..<hi).reduce(into: (row: lo, value: 0.0)) { acc, y in
            let d2 = abs(rowLumaMean[y + 1] - 2.0 * rowLumaMean[y] + rowLumaMean[y - 1])
            if d2 > acc.value { acc = (y, d2) }
        }
        let bandLuma = rowLumaMean[lo...hi]
        return SeamMetrics(
            maxRowSecondDiff: worst.value,
            worstRow: worst.row,
            rowCount: height,
            lumaSpread: (bandLuma.max() ?? 0) - (bandLuma.min() ?? 0)
        )
    }

    /// Longest contiguous run of rows whose stddev clears the
    /// uniform-background floor — the image band inside the canvas element.
    private static func longestSceneRun(rowStd: [Double],
                                        height: Int) -> (start: Int, len: Int)? {
        var best: (start: Int, len: Int)? = nil
        var runStart: Int? = nil
        for y in 0...height {
            let isScene = y < height && rowStd[y] > 2.0
            if isScene {
                if runStart == nil { runStart = y }
            } else if let s = runStart {
                if y - s > (best?.len ?? 0) { best = (s, y - s) }
                runStart = nil
            }
        }
        return best
    }
}
