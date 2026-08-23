// MuiFilmPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Look catalog with strength, built
// from Chip Row, Card, Living Slider.

import SwiftUI

public struct MuiFilmLook: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let url: URL?
    public let category: String

    public init(id: String, name: String, url: URL?, category: String) {
        self.id = id
        self.name = name
        self.url = url
        self.category = category
    }
}

public struct MuiFilmPanel: View {
    /// Empty means "show all looks, no category filter row".
    public let categories: [MuiChip]
    public let looks: [MuiFilmLook]
    @Binding public var strength: Double
    @Binding public var activeCategoryId: String?
    @Binding public var selectedLookId: String?
    public let looksApplied: ((String) -> Void)?

    private let columns = [GridItem(.adaptive(minimum: 96), spacing: MuiTokens.spacingSm)]

    public init(
        categories: [MuiChip] = [],
        looks: [MuiFilmLook],
        strength: Binding<Double> = .constant(100),
        activeCategoryId: Binding<String?> = .constant(nil),
        selectedLookId: Binding<String?> = .constant(nil),
        looksApplied: ((String) -> Void)? = nil
    ) {
        self.categories = categories
        self.looks = looks
        self._strength = strength
        self._activeCategoryId = activeCategoryId
        self._selectedLookId = selectedLookId
        self.looksApplied = looksApplied
    }

    private var visibleLooks: [MuiFilmLook] {
        Self.visibleLooks(looks, activeCategoryId: activeCategoryId)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            if !categories.isEmpty {
                MuiChipRow(chips: categories, mode: .select, selectedId: $activeCategoryId)
            }

            if looks.isEmpty {
                MuiEmptyState(icon: "camera.filters", title: "No looks", message: "No film looks available.")
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: MuiTokens.spacingSm) {
                        ForEach(visibleLooks) { look in
                            MuiCard(
                                url: look.url,
                                alt: look.name,
                                title: look.name,
                                badgeLabel: look.id == selectedLookId ? "Selected" : nil,
                                pressed: { selectedLookId = look.id }
                            )
                            .simultaneousGesture(TapGesture(count: 2).onEnded { looksApplied?(look.id) })
                        }
                    }
                }

                MuiLivingSlider(label: "Strength", value: $strength, range: 0...100, step: 1, unit: "%")
            }
        }
        .padding(MuiTokens.spacingMd)
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func visibleLooks(_ looks: [MuiFilmLook], activeCategoryId: String?) -> [MuiFilmLook] {
        guard let activeCategoryId else { return looks }
        return looks.filter { $0.category == activeCategoryId }
    }
}

#Preview("MuiFilmPanel") {
    struct Demo: View {
        @State private var strength = 80.0
        @State private var category: String? = nil
        @State private var selected: String? = "kodak"
        var body: some View {
            MuiFilmPanel(
                categories: [MuiChip(id: "film", label: "Film"), MuiChip(id: "digital", label: "Digital")],
                looks: [
                    MuiFilmLook(id: "kodak", name: "Kodak Gold", url: nil, category: "film"),
                    MuiFilmLook(id: "portra", name: "Portra 400", url: nil, category: "film"),
                    MuiFilmLook(id: "flat", name: "Flat Digital", url: nil, category: "digital"),
                ],
                strength: $strength,
                activeCategoryId: $category,
                selectedLookId: $selected
            )
            .frame(width: 280, height: 320)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiFilmPanel — Empty") {
    MuiFilmPanel(looks: [])
        .frame(width: 280, height: 160)
        .background(MuiTokens.bg)
}
