// DesignTokens.swift — Swift port of maple-hosted tokens.ts
// Source: src/maple-hosted/projects/maple-common/src/lib/tokens.ts

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
}

// MARK: - Color hex extension

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
