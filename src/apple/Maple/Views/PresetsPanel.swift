// PresetsPanel.swift — presets list + save/apply/delete (#1115, spec §10.7).
//
// Shared content for both presentations of the presets pill: projected
// into the S1c bottom sheet on iPhone/iPad (`mapleBottomSheet`) and into
// a popover on macOS — see EditorView. Lists built-ins (read-only) and
// user presets; applying routes through `EditorState.applyPreset`
// (sparse merge → ONE undo entry → existing debounced sidecar save).
//
// Delete is two-step: the ✕ affordance flips the row into an inline
// "Delete?" confirm — no system alert.

import SwiftUI
import MapleCore

struct PresetsPanel: View {
    @Bindable var state: EditorState
    let store: PresetStore
    var onApplied: () -> Void = {}

    @State private var userPresets: [Preset] = []
    @State private var loaded = false
    @State private var draftName = ""
    @State private var errorText: String?
    @State private var confirmingDeleteID: String?

    /// Sparse capture of the current edit state — what "Save" would store.
    private var capturedFields: [String: PresetFieldValue] {
        state.capturePresetFields()
    }

    private var canSave: Bool {
        !capturedFields.isEmpty
            && Preset.normalizeName(draftName) != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Presets")
                .font(MapleTokens.Typography.sheetTitle)
                .foregroundStyle(MapleTokens.textMain)

            saveRow
            saveHint

            if let errorText {
                Text(errorText)
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.errorText)
                    .accessibilityIdentifier("presets-error")
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    section("Built-in")
                    ForEach(PresetStore.builtins) { preset in
                        presetRow(preset)
                    }

                    section("Saved")
                    if !loaded {
                        Text("Loading…")
                            .font(MapleTokens.Typography.body)
                            .foregroundStyle(MapleTokens.textMuted)
                            .accessibilityIdentifier("presets-loading")
                    } else if userPresets.isEmpty {
                        Text("Nothing saved yet — name your current edit above.")
                            .font(MapleTokens.Typography.body)
                            .foregroundStyle(MapleTokens.textMuted)
                            .accessibilityIdentifier("presets-empty")
                    } else {
                        ForEach(userPresets) { preset in
                            presetRow(preset)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityIdentifier("editor-presets-panel")
        .task { await load() }
    }

    // MARK: - Save row

    private var saveRow: some View {
        HStack(spacing: 8) {
            TextField("Preset name", text: $draftName)
                .textFieldStyle(.plain)
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMain)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(MapleTokens.inputBg)
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .overlay(
                    RoundedRectangle(cornerRadius: 7)
                        .stroke(MapleTokens.border, lineWidth: 0.5)
                )
                .onSubmit { if canSave { save() } }
                .accessibilityLabel("New preset name")
                .accessibilityIdentifier("preset-name-input")

            Button("Save") { save() }
                .buttonStyle(.plain)
                .font(MapleTokens.Typography.chipLabel)
                .foregroundStyle(canSave ? MapleTokens.primary : MapleTokens.textMuted)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(MapleTokens.surfaceAlt)
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .disabled(!canSave)
                .accessibilityLabel("Save preset")
                .accessibilityIdentifier("preset-save")
        }
    }

    private var saveHint: some View {
        let count = capturedFields.count
        return Text(
            count == 0
                ? "No edited settings to save — adjust something first."
                : "Saves \(count) edited setting\(count == 1 ? "" : "s")."
        )
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
        .accessibilityIdentifier("preset-save-hint")
    }

    // MARK: - Rows

    private func section(_ title: String) -> some View {
        Text(title.uppercased())
            .font(MapleTokens.Typography.eyebrow)
            .foregroundStyle(MapleTokens.textMuted)
            .padding(.top, 8)
    }

    @ViewBuilder
    private func presetRow(_ preset: Preset) -> some View {
        HStack(spacing: 8) {
            if confirmingDeleteID == preset.id {
                Text("Delete “\(preset.name)”?")
                    .font(MapleTokens.Typography.rowLabel)
                    .foregroundStyle(MapleTokens.textMain)
                Spacer(minLength: 4)
                iconButton(
                    systemName: "checkmark",
                    label: "Confirm delete \(preset.name)",
                    identifier: "preset-delete-confirm-\(preset.id)",
                    tint: MapleTokens.errorText
                ) { confirmDelete(preset) }
                iconButton(
                    systemName: "xmark",
                    label: "Cancel delete",
                    identifier: "preset-delete-cancel-\(preset.id)"
                ) { confirmingDeleteID = nil }
            } else {
                Button {
                    apply(preset)
                } label: {
                    HStack {
                        Text(preset.name)
                            .font(MapleTokens.Typography.rowLabel)
                            .foregroundStyle(MapleTokens.textMain)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(fieldSummary(preset))
                            .font(MapleTokens.Typography.body)
                            .foregroundStyle(MapleTokens.textMuted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Apply preset \(preset.name)")
                .accessibilityIdentifier("preset-apply-\(preset.id)")

                if !preset.builtIn {
                    iconButton(
                        systemName: "xmark",
                        label: "Delete preset \(preset.name)",
                        identifier: "preset-delete-\(preset.id)"
                    ) { confirmingDeleteID = preset.id }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(MapleTokens.surfaceAlt)
        .clipShape(RoundedRectangle(cornerRadius: MapleTokens.Radius.md))
    }

    private func iconButton(
        systemName: String,
        label: String,
        identifier: String,
        tint: Color = MapleTokens.textMuted,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    /// One-line summary of a preset's sparse fields, e.g. "2 settings".
    private func fieldSummary(_ preset: Preset) -> String {
        let n = preset.fields.count
        return n == 1 ? "1 setting" : "\(n) settings"
    }

    // MARK: - Actions

    private func load() async {
        do {
            userPresets = try await store.list()
        } catch {
            errorText = error.localizedDescription
        }
        loaded = true
    }

    private func apply(_ preset: Preset) {
        if state.applyPreset(preset) {
            onApplied()
        } else {
            errorText = "“\(preset.name)” has no settings this version can apply."
        }
    }

    private func save() {
        let name = draftName
        let fields = capturedFields
        Task {
            do {
                let created = try await store.save(name: name, fields: fields)
                userPresets = try await store.list()
                draftName = ""
                errorText = nil
                _ = created
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func confirmDelete(_ preset: Preset) {
        Task {
            do {
                try await store.delete(id: preset.id)
                userPresets.removeAll { $0.id == preset.id }
                confirmingDeleteID = nil
                errorText = nil
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}

#if DEBUG
#Preview("Presets panel") {
    let state = EditorState(session: EditSession.preview())
    return PresetsPanel(
        state: state,
        store: PresetStore(
            directory: FileManager.default.temporaryDirectory
                .appendingPathComponent("maple-presets-preview")
        )
    )
    .frame(width: 340, height: 480)
    .background(MapleTokens.surface)
}
#endif
