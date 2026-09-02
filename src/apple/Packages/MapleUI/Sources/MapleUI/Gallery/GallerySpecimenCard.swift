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
            // Some specimens (dense multi-column grids, or a populated demo
            // sitting beside fixed-width state boxes) are naturally wider
            // than a phone-width card (#3062: the Organisms tab's Filmstrip
            // and Search Results specimens rendered past the screen edges
            // on iPhone). `ViewThatFits` renders `content` exactly as before
            // — centered, no scroll chrome — whenever it fits the proposed
            // width, and falls back to the horizontally scrolling copy only
            // when it doesn't, so specimens that already fit (every atom,
            // and most molecules/organisms) are visually unchanged.
            ViewThatFits(in: .horizontal) {
                styledContent
                ScrollView(.horizontal, showsIndicators: false) { styledContent }
            }
            .frame(maxWidth: .infinity)
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

    /// `content` with the padding/sizing shared by both `ViewThatFits`
    /// branches — factored out (Copilot review on #3161) so the direct and
    /// scrolling variants can't drift from each other.
    private var styledContent: some View {
        content
            .padding(MuiTokens.spacingMd)
            .frame(minHeight: 72, alignment: .center)
    }
}
