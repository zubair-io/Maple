// DesignTokens.swift — Swift port of the Maple Hosted tokens.ts
// Source: src/web/projects/maple-common/src/lib/tokens.ts

import SwiftUI
import MapleCore

// MARK: - MapleTokens

public struct MapleTokens {
    // Surfaces
    static let bg            = Color(hex: "#1c1917")
    static let surface       = Color(hex: "#262524")
    static let surfaceAlt    = Color(hex: "#2e2c2a")
    static let surfaceHover  = Color(hex: "#3a3836")
    static let sidebar       = Color(hex: "#292524")
    static let inputBg       = Color(hex: "#1c1917")
    static let imageCanvas   = Color(hex: "#141210")

    // Text
    static let textMain      = Color(hex: "#e7e5e4")
    static let textMuted     = Color(hex: "#a8a29e")

    // Borders
    static let border        = Color(hex: "#44403c")
    /// Active ticks (drag-bar center tick), grab handles. Responsive-program
    /// S0a (#581). One tier up from `border` to preserve contrast headroom.
    static let borderHi      = Color(hex: "#5a5552")

    // Accent
    static let primary       = Color(hex: "#c4493a")
    static let primaryDim    = Color(hex: "#422016")

    /// Low-confidence signals (e.g. person detection chips). Tailwind amber-400.
    /// Responsive-program S0a (#581).
    static let warn          = Color(hex: "#fbbf24")

    // Hover / active overlays (rgba)
    static let bgHover       = Color.white.opacity(0.06)
    static let bgActive      = Color.white.opacity(0.10)

    // Semantic
    static let successBg     = Color.green.opacity(0.15)
    static let successText   = Color(hex: "#4ade80")
    static let errorBg       = Color.red.opacity(0.15)
    static let errorText     = Color(hex: "#f87171")
    static let star          = Color(hex: "#EF9F27")

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
    }

    // MARK: - Motion
    //
    // Responsive-program S0a (#581). Duration + easing tokens for shell
    // transitions, sheet present/dismiss, group/tool swap, chrome hide,
    // filter fade. Web mirrors these as paired --motion-X-ms /
    // --motion-X-ease CSS custom properties in motion.scss.
    enum Motion {
        /// Drawer open/close (240ms, ease-default). Sidebar collapse on
        /// tablet/desktop; not used on phone (tab-bar shell has no drawer).
        static let drawer = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.24)
        /// Push transition (320ms, iOS system / .snappy).
        static let push = Animation.snappy(duration: 0.32)
        /// Sheet present (320ms).
        static let sheetPresent = Animation.snappy(duration: 0.32)
        /// Sheet dismiss (280ms).
        static let sheetDismiss = Animation.snappy(duration: 0.28)
        /// Editor group/tool tab swap (120ms ease-in-out).
        static let groupSwap = Animation.easeInOut(duration: 0.12)
        /// Loupe chrome auto-hide (180ms ease-out).
        static let chromeHide = Animation.easeOut(duration: 0.18)
        /// Library filter chip change cross-fade (120ms linear).
        static let filterFade = Animation.linear(duration: 0.12)
    }
}

// MARK: - Color hex

extension Color {
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
