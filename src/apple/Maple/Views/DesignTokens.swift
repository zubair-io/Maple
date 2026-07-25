// DesignTokens.swift — SwiftUI bindings for the raw-core canonical UI tokens.
//
// Ticket #606: the color hex strings + motion specs live in
// `raw_core::ui_tokens` and are emitted to
// `Packages/MapleCore/Sources/MapleCore/Generated/UITokens.swift` by
// `tools/codegen.sh`. This file is a thin SwiftUI wrapper that preserves
// the historical `MapleTokens` API surface (so call sites don't change)
// but sources every value from `MapleUITokens` instead of duplicating
// hand-written hex literals.

import SwiftUI
import MapleCore

// MARK: - MapleTokens

public struct MapleTokens {
    // Surfaces (sourced from raw_core::ui_tokens::COLOR_TOKENS via UITokens.swift)
    static let bg            = Color(token: MapleUITokens.bg)
    static let surface       = Color(token: MapleUITokens.surface)
    static let surfaceAlt    = Color(token: MapleUITokens.surfaceAlt)
    static let surfaceHover  = Color(token: MapleUITokens.surfaceHover)
    static let sidebar       = Color(token: MapleUITokens.sidebar)
    static let inputBg       = Color(token: MapleUITokens.inputBg)
    static let imageCanvas   = Color(token: MapleUITokens.imageCanvas)

    // Text
    static let textMain      = Color(token: MapleUITokens.textMain)
    static let textMuted     = Color(token: MapleUITokens.textMuted)

    // Borders
    static let border        = Color(token: MapleUITokens.border)
    /// Active ticks (drag-bar center tick), grab handles. Responsive-program
    /// S0a (#581). One tier up from `border` to preserve contrast headroom.
    static let borderHi      = Color(token: MapleUITokens.borderHi)

    // Accent
    static let primary       = Color(token: MapleUITokens.primary)
    static let primaryDim    = Color(token: MapleUITokens.primaryDim)

    /// Low-confidence signals (e.g. person detection chips). Tailwind amber-400.
    /// Responsive-program S0a (#581).
    static let warn          = Color(token: MapleUITokens.warn)

    // Hover / active overlays (rgba)
    static let bgHover       = Color(token: MapleUITokens.bgHover)
    static let bgActive      = Color(token: MapleUITokens.bgActive)

    // Semantic
    //
    // `successBg` and `errorBg` deliberately are NOT sourced from
    // `MapleUITokens`. Pre-#606 the Swift side used SwiftUI's system
    // `Color.green` / `Color.red` at 15% alpha; the web side uses
    // Tailwind green-500 / red-500 at the same alpha. That platform drift
    // pre-dates #606 — closing it is a value change, and this ticket is
    // value-flow only (consolidating the value choice is a follow-up).
    // Hex colors (`successText`, `errorText`, `star`) DO match exactly
    // across platforms, so they flow through `MapleUITokens` as expected.
    static let successBg     = Color.green.opacity(0.15)
    static let successText   = Color(token: MapleUITokens.successText)
    static let errorBg       = Color.red.opacity(0.15)
    static let errorText     = Color(token: MapleUITokens.errorText)
    static let star          = Color(token: MapleUITokens.star)

    // MARK: - Typography
    //
    // Bundled type scale per docs/design/responsive-program/s0-primitives.md
    // §3.4. Fonts registered via CTFontManagerRegisterFontsForURL in
    // MapleApp.init (today's Xcode 17 / SDK 26.4 Info.plist synthesizer does
    // not emit INFOPLIST_KEY_UIAppFonts into the built plist, so Core Text
    // is the working loader); .ttf files live in Maple/Resources/Fonts/. SF
    // Mono is system-provided on Apple (no bundle needed); web ships
    // JetBrains Mono for cross-browser consistency.
    //
    // Naming vocabulary mirrors the spec table — `sourceTitle`, `sheetTitle`,
    // `body`, `rowLabel`, `eyebrow`, `chipLabel`, `toolLabel`, `valueChip`,
    // `filename`. Avoid `.font(.system(size: …))` at call sites so the type
    // hierarchy stays in one place.
    enum Typography {
        /// Big serif title for source / library headers (Library, Pictures, etc).
        /// Apply `.tracking(-0.5)` at call site per spec.
        static let sourceTitle = Font.custom("Merriweather-Bold", size: 28)
        /// Sheet title — info sheet header, modal headers.
        static let sheetTitle = Font.custom("Merriweather-Bold", size: 17)
        /// Generic body text — secondary metadata, hints, descriptive copy.
        static let body = Font.custom("Lato-Regular", size: 13)
        /// Default row label — sidebar entries, info-row values, list items.
        static let rowLabel = Font.custom("Lato-Regular", size: 14)
        /// Tool / pill labels in the editor row.
        static let toolLabel = Font.custom("Lato-Regular", size: 10)
        /// Chip label — filter chips, status pills.
        static let chipLabel = Font.custom("Lato-Bold", size: 11)
        /// Eyebrow / section header. Apply `.tracking(...)` and `.uppercased()`
        /// at the call site (already up-cased) so the SCSS / Tailwind variants
        /// stay in lockstep.
        static let eyebrow = Font.custom("Lato-Bold", size: 10)
        /// Mono numeric chip — slider value readouts. Pair with
        /// `.monospacedDigit()` at the call site.
        static let valueChip = Font.system(size: 11, weight: .regular, design: .monospaced)
        /// Filenames in chrome (filmstrip captions, EXIF "File name" row).
        static let filename = Font.system(size: 12, weight: .regular, design: .monospaced)
    }

