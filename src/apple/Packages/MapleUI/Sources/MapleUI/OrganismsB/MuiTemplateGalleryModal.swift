// MuiTemplateGalleryModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Browse and apply an edit template, built on
// Overlay Shell from Search Bar, Card, Empty State.

import SwiftUI

public struct MuiGalleryTemplate: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let thumbnailUrl: URL?
    public let description: String?
    public let category: String?

    public init(id: String, name: String, thumbnailUrl: URL?, description: String? = nil, category: String? = nil) {
        self.id = id
        self.name = name
        self.thumbnailUrl = thumbnailUrl
        self.description = description
        self.category = category
    }
}

public struct MuiTemplateGalleryModal: View {
    public let isPresented: Bool
    public let contained: Bool
    public let templates: [MuiGalleryTemplate]
    @Binding public var search: String
    public let templateApplied: ((MuiGalleryTemplate) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        templates: [MuiGalleryTemplate],
        search: Binding<String>,
        templateApplied: ((MuiGalleryTemplate) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.templates = templates
        self._search = search
        self.templateApplied = templateApplied
        self.dismissed = dismissed
    }

    private var filtered: [MuiGalleryTemplate] {
        Self.filtered(templates, search: search)
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, size: .lg, accessibilityLabel: "Template Gallery", contained: contained) {
            MuiText("Template Gallery", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                MuiSearchBar(value: $search, placeholder: "Search templates…")

                if filtered.isEmpty {
                    MuiEmptyState(icon: "square.grid.2x2", title: "No templates found")
                } else {
                    let columns = [GridItem(.adaptive(minimum: 140), spacing: MuiTokens.spacingSm)]
                    LazyVGrid(columns: columns, spacing: MuiTokens.spacingSm) {
                        ForEach(filtered) { template in
                            MuiCard(
                                url: template.thumbnailUrl, alt: template.name, title: template.name,
                                subtitle: template.category, pressed: { templateApplied?(template) }
                            )
                        }
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Close", variant: .ghost) { dismissed?() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    /// Templates whose name, description, or category matches `search`,
    /// case-insensitively — all templates when `search` is blank. Public +
    /// static so this is unit-testable without rendering a view.
    public static func filtered(_ templates: [MuiGalleryTemplate], search: String) -> [MuiGalleryTemplate] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return templates }
        return templates.filter {
            let haystack = "\($0.name) \($0.description ?? "") \($0.category ?? "")".lowercased()
            return haystack.contains(query)
        }
    }
}

#Preview("MuiTemplateGalleryModal") {
    struct Demo: View {
        @State private var open = false
        @State private var search = ""
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Template Gallery", variant: .primary) { open = true }
                MuiTemplateGalleryModal(
                    isPresented: open,
                    templates: [
                        MuiGalleryTemplate(id: "1", name: "Moody Landscape", thumbnailUrl: nil, category: "Landscape"),
                        MuiGalleryTemplate(id: "2", name: "Portrait Warm", thumbnailUrl: nil, category: "Portrait"),
                    ],
                    search: $search,
                    dismissed: { open = false }
                )
            }
            .frame(width: 420, height: 380)
        }
    }
    return Demo()
}
