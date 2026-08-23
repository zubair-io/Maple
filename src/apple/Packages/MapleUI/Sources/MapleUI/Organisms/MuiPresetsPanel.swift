// MuiPresetsPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Save, apply, delete presets, built
// from List Row, Button, Dialog. Delete and save both round-trip through
// a confirm/prompt `MuiDialog` rather than firing straight from the row —
// delete is destructive, save needs a name — so `dialogMode` tracks which
// (if either) of the two dialogs is open.

import SwiftUI

public struct MuiPresetItem: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let updatedAt: Date

    public init(id: String, name: String, updatedAt: Date) {
        self.id = id
        self.name = name
        self.updatedAt = updatedAt
    }
}

private enum MuiPresetsPanelDialogMode: Equatable {
    case none, confirmDelete, savePrompt
}

public struct MuiPresetsPanel: View {
    public let presets: [MuiPresetItem]
    public let loading: Bool
    public let applied: ((String) -> Void)?
    public let deleted: ((String) -> Void)?
    public let saved: ((String) -> Void)?

    @State private var dialogMode: MuiPresetsPanelDialogMode = .none
    @State private var pendingDeleteId: String?
    @State private var savePromptValue = ""

    public init(
        presets: [MuiPresetItem],
        loading: Bool = false,
        applied: ((String) -> Void)? = nil,
        deleted: ((String) -> Void)? = nil,
        saved: ((String) -> Void)? = nil
    ) {
        self.presets = presets
        self.loading = loading
        self.applied = applied
        self.deleted = deleted
        self.saved = saved
    }

    public var body: some View {
        ZStack {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    MuiText("Presets", variant: .eyebrow, color: .muted)
                    Spacer()
                    MuiButton(label: "Save…", variant: .ghost, size: .sm) { openSavePrompt() }
                }
                .padding(MuiTokens.spacingMd)

                if loading {
                    MuiSpinner(placement: .centered, label: "Loading presets")
                } else if presets.isEmpty {
                    MuiEmptyState(icon: "square.stack.3d.up", title: "No presets", message: "Save your first preset to reuse it later.")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(presets) { preset in
                                MuiListRow(label: preset.name, timestampValue: preset.updatedAt, pressed: { applied?(preset.id) }) {
                                    Button {
                                        pendingDeleteId = preset.id
                                        dialogMode = .confirmDelete
                                    } label: {
                                        MuiIcon(name: "trash", size: .sm, color: MuiTokens.errorText)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Delete \(preset.name)")
                                }
                            }
                        }
                    }
                }
            }

            MuiDialog(
                isPresented: dialogMode == .confirmDelete,
                title: "Delete preset?",
                message: "This can't be undone.",
                variant: .confirm,
                confirmLabel: "Delete",
                destructive: true,
                confirmed: { _ in confirmDelete() },
                dismissed: { dialogMode = .none }
            )

            MuiDialog(
                isPresented: dialogMode == .savePrompt,
                title: "Save preset",
                variant: .prompt,
                confirmLabel: "Save",
                promptPlaceholder: "Preset name",
                promptValue: $savePromptValue,
                confirmed: { confirmSave(name: $0) },
                dismissed: { dialogMode = .none }
            )
        }
    }

    private func openSavePrompt() {
        savePromptValue = ""
        dialogMode = .savePrompt
    }

    private func confirmDelete() {
        if let id = pendingDeleteId { deleted?(id) }
        dialogMode = .none
        pendingDeleteId = nil
    }

    private func confirmSave(name: String) {
        if let trimmed = Self.trimmedNonEmpty(name) { saved?(trimmed) }
        dialogMode = .none
    }

    // MARK: - Pure logic (unit-testable without a live view)

    /// The name to save — `nil` when the trimmed prompt value is blank,
    /// so the caller skips emitting `saved` for an empty submission.
    public static func trimmedNonEmpty(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

#Preview("MuiPresetsPanel") {
    MuiPresetsPanel(presets: [
        MuiPresetItem(id: "1", name: "Moody Landscape", updatedAt: Date().addingTimeInterval(-3600)),
        MuiPresetItem(id: "2", name: "Portrait Warm", updatedAt: Date().addingTimeInterval(-86400)),
    ])
    .frame(width: 260, height: 260)
    .background(MuiTokens.bg)
}

#Preview("MuiPresetsPanel — Loading / Empty") {
    VStack(spacing: 0) {
        MuiPresetsPanel(presets: [], loading: true).frame(height: 120)
        MuiDivider()
        MuiPresetsPanel(presets: []).frame(height: 160)
    }
    .background(MuiTokens.bg)
}
