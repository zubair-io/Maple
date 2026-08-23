// MapleUIGalleryView.swift — the in-app Maple UI catalog: a tier picker
// over Tokens / Atoms / Molecules L1 / Molecules L2 / Organisms / Templates
// / Pages, so a developer (or reviewer) can see every shipped atom and
// what's still coming, without leaving the app.
//
// Wired in from Settings — see `SettingsView` (macOS/iPadOS) and
// `PhoneSettingsView` (iPhone) in the Maple app target.

import SwiftUI

private enum GalleryTier: String, CaseIterable, Identifiable {
    case tokens = "Tokens"
    case atoms = "Atoms"
    case moleculesL1 = "Molecules L1"
    case moleculesL2 = "Molecules L2"
    case organisms = "Organisms"
    case templates = "Templates"
    case pages = "Pages"

    var id: String { rawValue }
}

public struct MapleUIGalleryView: View {
    @State private var tier: GalleryTier = .tokens

    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            Picker("Tier", selection: $tier) {
                ForEach(GalleryTier.allCases) { tier in
                    Text(tier.rawValue).tag(tier)
                }
            }
            .pickerStyle(.segmented)
            .padding(MuiTokens.spacingMd)

            ScrollView {
                content
                    .padding(.horizontal, MuiTokens.spacingMd)
                    .padding(.bottom, MuiTokens.spacingXl)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(MuiTokens.bg)
        .navigationTitle("Maple UI Gallery")
    }

    @ViewBuilder
    private var content: some View {
        switch tier {
        case .tokens:
            TokensGalleryView()
        case .atoms:
            AtomsGalleryView()
        case .moleculesL1:
            unbuiltTier(names: GalleryCatalog.moleculesL1)
        case .moleculesL2:
            unbuiltTier(names: GalleryCatalog.moleculesL2)
        case .organisms:
            unbuiltTier(names: GalleryCatalog.organisms)
        case .templates:
            unbuiltTier(names: GalleryCatalog.templates)
        case .pages:
            unbuiltTier(names: GalleryCatalog.pages)
        }
    }

    private func unbuiltTier(names: [String]) -> some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiText("Coming in a later wave", variant: .eyebrow, color: .muted)
            GalleryPlaceholderSection(names: names)
        }
    }
}

#Preview("MapleUIGalleryView") {
    NavigationStack {
        MapleUIGalleryView()
    }
    .preferredColorScheme(.dark)
}
