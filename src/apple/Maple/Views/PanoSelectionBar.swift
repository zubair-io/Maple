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