    // MARK: - Spacing
    //
    // 4-pt grid. Use the named tokens at call sites — `.padding(MapleTokens.Spacing.row)`
    // — so visual rhythm stays consistent and a future tweak lands in one place.
    enum Spacing {
        /// Vertical padding inside one list/tree row.
        static let rowVertical: CGFloat   = 8
        /// Horizontal padding for one list/tree row.
        static let rowHorizontal: CGFloat = 12
        /// Indent applied per depth level in the tree sidebar.
        static let treeIndent: CGFloat    = 16
        /// Gap between an icon and its label inside a row.
        static let iconLabelGap: CGFloat  = 10
        /// Vertical gap between sibling sections in a panel.
        static let sectionGap: CGFloat    = 16
        /// Horizontal padding for section content (panel inset).
        static let panelInset: CGFloat    = 16
        /// Fixed height for every sidebar section-header bar (TIMELINE,
        /// per-server cloud headers, FOLDERS, PHOTOS LIBRARY, CONNECTIONS —
        /// #2271). Previously each header sized itself intrinsically from
        /// `.padding(.vertical, 6)` around the chevron + eyebrow-font label;
        /// that rendered consistently ONLY because every header happened to
        /// use the same icon/font/padding recipe. Promoting the height to a
        /// named token makes that consistency explicit and gives a future
        /// header (a different icon, a trailing control) one place to match
        /// rather than a value to reverse-engineer.
        ///
        /// Value: measured render of the existing recipe — an 11pt
        /// `chevron.down`/calendar glyph plus the 10pt `eyebrow` label inside
        /// 6pt top/bottom padding — is ~26-28pt tall; 30pt keeps the prior
        /// visual rhythm with a hair of breathing room rather than clipping
        /// the taller of the two glyphs.
        static let sectionHeaderHeight: CGFloat = 30
    }

    // MARK: - Motion
    //
    // Responsive-program S0a (#581). Duration + easing tokens for shell
    // transitions, sheet present/dismiss, group/tool swap, chrome hide,
    // filter fade. Ticket #606: durations + easing strings now come from
    // `MapleUITokens.Motion` (generated from raw_core::ui_tokens).
    // SwiftUI translation lives here — `cubic-bezier(...)` strings map to
    // `Animation.timingCurve(...)`, named CSS easings to the matching
    // `Animation.easeInOut` / `easeOut` / `linear` constructors.
    enum Motion {
        /// Drawer open/close (240ms, ease-default). Sidebar collapse on
        /// tablet/desktop; not used on phone (tab-bar shell has no drawer).
        static let drawer = Animation.timingCurve(
            0.22, 1, 0.36, 1,
            duration: MapleUITokens.Motion.drawer.seconds
        )
        /// Push transition (320ms, iOS system / .snappy).
        static let push = Animation.snappy(duration: MapleUITokens.Motion.push.seconds)
        /// Sheet present (320ms).
        static let sheetPresent = Animation.snappy(duration: MapleUITokens.Motion.sheetPresent.seconds)
        /// Sheet dismiss (280ms).
        static let sheetDismiss = Animation.snappy(duration: MapleUITokens.Motion.sheetDismiss.seconds)
        /// Editor group/tool tab swap (120ms ease-in-out).
        static let groupSwap = Animation.easeInOut(duration: MapleUITokens.Motion.groupSwap.seconds)
        /// Editor chrome auto-hide (180ms ease-out).
        static let chromeHide = Animation.easeOut(duration: MapleUITokens.Motion.chromeHide.seconds)
        /// Library filter chip change cross-fade (120ms linear).
        static let filterFade = Animation.linear(duration: MapleUITokens.Motion.filterFade.seconds)
    }
}

