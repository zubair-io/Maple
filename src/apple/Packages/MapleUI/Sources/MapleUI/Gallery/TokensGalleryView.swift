// TokensGalleryView.swift — Tokens tab: live color swatches + radius,
// spacing, and motion tables rendered straight from the generated values,
// so this view can never silently drift from `MapleUITokens`.

import SwiftUI

struct TokensGalleryView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            section("Color") { colorSwatches }
            section("Radius") { radiusTable }
            section("Spacing") { spacingTable }
            section("Motion") { motionTable }
        }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiText(title, variant: .eyebrow, color: .muted)
            content()
        }
    }

    private var colorSwatches: some View {
        let entries: [(String, Color)] = [
            ("bg", MuiTokens.bg), ("surface", MuiTokens.surface), ("surfaceAlt", MuiTokens.surfaceAlt),
            ("surfaceHover", MuiTokens.surfaceHover), ("sidebar", MuiTokens.sidebar),
            ("textMain", MuiTokens.textMain), ("textMuted", MuiTokens.textMuted),
            ("border", MuiTokens.border), ("borderHi", MuiTokens.borderHi),
            ("primary", MuiTokens.primary), ("primaryDim", MuiTokens.primaryDim),
            ("warn", MuiTokens.warn), ("successText", MuiTokens.successText),
            ("errorText", MuiTokens.errorText), ("star", MuiTokens.star),
        ]
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: MuiTokens.spacingSm)], spacing: MuiTokens.spacingSm) {
            ForEach(entries, id: \.0) { name, color in
                VStack(alignment: .leading, spacing: 4) {
                    RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
                        .fill(color)
                        .frame(height: 48)
                        .overlay(
                            RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
                                .stroke(MuiTokens.border, lineWidth: 1)
                        )
                    Text(name)
                        .font(MuiTokens.TypeScale.font(.filename))
                        .foregroundStyle(MuiTokens.textMuted)
                }
            }
        }
    }

    private var radiusTable: some View {
        let entries: [(String, CGFloat)] = [
            ("xs", MuiTokens.radiusXs), ("sm", MuiTokens.radiusSm), ("md", MuiTokens.radiusMd),
            ("lg", MuiTokens.radiusLg), ("xl", MuiTokens.radiusXl), ("xxl", MuiTokens.radiusXxl),
            ("full", MuiTokens.radiusFull),
        ]
        return VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            ForEach(entries, id: \.0) { name, value in
                HStack(spacing: MuiTokens.spacingMd) {
                    RoundedRectangle(cornerRadius: min(value, 24), style: .continuous)
                        .fill(MuiTokens.surfaceAlt)
                        .frame(width: 48, height: 24)
                        .overlay(RoundedRectangle(cornerRadius: min(value, 24), style: .continuous).stroke(MuiTokens.primary, lineWidth: 1))
                    Text("radius.\(name)").font(MuiTokens.TypeScale.font(.body)).foregroundStyle(MuiTokens.textMain)
                    Spacer()
                    Text(value >= 999 ? "full" : "\(Int(value))pt")
                        .font(MuiTokens.TypeScale.font(.valueChip))
                        .foregroundStyle(MuiTokens.textMuted)
                }
            }
        }
        .padding(MuiTokens.spacingMd)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
    }

    private var spacingTable: some View {
        let entries: [(String, CGFloat)] = [
            ("xs", MuiTokens.spacingXs), ("sm", MuiTokens.spacingSm), ("md", MuiTokens.spacingMd),
            ("lg", MuiTokens.spacingLg), ("xl", MuiTokens.spacingXl), ("xxl", MuiTokens.spacingXxl),
        ]
        return VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            ForEach(entries, id: \.0) { name, value in
                HStack(spacing: MuiTokens.spacingMd) {
                    Rectangle().fill(MuiTokens.primary).frame(width: value, height: 8)
                    Text("spacing.\(name)").font(MuiTokens.TypeScale.font(.body)).foregroundStyle(MuiTokens.textMain)
                    Spacer()
                    Text("\(Int(value))pt").font(MuiTokens.TypeScale.font(.valueChip)).foregroundStyle(MuiTokens.textMuted)
                }
            }
        }
        .padding(MuiTokens.spacingMd)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
    }

    private var motionTable: some View {
        let entries: [(String, MapleUITokens.MotionSpec)] = [
            ("drawer", MapleUITokens.Motion.drawer), ("push", MapleUITokens.Motion.push),
            ("sheetPresent", MapleUITokens.Motion.sheetPresent), ("sheetDismiss", MapleUITokens.Motion.sheetDismiss),
            ("groupSwap", MapleUITokens.Motion.groupSwap), ("chromeHide", MapleUITokens.Motion.chromeHide),
            ("filterFade", MapleUITokens.Motion.filterFade),
        ]
        return VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            ForEach(entries, id: \.0) { name, spec in
                HStack(spacing: MuiTokens.spacingMd) {
                    Text("motion.\(name)").font(MuiTokens.TypeScale.font(.body)).foregroundStyle(MuiTokens.textMain)
                    Spacer()
                    Text("\(spec.ms)ms")
                        .font(MuiTokens.TypeScale.font(.valueChip))
                        .foregroundStyle(MuiTokens.textMuted)
                    Text(spec.ease)
                        .font(MuiTokens.TypeScale.font(.filename))
                        .foregroundStyle(MuiTokens.textMuted)
                        .lineLimit(1)
                }
            }
        }
        .padding(MuiTokens.spacingMd)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
    }
}

#Preview {
    ScrollView {
        TokensGalleryView().padding()
    }
    .background(MuiTokens.bg)
}
