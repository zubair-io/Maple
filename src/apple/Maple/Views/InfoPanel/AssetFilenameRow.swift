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

  /// Draft text for the edit field. Seeded from the full filename when
  /// editing begins; not read outside editing.
  @State private var draft: String = ""
  @FocusState private var fieldFocused: Bool
  /// Non-nil while a submitted filename changes the extension and is
  /// awaiting a second confirm/cancel before it's actually committed.
  @State private var pendingExtensionChange: String?

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
      if isEditing {
        editingField
      } else {
        displayLabel
      }
      if let error = renameCtx?.errorText {
        Text(error)
          .font(MapleTokens.Typography.body)
          .foregroundStyle(MapleTokens.errorText)
          .accessibilityIdentifier("info-filename-error")
      } else if !isEditing, let unsupportedReason {
        Text(unsupportedReason)
          .font(MapleTokens.Typography.body)
          .foregroundStyle(MapleTokens.textMuted)
          .accessibilityIdentifier("info-filename-unsupported-reason")
      }
      if let pendingExtensionChange {
        extensionWarning(newFilename: pendingExtensionChange)
      }
    }
    .disabled(session == nil)
    .opacity(session == nil ? 0.5 : 1.0)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-filename")
    .onChange(of: asset?.id) { _, _ in
      // Asset switched under us (grid selection moved on) — drop local
      // edit/warning state so it can't leak onto the newly-focused asset.
      pendingExtensionChange = nil
      draft = ""
    }
  }

  // MARK: - Display

  private var displayLabel: some View {
    Text(asset.map(Self.fullFilename) ?? "—")
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

  // MARK: - Editing

  private var editingField: some View {
    TextField("Filename", text: $draft)
      .textFieldStyle(.plain)
      .font(MapleTokens.Typography.filename)
      .foregroundStyle(MapleTokens.textMain)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(MapleTokens.inputBg, in: RoundedRectangle(cornerRadius: 4))
      .overlay(RoundedRectangle(cornerRadius: 4).stroke(MapleTokens.borderHi, lineWidth: 1))
      .focused($fieldFocused)
      .onSubmit(submitDraft)
      .onKeyPress(.escape) {
        renameCtx?.cancel()
        return .handled
      }
      .accessibilityIdentifier("info-filename-field")
      .accessibilityLabel("Filename")
  }

  private func beginEditing() {
    guard let asset, let renameCtx else { return }
    guard renameCtx.unsupportedReason(asset) == nil else {
      // No editable field for an unsupported source — `begin` still runs so
      // its inline reason (renderred above) surfaces on the attempt, not
      // only as a passive hint.
      renameCtx.begin(asset)
      return
    }
    draft = Self.fullFilename(asset)
    renameCtx.begin(asset)
    // Defer focus by one runloop pass so SwiftUI mounts the field before the
    // focus binding claims it (same trick KeywordChipsRow's add field uses).
    DispatchQueue.main.async { fieldFocused = true }
  }

  private func submitDraft() {
    guard let asset, let renameCtx else { return }
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let original = Self.fullFilename(asset)
    guard trimmed != original else {
      renameCtx.cancel()
      return
    }
    let originalExt = (original as NSString).pathExtension.lowercased()
    let newExt = (trimmed as NSString).pathExtension.lowercased()
    if !originalExt.isEmpty, newExt != originalExt {
      pendingExtensionChange = trimmed
      return
    }
    renameCtx.commit(asset, trimmed)
  }

  // MARK: - Extension-change warning

  private func extensionWarning(newFilename: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Changing the file extension doesn't convert the file — it stays the same format.")
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
      HStack(spacing: 8) {
        Button("Cancel") { pendingExtensionChange = nil }
          .buttonStyle(.plain)
          .foregroundStyle(MapleTokens.textMuted)
          .accessibilityIdentifier("info-filename-extension-cancel")
        Button("Rename Anyway") {
          guard let asset else { return }
          pendingExtensionChange = nil
          renameCtx?.commit(asset, newFilename)
        }
        .buttonStyle(.plain)
        .foregroundStyle(MapleTokens.primary)
        .accessibilityIdentifier("info-filename-extension-confirm")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-filename-extension-warning")
  }

  // MARK: - Helpers

  /// The full on-disk / catalog filename (stem + extension). `AssetRef
  /// .displayName` is inconsistent about including the extension — stripped
  /// for `primaryURL`-backed refs (Filesystem), included as-is for
  /// bytes-backed refs (SMB/Cloud/PhotoKit, which pass the raw source
  /// filename straight through as `displayNameOverride`) — so this resolves
  /// the URL case explicitly rather than re-appending a guessed extension.
  static func fullFilename(_ asset: AssetRef) -> String {
    if let url = asset.primaryURL {
      return url.lastPathComponent
    }
    return asset.displayName
  }
}

// MARK: - Previews

#Preview("AssetFilenameRow — no session") {
  AssetFilenameRow(session: nil)
    .padding()
    .background(MapleTokens.bg)
}
