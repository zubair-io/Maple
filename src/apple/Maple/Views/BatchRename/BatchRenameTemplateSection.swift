// BatchRenameTemplateSection.swift — template field, token insert buttons,
// sequence start/padding, and collision picker for the Batch Rename sheet
// (#2641, design doc § "Rename" — batch).

import SwiftUI
import MapleCore

// MARK: - BatchRenameTemplateSection

struct BatchRenameTemplateSection: View {
    @Bindable var vm: BatchRenameViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            templateField
            tokenButtons
            HStack(spacing: 16) {
                sequenceStartField
                sequencePadWidthField
            }
            collisionPicker
        }
        .padding(16)
    }

    // MARK: - Template field

    private var templateField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Template")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField("{original}", text: $vm.template)
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
                .accessibilityIdentifier("batch-rename-template-field")
                .accessibilityLabel("Rename template")
        }
    }

    // MARK: - Token buttons

    /// Inserts a token at the end of the template — the engine has no
    /// escape sequence for a literal `{`/`}` (by design, see
    /// `raw_core::filename::parse_template`'s doc comment: tokens are meant
    /// to be inserted via a button/dropdown, not free-typed), so these
    /// buttons are the only supported way to add one.
    private var tokenButtons: some View {
        HStack(spacing: 8) {
            tokenButton("{original}", identifier: "batch-rename-token-original")
            tokenButton("{n}", identifier: "batch-rename-token-sequence")
            tokenButton("{date:%Y-%m-%d}", identifier: "batch-rename-token-date")
            tokenButton("{ext}", identifier: "batch-rename-token-ext")
            Spacer()
        }
    }

    private func tokenButton(_ token: String, identifier: String) -> some View {
        Button(token) { vm.template += token }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .font(.system(.caption, design: .monospaced))
            .accessibilityIdentifier(identifier)
            .accessibilityLabel("Insert \(token) token")
    }

    // MARK: - Sequence options

    /// A negative value here would reach `UInt64(...)`/`UInt(...)` inside
    /// `FilenameTemplateEngine.render` — that boundary now clamps
    /// defensively rather than trapping, but the field itself refuses to
    /// hold a negative number in the first place, so the user sees the
    /// field snap back to `0` immediately instead of the value silently
    /// changing out from under them only once a rename is attempted.
    private var sequenceStartBinding: Binding<Int> {
        Binding(get: { vm.sequenceStart }, set: { vm.sequenceStart = max(0, $0) })
    }

    /// Same non-negative guard as `sequenceStartBinding`. Deliberately does
    /// NOT clamp an over-large value (above the engine's own 32-digit
    /// bound) — that's left to reach `FilenameTemplateEngine.render`, which
    /// rejects it with a typed `.sequencePadWidthTooLarge` error the
    /// preview list surfaces per item, rather than this field silently
    /// capping a width the user explicitly typed.
    private var sequencePadWidthBinding: Binding<Int> {
        Binding(get: { vm.sequencePadWidth }, set: { vm.sequencePadWidth = max(0, $0) })
    }

    private var sequenceStartField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Start at")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField(
                "1", value: sequenceStartBinding,
                format: .number.grouping(.never)
            )
            .textFieldStyle(.roundedBorder)
            .frame(width: 80)
            #if os(iOS)
            .keyboardType(.numberPad)
            #endif
            .accessibilityIdentifier("batch-rename-sequence-start-field")
            .accessibilityLabel("Sequence start number")
        }
    }

    private var sequencePadWidthField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Pad digits")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField(
                "0", value: sequencePadWidthBinding,
                format: .number.grouping(.never)
            )
            .textFieldStyle(.roundedBorder)
            .frame(width: 80)
            #if os(iOS)
            .keyboardType(.numberPad)
            #endif
            .accessibilityIdentifier("batch-rename-sequence-pad-field")
            .accessibilityLabel("Sequence number padding width")
        }
    }

    // MARK: - Collision policy

    private var collisionPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("On name collision")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Picker("On name collision", selection: $vm.collision) {
                ForEach(BatchRenameCollisionChoice.allCases) { choice in
                    Text(choice.label).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("batch-rename-collision-picker")
        }
    }
}

// MARK: - Preview

#Preview {
    BatchRenameTemplateSection(
        vm: BatchRenameViewModel(
            assets: [AssetRef(url: URL(fileURLWithPath: "/tmp/test.dng"))],
            routing: .filesystem
        )
    )
}
