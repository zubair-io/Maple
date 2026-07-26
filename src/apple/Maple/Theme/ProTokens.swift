// ProTokens.swift — Pro Editor Canvas-first (A1, #1536).
//
// Hand-written Pro token set for the "P" palette used by the canvas-first
// editor shell. Lives alongside `DesignTokens.swift` in the app target
// (SwiftUI layer) and deliberately does NOT flow through codegen — unification
// with `UITokens.swift` is tracked as a deferred follow-up per CLAUDE.md #7.
//
// Conventions:
//   • All surface/text/border tokens are opaque `Color` values derived from
//     the canonical hex literals defined here — ONE place to change hex.
//   • Accent-derived fills always use `accent(_:)` — never separate hex. The
//     argument is the hex component for 0x00-0xFF alpha (e.g. 0x1F = ~12%).
//   • Motion durations are `Double` seconds; consumers build `Animation`
//     via SwiftUI's `.easeOut(duration:)` etc.
//   • Glass material constants drive `Material`/`UIBlurEffect` at call sites.

import SwiftUI

// MARK: - Pro surface / text / border tokens

public enum ProTokens {

    // ── Backgrounds ────────────────────────────────────────────────────────

    /// App window / outer background — near-black warm.
    public static let bg = Color(proHex: 0x15130F)
    /// Image canvas backdrop.
    public static let canvas = Color(proHex: 0x0B0A08)
    /// Alternate canvas (cool-dark variant, used for split-tone surfaces).
    public static let canvasAlt = Color(proHex: 0x08070A)
    /// Panel / inspector surface.
    public static let panel = Color(proHex: 0x1D1B17)

    // ── Borders ────────────────────────────────────────────────────────────

    /// Default divider / track hairline.
    public static let border = Color(proHex: 0x322D26)
    /// Active / highlighted border (grab handles, active ticks).
    public static let borderHi = Color(proHex: 0x4A443B)

    // ── Text ───────────────────────────────────────────────────────────────

    /// Primary label text.
    public static let text = Color(proHex: 0xF2EFE9)
    /// Secondary / metadata text.
    public static let textMuted = Color(proHex: 0xA8A097)
    /// Dimmed / inactive text (zero-value readout, disabled state).
    public static let textDim = Color(proHex: 0x6E675E)

    // ── Accent ─────────────────────────────────────────────────────────────

    /// Brand accent — Maple red.
    public static let accent = Color(proHex: 0xC4493A)

    /// Accent-derived fill at the given alpha component (0x00…0xFF).
    ///
    /// Use this instead of separate hex literals so all accent-tinted fills
    /// derive from the one `accent` value above:
    ///
    ///     .background(ProTokens.accent(0x1F)) // ~12% accent
    ///     .background(ProTokens.accent(0x22)) // ~13%
    ///     .background(ProTokens.accent(0x28)) // ~16%
    ///     .background(ProTokens.accent(0x30)) // ~19%
    public static func accent(_ alpha: UInt8) -> Color {
        Color(proHex: 0xC4493A, alpha: alpha)
    }

    // ── Semantic ───────────────────────────────────────────────────────────

    /// Star-rating glyph (warm amber).
    public static let star = Color(proHex: 0xEF9F27)
    /// Success / ok state (green).
    public static let ok = Color(proHex: 0x62C172)

    // ── Per-channel curve strokes (#367) ───────────────────────────────────
    //
    // Desaturated against the panel so an R curve reads as "the red channel"
    // without competing with the accent. The Luma curve uses `accent`.
    // Mirrors `--pro-curve-{r,g,b}` in `src/web/.../pro-tokens.scss`.

    public static let curveRed = Color(proHex: 0xD1584A)
    public static let curveGreen = Color(proHex: 0x5AA361)
    public static let curveBlue = Color(proHex: 0x4F7FC4)
}

// MARK: - Glass material constants

public enum ProGlass {
    /// Blur radius (points) for the frosted-chrome HUD layer.
    public static let blurRadius: CGFloat = 20
    /// Background opacity for the frosted-chrome HUD layer over dark content.
    public static let opacity: Double = 0.72
    /// Tint opacity added on top of the blur to warm the glass.
    public static let tintOpacity: Double = 0.06
}

// MARK: - Motion durations (seconds)

public enum ProMotion {
    /// Controls recede off-canvas (ease-out).
    public static let recede: Double = 0.18
    /// HUD fade in (ease-out).
    public static let hudIn: Double = 0.12
    /// HUD fade out (ease-in).
    public static let hudOut: Double = 0.60
    /// Group cross-fade (ease-in-out).
    public static let groupCrossFade: Double = 0.12
    /// Card / panel collapse (ease-in-out).
    public static let cardCollapse: Double = 0.26
}

// MARK: - Color(proHex:) helper (file-private)

extension Color {
    /// Initialise from a 24-bit RGB hex literal (e.g. `0xC4493A`) and an
    /// optional alpha byte (0x00-0xFF, default 0xFF = fully opaque).
    ///
    /// `fileprivate` so the init is usable within ProTokens but does not
    /// pollute the global `Color` extension namespace.
    fileprivate init(proHex rgb: UInt32, alpha: UInt8 = 0xFF) {
        let r = Double((rgb >> 16) & 0xFF) / 255.0
        let g = Double((rgb >>  8) & 0xFF) / 255.0
        let b = Double( rgb        & 0xFF) / 255.0
        let a = Double(alpha) / 255.0
        self.init(red: r, green: g, blue: b, opacity: a)
    }
}
