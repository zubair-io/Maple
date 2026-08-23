// MoleculesL1GallerySection2.swift — Molecules L1 tab: specimen cards for
// wave A3b's 23 molecules (catalog §2.4 Overlays & menus, §2.5 Structure,
// §2.6 Data plots, §2.7 Media). Sibling to `MoleculesL1GallerySection`
// (wave A3a's §2.1-2.3) — kept as a separate top-level section rather than
// folded into that one so neither file needs to grow past the repo's
// ~400-line soft budget. Card bodies are split across
// MoleculesL1OverlaysMenusGallery.swift / MoleculesL1StructureGallery.swift
// / MoleculesL1PlotsGallery.swift / MoleculesL1MediaGallery.swift (this
// type's `extension`s).

import SwiftUI

struct MoleculesL1GallerySection2: View {
    let columns = [GridItem(.adaptive(minimum: 220), spacing: MuiTokens.spacingMd, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            MuiText("Overlays & menus, Structure, Data plots, Media", variant: .eyebrow, color: .muted)
            LazyVGrid(columns: columns, alignment: .leading, spacing: MuiTokens.spacingMd) {
                popoverCard
                contextMenuCard
                suggestionMenuCard
                commandMenuCard

                collapsibleCard
                pageHeaderCard
                toolbarCard
                bubbleMenuCard
                labelValueGridCard
                avatarGroupCard

                histogramCard
                waveformCard
                paradeCard
                vectorscopeCard
                curvePlotCard
                connectionGraphCard
                heatmapLayerCard

                mapAnnotationCard
                previewImageCard
                videoPlayerCard
                audioPlayerCard
                dragPreviewCard
                codeBlockCard
            }
        }
    }
}

#Preview {
    ScrollView {
        MoleculesL1GallerySection2().padding()
    }
    .background(MuiTokens.bg)
}
