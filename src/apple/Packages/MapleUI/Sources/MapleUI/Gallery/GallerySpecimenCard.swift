// GallerySpecimenCard.swift — the atom-tier specimen card: a dark Canvas
// backdrop chip hosting the live rendered atom, plus a name + purpose
// caption below it. Mirrors the web showcase's card anatomy (name/purpose
// caption under a rendered specimen).

import SwiftUI

struct GallerySpecimenCard<Content: View>: View {
    let name: String
    let purpose: String
    /// "Built from" caption (unified-component-catalog.md's per-molecule
    /// dependency column) — `nil` for atom specimens, which have no
    /// composition to caption.
    var builtFrom: String? = nil
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
                if let builtFrom {
                    Text("Built from \(builtFrom)")
                        .font(MuiTokens.TypeScale.font(.toolLabel))
                        .foregroundStyle(MuiTokens.textMuted)
                }
            }
        }
        .padding(MuiTokens.spacingSm)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
    }
}
