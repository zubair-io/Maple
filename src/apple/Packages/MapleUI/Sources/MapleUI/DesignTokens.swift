// DesignTokens.swift — SwiftUI bindings for the raw-core canonical UI tokens,
// MapleUI's own self-contained copy.
//
// MapleUI is a dependency-free local SPM package (Maple UI design system,
// Apple phase — see docs/superpowers/specs/2026-08-22-maple-ui-design-system-design.md
// §3) and cannot import MapleCore, so it cannot reuse MapleCore's
// `DesignTokens.swift` / `MapleTokens` wrapper. This file mirrors that
// wrapper's idiom (`Color(hex:)` / `Color(token:)` + a `MuiTokens` enum)
// against MapleUI's own generated `Generated/UITokens.swift` — the same
// values, emitted a second time by `tools/codegen.sh`, so the two copies
// can't drift.

import SwiftUI

// MARK: - Color from token string

extension Color {
    /// Build a SwiftUI `Color` from a `MapleUITokens` string. Accepts either
    /// `#rrggbb` hex or `rgba(R, G, B, A)`. Falls back to opaque magenta on
    /// a parse failure so the bug is loud, not silent.
    init(muiToken token: String) {
        if token.hasPrefix("#") {
            let c = Self.parseMuiHex(token)
            self.init(red: c.r, green: c.g, blue: c.b)
        } else if let rgba = Self.parseMuiRgba(token) {
            self.init(red: rgba.r, green: rgba.g, blue: rgba.b, opacity: rgba.a)
        } else {
            self = Color(red: 1, green: 0, blue: 1) // magenta on parse failure
        }
    }

    init(muiHex hex: String) {
        let c = Self.parseMuiHex(hex)
        self.init(red: c.r, green: c.g, blue: c.b)
    }

    /// Parse `#rrggbb` (or `#RRGGBB`) into 0-1 RGB components. Exposed
    /// (not `fileprivate`) so `MuiTokensTests` can assert on the parsed
    /// values directly, without resolving a rendered `Color` against an
    /// environment.
    static func parseMuiHex(_ hex: String) -> (r: Double, g: Double, b: Double) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let scanner = Scanner(string: hex)
        var int: UInt64 = 0
        scanner.scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        return (r, g, b)
    }

    /// Parse `rgba(R, G, B, A)` where R/G/B are 0-255 integers and A is a
    /// 0-1 decimal. Whitespace flexibility matches CSS.
    static func parseMuiRgba(_ s: String) -> (r: Double, g: Double, b: Double, a: Double)? {
        let trimmed = s.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("rgba(") && trimmed.hasSuffix(")") else { return nil }
        let inside = trimmed.dropFirst("rgba(".count).dropLast()
        let parts = inside.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 4,
              let ri = Int(parts[0]),
              let gi = Int(parts[1]),
              let bi = Int(parts[2]),
              let a = Double(parts[3])
        else { return nil }
        return (Double(ri) / 255.0, Double(gi) / 255.0, Double(bi) / 255.0, a)
    }
}

// MARK: - MuiTokens

/// Stable SwiftUI-facing API surface for Maple UI's design tokens. Every
/// value is sourced from `MapleUITokens` (generated from
/// `raw_core::ui_tokens`) — never a hand-picked hex literal or magic number.
public enum MuiTokens {
    // MARK: Colors

    public static let bg = Color(muiToken: MapleUITokens.bg)
    public static let surface = Color(muiToken: MapleUITokens.surface)
    public static let surfaceAlt = Color(muiToken: MapleUITokens.surfaceAlt)
    public static let surfaceHover = Color(muiToken: MapleUITokens.surfaceHover)
    public static let sidebar = Color(muiToken: MapleUITokens.sidebar)
    public static let inputBg = Color(muiToken: MapleUITokens.inputBg)
    public static let imageCanvas = Color(muiToken: MapleUITokens.imageCanvas)

    public static let textMain = Color(muiToken: MapleUITokens.textMain)
    public static let textMuted = Color(muiToken: MapleUITokens.textMuted)

