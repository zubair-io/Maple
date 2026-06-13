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

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 16) {
                // Left: select-all / deselect-all
                Button {
                    if vm.selectedIDs.count == vm.assets.count {
                        vm.clearSelection()
                    } else {
                        vm.assets.forEach { vm.select($0.id) }
                    }
                } label: {
                    Text(vm.selectedIDs.count == vm.assets.count ? "Deselect All" : "Select All")
                        .font(.subheadline)
                }
                .accessibilityLabel(vm.selectedIDs.count == vm.assets.count
                    ? "Deselect all images"
                    : "Select all images")

                Spacer()

                // Center: count label
                Text(countLabel)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("\(vm.selectedIDs.count) images selected")

                Spacer()

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
