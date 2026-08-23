// GallerySpecimenCard.swift — the atom-tier specimen card: a dark Canvas
// backdrop chip hosting the live rendered atom, plus a name + purpose
// caption below it. Mirrors the web showcase's card anatomy (name/purpose
// caption under a rendered specimen).

import SwiftUI

struct GallerySpecimenCard<Content: View>: View {
    let name: String
    let purpose: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            content
                .padding(MuiTokens.spacingMd)
                .frame(maxWidth: .infinity, minHeight: 72, alignment: .center)
                .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(MuiTokens.TypeScale.font(.rowLabel))
                    .foregroundStyle(MuiTokens.textMain)
                Text(purpose)
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.textMuted)
            }
        }
        .padding(MuiTokens.spacingSm)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
    }
}

/// One row of an unbuilt-tier placeholder list.
struct GalleryPlaceholderRow: View {
    let name: String

    var body: some View {
        HStack {
            MuiText(name, variant: .rowLabel, color: .muted)
            Spacer()
            MuiBadge(variant: .signal, value: "later wave")
        }
        .padding(.vertical, MuiTokens.spacingXs)
    }
}

struct GalleryPlaceholderSection: View {
    let names: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(names.enumerated()), id: \.offset) { index, name in
                GalleryPlaceholderRow(name: name)
                if index < names.count - 1 {
                    MuiDivider()
                }
            }
        }
        .padding(MuiTokens.spacingMd)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
    }
}
