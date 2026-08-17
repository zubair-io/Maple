// AssetFilenameRow.swift — S6 Info content, inline single-asset rename
// (#2638, design doc § "Rename").
//
// New Info panel section, ABOVE RatingFlagsRow — the filename is the asset's
// primary identity, so it reads first. Two entry points:
//   • Double-click the static label.
//   • Enter on the selected asset in the Browse grid (AppShell's Enter-key
//     shortcut calls the same `\.assetRename` action, which flips this row
//     into edit mode via `renamingAssetID`).
//
// Editing shows the FULL filename (stem + extension) in one field, matching
// Finder's rename convention. Enter commits; Escape cancels. If the
// extension changed, commit is held behind an inline confirm/cancel warning
// (the design doc: retyping the extension is allowed but warns, since it
// doesn't transcode anything) rather than committing immediately.
//
// All the actual routing/file-op work lives behind the `\.assetRename`
// environment action (`AppShell+AssetRename.swift`) — this view is display
// + local edit-field state only.

import MapleCore
import SwiftUI

// MARK: - AssetFilenameRow

struct AssetFilenameRow: View {
  /// Live session — `nil` when no asset is focused. Matches the disabled
  /// pattern the other Info sections use so the layout doesn't jump.
  let session: EditSession?

  @Environment(\.assetRename) private var renameCtx

  private var asset: AssetRef? { session?.asset }

  private var isEditing: Bool {
    guard let asset, let renameCtx else { return false }
    return renameCtx.isRenaming(asset)
  }

  private var unsupportedReason: String? {
    guard let asset, let renameCtx else { return nil }
    return renameCtx.unsupportedReason(asset)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if isEditing, let asset {
        InlineRenameField(asset: asset, idPrefix: "info-filename")
          // Forces the field's internal draft/warning @State to reset if
          // the underlying asset identity ever changes while this branch
          // stays structurally in place (defense in depth — `isEditing`
          // already gates this to the SAME id, since `renameCtx
          // .isRenaming` compares against `asset.id`).
          .id(asset.id)
      } else {
        displayLabel
        if let unsupportedReason {
          Text(unsupportedReason)
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.textMuted)
            .accessibilityIdentifier("info-filename-unsupported-reason")
        }
      }
    }
    .disabled(session == nil)
    .opacity(session == nil ? 0.5 : 1.0)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-filename")
  }

  // MARK: - Display

  private var displayLabel: some View {
    Text(asset.map(\.fullFilename) ?? "—")
      .font(MapleTokens.Typography.filename)
      .foregroundStyle(MapleTokens.textMain)
      .lineLimit(2)
      .truncationMode(.middle)
      .textSelection(.enabled)
      .contentShape(Rectangle())
      .onTapGesture(count: 2) { beginEditing() }
      .accessibilityIdentifier("info-filename-display")
      .accessibilityLabel("Filename")
      .accessibilityHint(unsupportedReason ?? "Double-click to rename")
  }

  // MARK: - Editing entry point

  private func beginEditing() {
    guard let asset, let renameCtx else { return }
    // `begin` still runs even when unsupported — its inline reason
    // (rendered above) surfaces on the attempt, not only as a passive
    // hint, and `InlineRenameField` never mounts because `isEditing` stays
    // false when `renameCtx` records no `renamingAssetID`.
    renameCtx.begin(asset)
  }
}

// MARK: - Previews

#Preview("AssetFilenameRow — no session") {
  AssetFilenameRow(session: nil)
    .padding()
    .background(MapleTokens.bg)
}
