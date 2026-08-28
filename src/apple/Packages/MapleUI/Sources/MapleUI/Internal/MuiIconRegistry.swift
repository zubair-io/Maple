// MuiIconRegistry.swift — the handful of `MuiIcon` names that resolve to a
// custom-drawn glyph instead of an SF Symbol.
//
// icon.md leaves each platform's backing glyph set alone (Apple = SF
// Symbols, Web = a stroke-SVG registry, Windows = Segoe Fluent) and
// explicitly defers picking one shared set to a later implementation plan.
// #3024 is the one bounded exception that plan already carved out early:
// two specific icons — "cloud" and "calendar" — that Windows drew first
// (`Maple.WinUI/Controls/MapleIconShapes.cs`, "Chrome set" §, added for
// #3022) and that need to look pixel-identical on every platform rather
// than falling back to whatever each platform's native glyph happens to
// look like. The path data below is copied verbatim from that C# table —
// same numbers, same 16×16 design space, same 1.5pt stroke — so this is a
// literal mirror, not a redrawn approximation.

import SwiftUI

enum MuiIconGlyphPrimitive: Sendable {
    case path(String)
    case roundedRect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, cornerRadius: CGFloat)
}

enum MuiIconRegistry {
    /// Stroke width for every mirrored glyph — matches
    /// `MapleIconShapes.cs`'s "Chrome set renders at stroke 1.5" note (the
    /// editor tool-glyph family uses its own 1.6 and isn't mirrored here).
    static let strokeWidth: CGFloat = 1.5

    /// 16×16 design-space primitives, keyed by the same `name` a caller
    /// already passes to `MuiIcon`. Only entries present here take the
    /// custom-drawn path; every other name still resolves to an SF Symbol.
    static let glyphs: [String: [MuiIconGlyphPrimitive]] = [
        "cloud": [
            .path("M4.6 12A2.6 2.6 0 014 6.9a3.6 3.6 0 017-1.3A2.8 2.8 0 0110.6 12H4.6z"),
        ],
        "calendar": [
            .roundedRect(x: 2.5, y: 3.5, width: 11, height: 10, cornerRadius: 1.5),
            .path("M5 2.5v2M11 2.5v2"),
            .path("M2.5 6.5h11"),
        ],
    ]

    /// The combined 16×16 outline for `name`, or `nil` when it isn't one of
    /// the mirrored glyphs — the caller's cue to fall back to an SF Symbol.
    static func path(for name: String) -> Path? {
        guard let primitives = glyphs[name] else { return nil }
        var combined = Path()
        for primitive in primitives {
            switch primitive {
            case .path(let d):
                combined.addPath(MuiIconPathMath.path(for: d))
            case .roundedRect(let x, let y, let width, let height, let cornerRadius):
                combined.addRoundedRect(
                    in: CGRect(x: x, y: y, width: width, height: height),
                    cornerSize: CGSize(width: cornerRadius, height: cornerRadius))
            }
        }
        return combined
    }
}
