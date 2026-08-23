// MoleculesL2GallerySection.swift — Molecules L2 tab: specimen cards for
// wave A4's 24 molecules (catalog §3). Card bodies are split across
// MoleculesL2MediaGallery.swift / MoleculesL2FormGallery.swift /
// MoleculesL2EnrichmentGallery.swift / MoleculesL2WorkflowGallery.swift /
// MoleculesL2ChatGallery.swift (this type's `extension`s) to keep any one
// file under the repo's ~400-line soft budget.

import SwiftUI

struct MoleculesL2GallerySection: View {
    let columns = [GridItem(.adaptive(minimum: 220), spacing: MuiTokens.spacingMd, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            MuiText("All 24 Molecules-L2 elements", variant: .eyebrow, color: .muted)
            LazyVGrid(columns: columns, alignment: .leading, spacing: MuiTokens.spacingMd) {
                mediaCellCard
                cardCard
                filmstripRowCard
                filmstripRailCard
                qrScannerCard

                dialogCard
                settingsRowCard
                embedShellCard
                endpointFormCard
                responseViewerCard

                descriptionFieldCard
                transcriptBlockCard
                facesRowCard
                placeRowCard
                visionRowCard
                keywordRowCard

                previewListCard
                progressStepCard
                suggestionPreviewCard
                botOutputCard

                chatMessageCard
                typingIndicatorCard
                todoPopoverCard
                eventPopoverCard
            }
        }
    }
}

#Preview {
    ScrollView {
        MoleculesL2GallerySection().padding()
    }
    .background(MuiTokens.bg)
}
