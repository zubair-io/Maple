// MuiIconPathMath.swift — a tiny SVG path-data interpreter, just
// expressive enough for the hand-authored 16×16 stroke icons Windows'
// `MapleIconShapes.cs` defines (moveto/lineto/horizontal/vertical/
// elliptical-arc/closepath, upper- or lowercase). Backs `MuiIconRegistry`'s
// pixel-parity mirror of the "cloud" and "calendar" glyphs (#3024).
//
// Deliberately NOT a general SVG parser — no curves, no rotated or
// non-circular (rx != ry) arcs, no implicit repeated coordinate groups —
// because nothing in the Maple icon registries uses them today. Extend it
// if a future mirrored icon needs more of the mini-language rather than
// building the rest speculatively now.

import SwiftUI

enum MuiIconPathMath {
    private static let commandLetters = CharacterSet(charactersIn: "MmLlHhVvAaZz")

    /// Parses one SVG `d` attribute value into a `Path`, in the same 16×16
    /// coordinate space the source string was authored in.
    static func path(for d: String) -> Path {
        var path = Path()
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        let scanner = Scanner(string: d)
        // SVG path data is fixed-format: '.' decimals, comma OR whitespace
        // separators. Pin the locale so comma-decimal locales don't misparse
        // "4.6", and skip commas like whitespace per the SVG grammar.
        scanner.locale = Locale(identifier: "en_US_POSIX")
        var skipped = CharacterSet.whitespacesAndNewlines
        skipped.insert(",")
        scanner.charactersToBeSkipped = skipped

        while let letter = scanner.scanCharacters(from: commandLetters)?.last {
            switch letter {
            case "M":
                current = scanPoint(scanner)
                subpathStart = current
                path.move(to: current)
            case "m":
                current = current + scanPoint(scanner)
                subpathStart = current
                path.move(to: current)
            case "L":
                current = scanPoint(scanner)
                path.addLine(to: current)
            case "l":
                current = current + scanPoint(scanner)
                path.addLine(to: current)
            case "H":
                current = CGPoint(x: scanNumber(scanner), y: current.y)
                path.addLine(to: current)
            case "h":
                current = CGPoint(x: current.x + scanNumber(scanner), y: current.y)
                path.addLine(to: current)
            case "V":
                current = CGPoint(x: current.x, y: scanNumber(scanner))
                path.addLine(to: current)
            case "v":
                current = CGPoint(x: current.x, y: current.y + scanNumber(scanner))
                path.addLine(to: current)
            case "A", "a":
                let rx = scanNumber(scanner)
                _ = scanNumber(scanner) // ry — assumed == rx (circular arcs only, see header)
                _ = scanNumber(scanner) // x-axis-rotation — assumed 0
                let largeArc = scanFlag(scanner)
                let sweep = scanFlag(scanner)
                let endpoint = letter == "a" ? current + scanPoint(scanner) : scanPoint(scanner)
                addCircularArc(&path, from: current, to: endpoint, radius: rx, largeArc: largeArc, sweep: sweep)
                current = endpoint
            default: // "Z" / "z"
                path.closeSubpath()
                current = subpathStart
            }
        }
        return path
    }

    // MARK: - Scanning

    private static func scanNumber(_ scanner: Scanner) -> CGFloat {
        CGFloat(scanner.scanDouble() ?? 0)
    }

    private static func scanPoint(_ scanner: Scanner) -> CGPoint {
        CGPoint(x: scanNumber(scanner), y: scanNumber(scanner))
    }

    /// SVG's arc flags are always a single `0`/`1` digit and — per the spec
    /// — need not be separated by whitespace from whatever follows (e.g.
    /// `"014 6.9"` is flag `0`, flag `1`, then the number `4`). A generic
    /// number scan would greedily swallow `014` as one value, so this reads
    /// exactly one character instead.
    ///
    /// The leading-whitespace skip has to happen by hand: `Scanner`'s own
    /// `scan...` methods only apply `charactersToBeSkipped` as part of a
    /// *successful* match, so `scanCharacters(from: .whitespacesAndNewlines)`
    /// finds nothing left to scan once the skip consumes the run itself —
    /// the scan fails, and a failed scan leaves the scanner exactly where it
    /// started, undoing the skip along with it.
    private static func scanFlag(_ scanner: Scanner) -> Bool {
        var idx = scanner.currentIndex
        while idx < scanner.string.endIndex, scanner.string[idx] == " " || scanner.string[idx] == "," {
            idx = scanner.string.index(after: idx)
        }
        guard idx < scanner.string.endIndex else {
            scanner.currentIndex = idx
            return false
        }
        let ch = scanner.string[idx]
        guard ch == "0" || ch == "1" else {
            scanner.currentIndex = idx
            return false
        }
        scanner.currentIndex = scanner.string.index(after: idx)
        return ch == "1"
    }

    // MARK: - Arc math

    /// Endpoint-to-center conversion for a *circular* (rx == ry), unrotated
    /// SVG elliptical arc — simplified from the SVG 1.1 spec's Appendix F.6
    /// algorithm, whose two rotate-by-φ steps drop out entirely once
    /// rotation is fixed at 0 and rx/ry are equal.
    private static func addCircularArc(
        _ path: inout Path, from start: CGPoint, to end: CGPoint,
        radius: CGFloat, largeArc: Bool, sweep: Bool
    ) {
        guard start != end, radius > 0 else { return }
        var r = radius
        let midX = (start.x + end.x) / 2
        let midY = (start.y + end.y) / 2
        // Translate so the start/end midpoint sits at the origin — this is
        // the (x1', y1') step of the spec's formula with the rotation
        // already removed.
        let x1p = start.x - midX
        let y1p = start.y - midY

        let lambda = (x1p * x1p + y1p * y1p) / (r * r)
        if lambda > 1 { r *= lambda.squareRoot() }

        let sign: CGFloat = (largeArc != sweep) ? 1 : -1
        let denominator = x1p * x1p + y1p * y1p
        let numerator = max(0, r * r - denominator)
        let co = denominator > 0 ? sign * (numerator / denominator).squareRoot() : 0
        let cxp = co * y1p
        let cyp = -co * x1p
        let center = CGPoint(x: cxp + midX, y: cyp + midY)

        let startAngle = atan2(y1p - cyp, x1p - cxp)
        var delta = atan2(-y1p - cyp, -x1p - cxp) - startAngle
        if !sweep, delta > 0 { delta -= 2 * .pi }
        if sweep, delta < 0 { delta += 2 * .pi }

        path.addRelativeArc(center: center, radius: r, startAngle: Angle(radians: startAngle), delta: Angle(radians: delta))
    }
}

private func + (lhs: CGPoint, rhs: CGPoint) -> CGPoint {
    CGPoint(x: lhs.x + rhs.x, y: lhs.y + rhs.y)
}
