// PanoSelectionBar.swift — Bottom action bar shown during multi-select mode.
//
// Floats above the BrowseGrid content. Surfaces the selection count,
// "Merge to panorama…" CTA, and a "Select All" / "Deselect All" toggle.
//
// Ticket: #1236 / Part of #1234
//
// Buttons migrated onto MapleUI's `MuiButton` (Maple UI adoption epic
// #3019, MA4) — this is regular in-content chrome (unlike the OS-native
// `ToolbarItem`/`ToolbarContent` buttons in `AppShellToolbar.swift` /
// `AppShellIPhoneToolbar.swift`, which stay hand-rolled: `MuiButton` paints
// its own filled/bordered pill background, and wrapping a native macOS/iOS
// titlebar or nav-bar `ToolbarItem` around one would double-chrome a
// design-system button inside the system's own toolbar material). Each
// button's richer accessibility label/hint (e.g. "Merge N selected images
// into a panorama") is layered on as an external `.accessibilityLabel`/
// `.accessibilityHint` modifier after construction — the last one applied
// wins, overriding `MuiButton`'s own default (its visible label text).

import MapleCore
import MapleUI
import SwiftUI

// MARK: - PanoSelectionBar

struct PanoSelectionBar: View {
  let vm: BrowseViewModel
  /// Fired when the user taps "Merge to panorama…" with ≥2 selected.
  let onMerge: () -> Void
  /// Fired when the user taps "Edit Metadata…". nil hides the button.
  let onEditMetadata: (() -> Void)?
  /// Fired when the user taps "Batch Rename…" (#2641). nil hides the button.
  var onBatchRename: (() -> Void)? = nil
  /// #944: pastes every adjustment group from the clipboard onto the
  /// checked selection. nil hides the button (clipboard not wired).
  var onPasteAdjustments: (() -> Void)? = nil
  var onCopyAdjustments: (() -> Void)? = nil
  /// #944: applies the focused image's current edit across the rest of
  /// the selection, no prior copy needed. nil hides the button.
  var onSyncSettings: (() -> Void)? = nil
  /// Enabled state for the paste button — true when the clipboard
  /// has contents AND at least one asset is checked.
  var canPaste: Bool = false
  /// Enabled state for "Sync Settings" — true when a focused image AND
  /// at least one other checked asset are both present.
  var canSync: Bool = false

  var body: some View {
    VStack(spacing: 0) {
      Divider()
      ScrollView(.horizontal) {
        HStack(spacing: 16) {
          // Left: select-all / deselect-all
          // Guard on !assets.isEmpty: when both selectedIDs.count and
          // assets.count are 0 the condition is vacuously true and
          // "Deselect All" would appear with nothing to deselect.
          let allSelected = !vm.assets.isEmpty && vm.selectedIDs.count == vm.assets.count
          MuiButton(
            label: allSelected ? "Deselect All" : "Select All",
            variant: .ghost,
            size: .sm,
            disabled: vm.assets.isEmpty
          ) {
            if allSelected {
              vm.clearSelection()
            } else {
              for asset in vm.assets { vm.select(asset.id) }
            }
          }
          .accessibilityLabel(
            allSelected
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
            MuiButton(
              label: "Edit Metadata\u{2026}",
              variant: .secondary,
              size: .sm,
              leadingIcon: "pencil.and.list.clipboard",
              disabled: vm.selectedIDs.isEmpty,
              action: onEditMetadata
            )
            .accessibilityLabel("Edit metadata for \(vm.selectedIDs.count) selected images")
          }

          // Right: Batch Rename CTA (#2641, optional — nil suppresses the button)
          if let onBatchRename {
            MuiButton(
              label: "Batch Rename\u{2026}",
              variant: .secondary,
              size: .sm,
              leadingIcon: "textformat",
              disabled: vm.selectedIDs.isEmpty,
              action: onBatchRename
            )
            .accessibilityIdentifier("pano-selection-bar-batch-rename")
            .accessibilityLabel("Batch rename \(vm.selectedIDs.count) selected images")
          }

          // Right: sync settings CTA (#944) — applies the focused image's
          // current edit across the rest of the selection, no copy needed.
          if let onSyncSettings {
            MuiButton(
              label: "Sync Settings\u{2026}",
              variant: .secondary,
              size: .sm,
              leadingIcon: "arrow.triangle.2.circlepath",
              disabled: !canSync,
              action: onSyncSettings
            )
            .accessibilityLabel(
              "Sync adjustments from the focused image to the rest of the selection"
            )
            .accessibilityHint(
              canSync
                ? "Double tap to apply"
                : "Select a focused image plus at least one other image to enable")
          }

          if let onCopyAdjustments {
            MuiButton(
              label: "Copy Settings",
              variant: .secondary,
              size: .sm,
              leadingIcon: "doc.on.doc",
              disabled: vm.selectedAsset == nil,
              action: onCopyAdjustments
            )
            .accessibilityLabel(
              "Copy settings from \(vm.selectedAsset?.displayName ?? "the focused photo")"
            )
            .accessibilityIdentifier("batch-copy-settings")
          }

          // Right: paste-adjustments CTA (#944) — pastes every group
          // from the clipboard onto the checked selection.
          if let onPasteAdjustments {
            MuiButton(
              label: "Paste Settings…",
              variant: .secondary,
              size: .sm,
              leadingIcon: "doc.on.clipboard",
              disabled: !canPaste,
              action: onPasteAdjustments
            )
            .accessibilityLabel(
              "Paste all copied adjustments onto \(vm.selectedIDs.count) selected images"
            )
            .accessibilityHint(
              canPaste
                ? "Double tap to apply"
                : "Copy adjustments and select at least one image to enable")
          }

          // Right: merge CTA
          MuiButton(
            label: "Merge to Panorama\u{2026}",
            variant: .primary,
            size: .sm,
            leadingIcon: "photo.stack",
            disabled: !vm.canMergePanorama,
            action: onMerge
          )
          .accessibilityLabel("Merge \(vm.selectedIDs.count) selected images into a panorama")
          .accessibilityHint(
            vm.canMergePanorama
              ? "Double tap to open panorama merge view"
              : "Select at least 2 images to enable")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
      }
      .background(.regularMaterial)
    }
  }

  private var countLabel: String {
    switch vm.selectedIDs.count {
    case 0: return "Nothing selected"
    case 1: return "1 selected"
    default: return "\(vm.selectedIDs.count) selected"
    }
  }
}
