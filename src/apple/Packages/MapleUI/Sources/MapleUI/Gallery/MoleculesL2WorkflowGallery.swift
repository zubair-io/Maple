// MoleculesL2WorkflowGallery.swift — Molecules L2 tab, catalog §3
// workflow group: Preview List, Progress Step, Suggestion Preview, Bot
// Output.

import SwiftUI

extension MoleculesL2GallerySection {
    var previewListCard: some View {
        GallerySpecimenCard(name: "Preview List", purpose: "Before -> after row list", builtFrom: "List Row, Text") {
            MuiPreviewList(items: [
                MuiPreviewItem(id: "1", before: "IMG_0042.dng", after: "iceland-glacier-01.dng"),
                MuiPreviewItem(id: "2", before: "IMG_0043.dng", after: "iceland-glacier-02.dng"),
            ])
        }
    }

    var progressStepCard: some View {
        GallerySpecimenCard(name: "Progress Step", purpose: "One step of a wizard", builtFrom: "Text, Progress, Button") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                MuiProgressStep(index: 1, label: "Select photos", status: .done)
                MuiProgressStep(index: 2, label: "Choose destination", status: .active)
                MuiProgressStep(index: 3, label: "Confirm", status: .pending)
            }
        }
    }

    var suggestionPreviewCard: some View {
        GallerySpecimenCard(name: "Suggestion Preview", purpose: "Proposed change with accept/reject", builtFrom: "Text, Button") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiSuggestionPreview(description: "Rename to \"iceland-glacier-01.dng\"")
                MuiSuggestionPreview(description: "Set place to Reykjavík", resolved: .accepted)
            }
        }
    }

    var botOutputCard: some View {
        GallerySpecimenCard(name: "Bot Output", purpose: "Streaming generated result", builtFrom: "Text, Progress, Avatar") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiBotOutput(text: "Likely taken at golden hour near a coastline.", streaming: true)
                MuiBotOutput(text: "Already-complete caption.", streaming: false)
            }
        }
    }
}
