// MuiLibraryPickerModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Remote filesystem browser, built on Overlay
// Shell from Toolbar (back/refresh actions), a breadcrumb row, Tree Row
// (flat folder/file listing), and Empty State — every data state (loading/
// error/empty/populated) is driven from an input, never hardcoded.

import SwiftUI

public enum MuiLibraryPickerEntryKind: Sendable {
    case folder, file
}

public struct MuiLibraryPickerEntry: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: MuiLibraryPickerEntryKind
    public let itemCount: Int?

    public init(id: String, name: String, kind: MuiLibraryPickerEntryKind, itemCount: Int? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.itemCount = itemCount
    }
}

public struct MuiLibraryPickerModal: View {
    public let isPresented: Bool
    public let contained: Bool
    public let pathSegments: [String]
    public let entries: [MuiLibraryPickerEntry]
    public let loading: Bool
    public let error: String?
    @Binding public var selectedId: String?
    public let entrySelected: ((String) -> Void)?
    public let folderOpened: ((String) -> Void)?
    public let chosen: (() -> Void)?
    public let backRequested: (() -> Void)?
    public let refreshRequested: (() -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        pathSegments: [String],
        entries: [MuiLibraryPickerEntry],
        loading: Bool = false,
        error: String? = nil,
        selectedId: Binding<String?>,
        entrySelected: ((String) -> Void)? = nil,
        folderOpened: ((String) -> Void)? = nil,
        chosen: (() -> Void)? = nil,
        backRequested: (() -> Void)? = nil,
        refreshRequested: (() -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.pathSegments = pathSegments
        self.entries = entries
        self.loading = loading
        self.error = error
        self._selectedId = selectedId
        self.entrySelected = entrySelected
        self.folderOpened = folderOpened
        self.chosen = chosen
        self.backRequested = backRequested
        self.refreshRequested = refreshRequested
        self.dismissed = dismissed
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Library Picker", contained: contained) {
            MuiText("Library Picker", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiToolbar(entries: toolbarEntries, itemSelected: handleToolbarAction)
                MuiText(pathSegments.isEmpty ? "/" : "/" + pathSegments.joined(separator: "/"), variant: .toolLabel, color: .muted)

                if let error {
                    MuiBanner(variant: .error, message: error)
                } else if loading {
                    MuiSpinner(placement: .centered, label: "Loading")
                } else if entries.isEmpty {
                    MuiEmptyState(icon: "folder", title: "This folder is empty")
                } else {
                    VStack(spacing: 0) {
                        ForEach(entries) { entry in
                            MuiTreeRow(
                                label: entry.name, icon: entry.kind == .folder ? "folder" : "doc",
                                count: entry.itemCount, active: entry.id == selectedId,
                                pressed: { onEntryPressed(entry) }
                            )
                        }
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Choose", variant: .primary, disabled: selectedId == nil) { chosen?() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private var toolbarEntries: [MuiToolbarEntry] {
        [.item(MuiToolbarActionItem(id: "back", icon: "chevron.left", label: "Back", disabled: pathSegments.isEmpty)),
         .item(MuiToolbarActionItem(id: "refresh", icon: "arrow.clockwise", label: "Refresh"))]
    }

    private func handleToolbarAction(_ id: String) {
        if id == "back" { backRequested?() }
        if id == "refresh" { refreshRequested?() }
    }

    private func onEntryPressed(_ entry: MuiLibraryPickerEntry) {
        if entry.kind == .folder {
            folderOpened?(entry.name)
            return
        }
        selectedId = entry.id
        entrySelected?(entry.id)
    }
}

#Preview("MuiLibraryPickerModal") {
    struct Demo: View {
        @State private var open = false
        @State private var selected: String?
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Library Picker", variant: .primary) { open = true }
                MuiLibraryPickerModal(
                    isPresented: open,
                    pathSegments: ["Volumes", "Photos"],
                    entries: [
                        MuiLibraryPickerEntry(id: "1", name: "2026", kind: .folder, itemCount: 4200),
                        MuiLibraryPickerEntry(id: "2", name: "manifest.json", kind: .file),
                    ],
                    selectedId: $selected,
                    dismissed: { open = false }
                )
            }
            .frame(width: 380, height: 340)
        }
    }
    return Demo()
}