// MARK: - Color from token string
//
// `MapleUITokens` exposes raw CSS-style strings — either `#rrggbb` (or
// `#RRGGBB`) hex literals, or `rgba(r, g, b, a)` with integer 0-255
// components and a 0-1 alpha. This initializer handles both forms so
// generated tokens flow straight in.

extension Color {
    /// Build a SwiftUI `Color` from a `MapleUITokens` string. Accepts either
    /// `#rrggbb` hex or `rgba(R, G, B, A)`. Falls back to opaque magenta on
    /// a parse failure so the bug is loud, not silent.
    init(token: String) {
        if token.hasPrefix("#") {
            self = Color(hex: token)
        } else if let rgba = Color.parseRgba(token) {
            self.init(red: rgba.r, green: rgba.g, blue: rgba.b, opacity: rgba.a)
        } else {
            self = Color(red: 1, green: 0, blue: 1) // magenta on parse failure
        }
    }

    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let scanner = Scanner(string: hex)
        var int: UInt64 = 0
        scanner.scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8)  & 0xFF) / 255.0
        let b = Double(int         & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }

    /// Parse `rgba(R, G, B, A)` where R/G/B are 0-255 integers and A is a
    /// 0-1 decimal. Whitespace flexibility matches CSS.
    fileprivate static func parseRgba(_ s: String) -> (r: Double, g: Double, b: Double, a: Double)? {
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

// MARK: - Maple Settings form styling

extension View {
    /// Replaces a `Form`/`List`'s default system grouped background with
    /// `MapleTokens.bg` so pushed iPhone Settings sub-screens
    /// (`GeneralSettingsTab`, `BackupSettingsView`, `PanoSettingsView`, …)
    /// match `PhoneSettingsView`'s root list instead of the OS's cooler
    /// gray. Responsive-program S8 follow-up (#1903). No-op on macOS —
    /// the Mac `SettingsView` modal keeps its native system appearance
    /// per docs/design/responsive-program/s8-settings.md §2 ("Tablet /
    /// Desktop unchanged").
    func mapleSettingsBackground() -> some View {
        #if os(iOS)
        self
            .scrollContentBackground(.hidden)
            .background(MapleTokens.bg)
        #else
        self
        #endif
    }
}

// MARK: - StarView

public struct StarView: View {
    public let count: Int   // 0..5
    public let size: CGFloat

    public init(count: Int, size: CGFloat = 11) {
        self.count = count
        self.size = size
    }

    public var body: some View {
        HStack(spacing: 1) {
            ForEach(1...5, id: \.self) { i in
                Image(systemName: i <= count ? "star.fill" : "star")
                    .font(.system(size: size))
                    .foregroundStyle(i <= count ? MapleTokens.star : MapleTokens.textMuted)
            }
        }
    }
}

// MARK: - FlagBadge

public struct FlagBadge: View {
    public let flag: CullFlag

    public init(flag: CullFlag) { self.flag = flag }

    public var body: some View {
        Group {
            switch flag {
            case .pick:
                Image(systemName: "flag.fill")
                    .foregroundStyle(.white)
                    .padding(3)
                    .background(MapleTokens.primary, in: Circle())
            case .reject:
                Image(systemName: "xmark")
                    .foregroundStyle(MapleTokens.errorText)
                    .padding(3)
                    .background(MapleTokens.errorBg, in: Circle())
            case .none:
                EmptyView()
            }
        }
        .font(.system(size: 9))
    }
}

// MARK: - Previews
//
// Issue #139 — every renderable view in this file gets at least one
// `#Preview` against stubs. StarView covers the 0..5 range; FlagBadge
// covers all three CullFlag cases.

#Preview("StarView — Default (3 of 5)") {
    StarView(count: 3)
        .padding()
        .background(MapleTokens.bg)
}

#Preview("StarView — All states") {
    VStack(alignment: .leading, spacing: 8) {
        ForEach(0...5, id: \.self) { count in
            HStack(spacing: 8) {
                Text("\(count)")
                    .frame(width: 16)
                    .foregroundStyle(MapleTokens.textMuted)
                StarView(count: count)
            }
        }
    }
    .padding()
    .background(MapleTokens.bg)
}

#Preview("FlagBadge — Default (pick)") {
    FlagBadge(flag: .pick)
        .padding()
        .background(MapleTokens.bg)
}

#Preview("FlagBadge — All states") {
    HStack(spacing: 12) {
        VStack(spacing: 6) { FlagBadge(flag: .pick); Text("pick").font(.caption2) }
        VStack(spacing: 6) { FlagBadge(flag: .reject); Text("reject").font(.caption2) }
        VStack(spacing: 6) { FlagBadge(flag: .none); Text("none").font(.caption2) }
    }
    .padding()
    .background(MapleTokens.bg)
    .preferredColorScheme(.dark)
}
