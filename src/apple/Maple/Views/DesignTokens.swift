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

    // Accent
    static let primary       = Color(hex: "#c4493a")
    static let primaryDim    = Color(hex: "#422016")

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
    // Use these everywhere instead of `.font(.system(size: …))` calls so
    // hierarchy stays consistent. Mirrors the web's tailwind type scale —
    // section headers up-cased + tracking, body sized for one-handed
    // reading on iPhone, callouts subordinate.
    enum Typography {
        /// Big screen title (rare; used for Settings-style stacks).
        static let title = Font.system(size: 28, weight: .bold)
        /// Section heading inside a panel (e.g. "FILE", "CULLING").
        /// Up-case at the call site; the type is sized for the all-caps
        /// presentation already.
        static let sectionHeader = Font.system(size: 11, weight: .semibold).leading(.tight)
        /// Server / library group header in the sidebar.
        static let groupHeader = Font.system(size: 17, weight: .semibold)
        /// Default row label — sidebar entries, info-row labels, list items.
        /// 16pt is iOS standard list size; readable, not cramped.
        static let row = Font.system(size: 16, weight: .regular)
        /// Compact row variant for nested tree depths and dense panels.
        static let rowDense = Font.system(size: 15, weight: .regular)
        /// Secondary metadata next to a row label (counts, dates, hints).
        static let meta = Font.system(size: 13, weight: .regular)
        /// Caption — thumbnail filename, dim secondary captions.
        static let caption = Font.system(size: 12, weight: .regular)
        /// Empty-state primary text ("No assets yet").
        static let emptyPrimary = Font.system(size: 17, weight: .semibold)
        /// Empty-state secondary explainer text.
        static let emptySecondary = Font.system(size: 14, weight: .regular)
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
