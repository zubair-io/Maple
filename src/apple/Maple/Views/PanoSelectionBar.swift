// PanoSelectionBar.swift — Bottom action bar shown during multi-select mode.
//
// Floats above the BrowseGrid content. Surfaces the selection count,
// "Merge to panorama…" CTA, and a "Select All" / "Deselect All" toggle.
//
// Ticket: #1236 / Part of #1234

import SwiftUI
import MapleCore

// MARK: - PanoSelectionBar

struct PanoSelectionBar: View {
    let vm: BrowseViewModel
    /// Fired when the user taps "Merge to panorama…" with ≥2 selected.
    let onMerge: () -> Void
    /// Fired when the user taps "Edit Metadata…". nil hides the button.
    let onEditMetadata: (() -> Void)?
    /// #944: pastes every adjustment group from the clipboard onto the
    /// checked selection. nil hides the button (clipboard not wired).
    var onPasteAdjustments: (() -> Void)? = nil
    /// #944: opens the group-picker sheet for a selective paste. nil hides
    /// the button.
    var onPasteSelectedGroups: (() -> Void)? = nil
    /// #944: applies the focused image's current edit across the rest of
    /// the selection, no prior copy needed. nil hides the button.
    var onSyncSettings: (() -> Void)? = nil
    /// Enabled state for the two paste buttons — true when the clipboard
    /// has contents AND at least one asset is checked.
    var canPaste: Bool = false
    /// Enabled state for "Sync Settings" — true when a focused image AND
    /// at least one other checked asset are both present.
    var canSync: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 16) {
                // Left: select-all / deselect-all
                // Guard on !assets.isEmpty: when both selectedIDs.count and
                // assets.count are 0 the condition is vacuously true and
                // "Deselect All" would appear with nothing to deselect.
                let allSelected = !vm.assets.isEmpty && vm.selectedIDs.count == vm.assets.count
                Button {
                    if allSelected {
                        vm.clearSelection()
                    } else {
                        vm.assets.forEach { vm.select($0.id) }
                    }
                } label: {
                    Text(allSelected ? "Deselect All" : "Select All")
                        .font(.subheadline)
                }
                .disabled(vm.assets.isEmpty)
                .accessibilityLabel(allSelected
                    ? "Deselect all images"
                    : "Select all images")

                Spacer()

                // Center: count label
                Text(countLabel)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("\(vm.selectedIDs.count) images selected")

                Spacer()

                // Right: Edit Metadata CTA (optional — nil suppresses the button)
                if let onEditMetadata {
                    Button {
                        onEditMetadata()
                    } label: {
                        Label("Edit Metadata\u{2026}", systemImage: "pencil.and.list.clipboard")
                            .font(.subheadline.weight(.medium))
                    }
                    .disabled(vm.selectedIDs.isEmpty)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Edit metadata for \(vm.selectedIDs.count) selected images")
                }

                // Right: sync settings CTA (#944) — applies the focused image's
                // current edit across the rest of the selection, no copy needed.
                if let onSyncSettings {
                    Button {
                        onSyncSettings()
                    } label: {
                        Label("Sync Settings\u{2026}", systemImage: "arrow.triangle.2.circlepath")
                            .font(.subheadline.weight(.medium))
                    }
                    .disabled(!canSync)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Sync adjustments from the focused image to the rest of the selection")
                    .accessibilityHint(canSync
                        ? "Double tap to apply"
                        : "Select a focused image plus at least one other image to enable")
                }

                // Right: paste-selected-groups CTA (#944) — opens the group
                // picker sheet for a selective paste.
                if let onPasteSelectedGroups {
                    Button {
                        onPasteSelectedGroups()
                    } label: {
                        Label("Paste Selected\u{2026}", systemImage: "list.bullet.clipboard")
                            .font(.subheadline.weight(.medium))
                    }
                    .disabled(!canPaste)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Paste selected adjustment groups onto the selected images")
                    .accessibilityHint(canPaste
                        ? "Double tap to choose which groups to paste"
                        : "Copy adjustments and select at least one image to enable")
                }

                // Right: paste-adjustments CTA (#944) — pastes every group
                // from the clipboard onto the checked selection.
                if let onPasteAdjustments {
                    Button {
                        onPasteAdjustments()
                    } label: {
                        Label("Paste Adjustments", systemImage: "doc.on.clipboard")
                            .font(.subheadline.weight(.medium))
                    }
                    .disabled(!canPaste)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Paste all copied adjustments onto \(vm.selectedIDs.count) selected images")
                    .accessibilityHint(canPaste
                        ? "Double tap to apply"
                        : "Copy adjustments and select at least one image to enable")
                }

                // Right: merge CTA
                Button {
                    onMerge()
                } label: {
                    Label("Merge to Panorama\u{2026}", systemImage: "photo.stack")
                        .font(.subheadline.weight(.medium))
                }
                .disabled(!vm.canMergePanorama)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .accessibilityLabel("Merge \(vm.selectedIDs.count) selected images into a panorama")
                .accessibilityHint(vm.canMergePanorama
                    ? "Double tap to open panorama merge view"
                    : "Select at least 2 images to enable")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial)
        }
    }

    private var countLabel: String {
        switch vm.selectedIDs.count {
        case 0:  return "Nothing selected"
        case 1:  return "1 selected"
        default: return "\(vm.selectedIDs.count) selected"
        }
    }
}
