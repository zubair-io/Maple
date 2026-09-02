// InlineRenameField.swift — the actual edit-mode UI for single-asset rename
// (#2638 Info panel, #2842 Browse grid), shared by every host surface.
//
// `AssetFilenameRow` (Info panel) and `GridCellRenameCaption` (Browse grid,
// #2842) each own their OWN static-label chrome — where the filename sits,
// what it looks like, how the double-click/double-tap gesture is wired —
// but both hand off to this ONE view once editing begins, so the actual
// rename mechanics (draft seeding, focus, submit, extension-change warning,
// error surfacing) exist exactly once. Routes everything through the
// `\.assetRename` environment action (`AppShell+AssetRename.swift`) — this
// view has no file-op logic of its own.
//
// `idPrefix` namespaces accessibility identifiers per host so each surface
// keeps its own stable IDs (Info panel: "info-filename-field"; Browse grid:
// a per-cell id) without forking the field's structure.

import MapleCore
import SwiftUI

struct InlineRenameField: View {
  let asset: AssetRef
  var font: Font = MapleTokens.Typography.filename
  var idPrefix: String = "rename-field"

  @Environment(\.assetRename) private var renameCtx

  /// Draft text for the edit field. Seeded from the full filename on
  /// appear — the field only mounts while `renameCtx.isRenaming(asset)` is
  /// true, so this always runs exactly once per edit session.
  @State private var draft: String = ""
  @FocusState private var fieldFocused: Bool
  /// Non-nil while a submitted filename changes the extension and is
  /// awaiting a second confirm/cancel before it's actually committed.
  @State private var pendingExtensionChange: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      TextField("Filename", text: $draft)
        .textFieldStyle(.plain)
        .font(font)
        .foregroundStyle(MapleTokens.textMain)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(MapleTokens.inputBg, in: RoundedRectangle(cornerRadius: MapleTokens.Radius.xs))
        .overlay(RoundedRectangle(cornerRadius: MapleTokens.Radius.xs).stroke(MapleTokens.borderHi, lineWidth: 1))
        .focused($fieldFocused)
        .onSubmit(submitDraft)
        .onKeyPress(.escape) {
          renameCtx?.cancel()
          return .handled
        }
        .accessibilityIdentifier("\(idPrefix)-field")
        .accessibilityLabel("Filename")
      if let error = renameCtx?.errorText {
        Text(error)
          .font(MapleTokens.Typography.body)
          .foregroundStyle(MapleTokens.errorText)
          .accessibilityIdentifier("\(idPrefix)-error")
      }
      if let pendingExtensionChange {
        extensionWarning(newFilename: pendingExtensionChange)
      }
    }
    .onAppear {
      draft = asset.fullFilename
      // Defer focus by one runloop pass so SwiftUI mounts the field before
      // the focus binding claims it (same trick KeywordChipsRow's add
      // field uses).
      DispatchQueue.main.async { fieldFocused = true }
    }
  }

  private func submitDraft() {
    guard let renameCtx else { return }
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let original = asset.fullFilename
    guard trimmed != original else {
      renameCtx.cancel()
      return
    }
    if AssetRenameFilename.extensionChanged(from: original, to: trimmed) {
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
          .accessibilityIdentifier("\(idPrefix)-extension-cancel")
        Button("Rename Anyway") {
          pendingExtensionChange = nil
          renameCtx?.commit(asset, newFilename)
        }
        .buttonStyle(.plain)
        .foregroundStyle(MapleTokens.primary)
        .accessibilityIdentifier("\(idPrefix)-extension-confirm")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("\(idPrefix)-extension-warning")
  }
}

// MARK: - Previews

#Preview("InlineRenameField") {
  InlineRenameField(asset: .preview(displayName: "IMG_0001.dng"), idPrefix: "preview-filename")
    .padding()
    .background(MapleTokens.bg)
}