    public static let border = Color(muiToken: MapleUITokens.border)
    public static let borderHi = Color(muiToken: MapleUITokens.borderHi)

    public static let primary = Color(muiToken: MapleUITokens.primary)
    public static let primaryDim = Color(muiToken: MapleUITokens.primaryDim)

    public static let warn = Color(muiToken: MapleUITokens.warn)

    public static let bgHover = Color(muiToken: MapleUITokens.bgHover)
    public static let bgActive = Color(muiToken: MapleUITokens.bgActive)

    // `successBg`/`errorBg` match MapleCore's own DesignTokens.swift: no
    // dedicated fill token exists yet in `ui_tokens.rs` (flagged in
    // button.md's Variants section), so these stay system-color-derived
    // rather than each atom guessing an alpha independently.
    public static let successBg = Color.green.opacity(0.15)
    public static let successText = Color(muiToken: MapleUITokens.successText)
    public static let errorBg = Color.red.opacity(0.15)
    public static let errorText = Color(muiToken: MapleUITokens.errorText)
    public static let star = Color(muiToken: MapleUITokens.star)

    // MARK: Radius

    public static let radiusXs = MapleUITokens.radiusXs
    public static let radiusSm = MapleUITokens.radiusSm
    public static let radiusMd = MapleUITokens.radiusMd
    public static let radiusLg = MapleUITokens.radiusLg
    public static let radiusXl = MapleUITokens.radiusXl
    public static let radiusXxl = MapleUITokens.radiusXxl
    public static let radiusFull = MapleUITokens.radiusFull

    // MARK: Spacing

    public static let spacingXs = MapleUITokens.spacingXs
    public static let spacingSm = MapleUITokens.spacingSm
    public static let spacingMd = MapleUITokens.spacingMd
    public static let spacingLg = MapleUITokens.spacingLg
    public static let spacingXl = MapleUITokens.spacingXl
    public static let spacingXxl = MapleUITokens.spacingXxl

    // MARK: Motion

    /// 200ms hover/press interaction pair — not yet tokenized in
    /// `MOTION_TOKENS` (its entries are macro transitions like
    /// `drawer`/`push`/`sheet_*`, not a generic hover/press pair). Per
    /// button.md's States section: hardcode 200ms consistently across all
    /// three platforms until a follow-up foundation task tokenizes it,
    /// rather than each atom guessing its own number.
    public static let hoverPressSeconds: Double = 0.2

    public enum Motion {
        public static let groupSwap = Animation.easeInOut(duration: MapleUITokens.Motion.groupSwap.seconds)
        public static let chromeHide = Animation.easeOut(duration: MapleUITokens.Motion.chromeHide.seconds)
        public static let filterFade = Animation.linear(duration: MapleUITokens.Motion.filterFade.seconds)
    }

    // MARK: Type scale
    //
    // Text atom contract (docs/design/maple-ui/components/text.md): nine
    // named scale steps. MapleUI ships without bundled font files (that's
    // an app-level Resources concern per MapleCore's own DesignTokens.swift
    // comment about CTFontManagerRegisterFontsForURL), so these fall back to
    // system fonts at the spec'd size/weight — call sites in an app that
    // already registers Lato/Merriweather get those faces automatically
    // since `Font.custom` resolution happens by family name at draw time,
    // but MapleUI itself only guarantees size/weight/design via the system
    // face until a consuming app registers the named fonts.
    public enum TypeScale {
        public static func font(_ variant: MuiTextVariant) -> Font {
            switch variant {
            case .sourceTitle: return .custom("Merriweather-Bold", size: 28)
            case .sheetTitle: return .custom("Merriweather-Bold", size: 17)
            case .rowLabel: return .custom("Lato-Regular", size: 14)
            case .body: return .custom("Lato-Regular", size: 13)
            case .toolLabel: return .custom("Lato-Regular", size: 10)
            case .chipLabel: return .custom("Lato-Bold", size: 11)
            case .eyebrow: return .custom("Lato-Bold", size: 10)
            case .valueChip: return .system(size: 11, weight: .regular, design: .monospaced)
            case .filename: return .system(size: 12, weight: .regular, design: .monospaced)
            }
        }
    }
}
