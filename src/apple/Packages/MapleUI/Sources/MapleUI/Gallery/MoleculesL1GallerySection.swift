// MoleculesL1GallerySection.swift — Molecules L1 tab: specimen cards for
// wave A3a's 19 molecules (catalog §2.1 Form & entry, §2.2 Selection, §2.3
// Feedback & messaging). Card bodies are split across
// MoleculesL1FormGallery.swift / MoleculesL1SelectionGallery.swift /
// MoleculesL1FeedbackGallery.swift (this type's `extension`s) to keep any
// one file under the repo's ~400-line soft budget.

import SwiftUI

struct MoleculesL1GallerySection: View {
    let columns = [GridItem(.adaptive(minimum: 220), spacing: MuiTokens.spacingMd, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            MuiText("Form & entry, Selection, Feedback & messaging", variant: .eyebrow, color: .muted)
            LazyVGrid(columns: columns, alignment: .leading, spacing: MuiTokens.spacingMd) {
                formFieldCard
                inlineRenameFieldCard
                searchBarCard
                sliderCard
                livingSliderCard
                dragBarCard
                colorWheelCard
                pad2DCard

                chipRowCard
                tabsCard
                treeRowCard
                listRowCard
                ratingFlagsCard

                bannerCard
                toastContainerCard
                emptyStateCard
                valueChipCard
                valueHUDCard
                frameTimeHUDCard
            }
        }
    }
}

#Preview {
    ScrollView {
        MoleculesL1GallerySection().padding()
    }
    .background(MuiTokens.bg)
}
