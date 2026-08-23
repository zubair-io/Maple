// MuiPageDocument.swift — Maple UI Pages (unified-component-catalog.md
// §6). Split Layout hosting a Sidebar of documents, a Rich Text Editor
// body, a Backlinks Panel, and a Version History Panel. Models Maple's
// journal/notes surface — a trip journal entry per sidebar row, each with
// its own body text, inbound references, and edit history.
//
// Cross-organism wiring that's genuinely new at this tier: picking a
// different document in the Sidebar swaps which document's body,
// backlinks, and version list the other three organisms show — a single
// `activeDocumentId` drives all three. `MuiPageDocument.document(for:in:)`
// is the pure lookup behind that swap.

import SwiftUI

public struct MuiPageDocumentEntry: Identifiable, Sendable {
    public let id: String
    public let title: String
    public var body: String
    public let backlinks: [MuiBacklinkItem]
    public let versions: [MuiVersionItem]

    public init(id: String, title: String, body: String, backlinks: [MuiBacklinkItem], versions: [MuiVersionItem]) {
        self.id = id
        self.title = title
        self.body = body
        self.backlinks = backlinks
        self.versions = versions
    }
}

public struct MuiPageDocument: View {
    public let documents: [MuiPageDocumentEntry]

    @State private var activeDocumentId: String?
    @State private var expandedIds: [String] = []
    @State private var detailTabId = "backlinks"
    @State private var workingDocuments: [MuiPageDocumentEntry]

    public init(documents: [MuiPageDocumentEntry] = MuiPageDocument.defaultDocuments) {
        self.documents = documents
        self._activeDocumentId = State(initialValue: documents.first?.id)
        self._workingDocuments = State(initialValue: documents)
    }

    private var activeDocument: MuiPageDocumentEntry? {
        Self.document(for: activeDocumentId, in: workingDocuments)
    }

    private var sections: [MuiSidebarSection] {
        [MuiSidebarSection(id: "journal", label: "TRIP JOURNAL", nodes: documents.map {
            MuiSidebarNode(id: $0.id, label: $0.title, icon: "note.text")
        })]
    }

    public var body: some View {
        MuiSplitLayout(sidebarWidth: .constant(220), detailWidth: .constant(280)) {
            MuiSidebar(sections: sections, activeId: $activeDocumentId, expandedIds: $expandedIds)
        } center: {
            if let activeDocument {
                MuiRichTextEditor(value: bodyBinding(for: activeDocument.id))
                    .padding(MuiTokens.spacingLg)
            } else {
                MuiEmptyState(icon: "note.text", title: "No document selected")
            }
        } detail: {
            MuiInspectorPanel(
                title: activeDocument?.title ?? "Document",
                tabs: [MuiTab(id: "backlinks", label: "Backlinks"), MuiTab(id: "history", label: "History")],
                showBack: false,
                activeTabId: $detailTabId
            ) {
                if detailTabId == "backlinks" {
                    MuiBacklinksPanel(links: activeDocument?.backlinks ?? [])
                } else {
                    MuiVersionHistoryPanel(versions: activeDocument?.versions ?? [])
                }
            }
        }
        .background(MuiTokens.bg)
    }

    private func bodyBinding(for id: String) -> Binding<String> {
        Binding(
            get: { workingDocuments.first(where: { $0.id == id })?.body ?? "" },
            set: { newValue in
                if let idx = workingDocuments.firstIndex(where: { $0.id == id }) {
                    workingDocuments[idx].body = newValue
                }
            }
        )
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// The document the Sidebar's active id refers to — `nil` when nothing
    /// is selected or the id no longer matches anything (a document that
    /// was removed out from under an open selection).
    public static func document(for id: String?, in documents: [MuiPageDocumentEntry]) -> MuiPageDocumentEntry? {
        guard let id else { return nil }
        return documents.first { $0.id == id }
    }

    // MARK: - Default mock data

    public static let defaultDocuments: [MuiPageDocumentEntry] = [
        MuiPageDocumentEntry(
            id: "iceland",
            title: "Iceland — March 2026",
            body: "A lone hiker crosses a black-sand beach at dusk, the glacier lagoon glowing behind. Shot the whole set at f/8 for the sea stacks.",
            backlinks: [
                MuiBacklinkItem(id: "1", icon: "rectangle.stack", label: "2026 Portfolio Board", subtitle: "Referenced in 2 cards"),
                MuiBacklinkItem(id: "2", icon: "photo.on.rectangle", label: "Iceland — Final Selects album"),
            ],
            versions: [
                MuiVersionItem(id: "v3", label: "Current draft", timestampValue: Date(), current: true),
                MuiVersionItem(id: "v2", label: "Added Reynisfjara notes", timestampValue: Date().addingTimeInterval(-86_400)),
                MuiVersionItem(id: "v1", label: "First draft", timestampValue: Date().addingTimeInterval(-172_800)),
            ]
        ),
        MuiPageDocumentEntry(
            id: "faroe",
            title: "Faroe Islands — April 2026",
            body: "Fog rolled in over the fjords just as the light broke through. Need to revisit the village shots — underexposed by about a stop.",
            backlinks: [
                MuiBacklinkItem(id: "3", icon: "rectangle.stack", label: "2026 Portfolio Board"),
            ],
            versions: [
                MuiVersionItem(id: "v1", label: "Current draft", timestampValue: Date().addingTimeInterval(-3_600), current: true),
            ]
        ),
    ]
}

#Preview("MuiPageDocument") {
    MuiPageDocument()
        .frame(width: 900, height: 520)
}
