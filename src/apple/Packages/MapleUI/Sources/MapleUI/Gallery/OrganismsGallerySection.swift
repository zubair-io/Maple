// OrganismsGallerySection.swift — Organisms tab: specimen cards for every
// organism cataloged across §4.1-4.8. Wave A6a shipped §4.1-4.3
// (Collections, Navigation, Inspectors & panels — 23 organisms); wave A6b
// adds §4.4-4.8 (Modals, Editing surfaces, Map, Communication,
// Configuration — 32 organisms). Card bodies are split across
// OrganismsCollectionsGallery.swift / OrganismsNavigationGallery.swift /
// OrganismsPanelsGalleryA.swift / OrganismsPanelsGalleryB.swift /
// OrganismsModalsGalleryA.swift / OrganismsModalsGalleryB.swift /
// OrganismsEditingSurfacesGalleryA.swift /
// OrganismsEditingSurfacesGalleryB.swift /
// OrganismsMapCommsConfigGalleryA.swift /
// OrganismsMapCommsConfigGalleryB.swift (this type's sibling structs) to
// keep any one file under the repo's ~400-line soft budget — same split
// MoleculesL2GallerySection uses.

import SwiftUI

struct OrganismsGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            MuiText("All 55 Organisms — §4.1-4.8", variant: .eyebrow, color: .muted)

            sectionHeader("4.1 Collections")
            OrganismsCollectionsGallery()

            sectionHeader("4.2 Navigation")
            OrganismsNavigationGallery()

            sectionHeader("4.3 Inspectors & panels")
            OrganismsPanelsGalleryA()
            OrganismsPanelsGalleryB()

            sectionHeader("4.4 Modals")
            OrganismsModalsGalleryA()
            OrganismsModalsGalleryB()

            sectionHeader("4.5 Editing surfaces")
            OrganismsEditingSurfacesGalleryA()
            OrganismsEditingSurfacesGalleryB()

            sectionHeader("4.6 Map / 4.7 Communication / 4.8 Configuration")
            OrganismsMapCommsConfigGalleryA()
            OrganismsMapCommsConfigGalleryB()
        }
    }

    private func sectionHeader(_ label: String) -> some View {
        MuiText(label, variant: .toolLabel, color: .muted)
    }
}

/// A row of small labeled state boxes (Loading / Empty / Error) shown
/// beneath a specimen's populated card — only the organisms with real
/// data-fetch states get one of these; "always populated" controls
/// (Tool Dock, Color Grading Panel, …) don't need it.
struct OrganismStatesRow<Loading: View, Empty: View, Error: View>: View {
    @ViewBuilder let loading: Loading
    @ViewBuilder let empty: Empty
    @ViewBuilder let error: Error

    var body: some View {
        HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
            stateBox("Loading", loading)
            stateBox("Empty", empty)
            stateBox("Error", error)
        }
    }

    private func stateBox(_ label: String, _ content: some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MuiText(label, variant: .toolLabel, color: .muted)
            content
                .frame(maxWidth: .infinity)
                .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        }
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    ScrollView {
        OrganismsGallerySection().padding()
    }
    .background(MuiTokens.bg)
}
