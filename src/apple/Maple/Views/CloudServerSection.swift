// CloudServerSection.swift
//
// One sidebar section per connected cloud server. Header style mirrors
// the local FOLDERS / PHOTOS LIBRARY / CONNECTIONS sections — uppercased
// section-header type at MapleTokens.textMuted, leading rotating
// chevron, same vertical padding — so the sidebar reads as one
// consistent tree of sections.
//
// Trailing element: a compact 2-icon Timeline | Folder toggle. The
// previous segmented picker forced the cloud header to be ~32pt tall;
// the icons fit the section-header line height (~20pt).
//
// Each library is rendered as a CloudFolderTreeRow at depth 0; its
// children are populated on first expand via /api/fs/dir.

import SwiftUI
import MapleCore

struct CloudServerSection: View {
  let serverURL: URL
  let folders: [CloudFolder]
  let viewMode: CloudViewMode
  /// Display name to render in the header. Caller passes
  /// `registry.displayName(for: url) ?? url.host ?? url.absoluteString`
  /// so the header always has something readable. Up-cased on render
  /// to match the other section headers.
  let displayName: String
  @Binding var isExpanded: Bool
  @Binding var selection: LibrarySelection
  let onSetViewMode: (CloudViewMode) -> Void
  /// (server, folderID, absPath) — invoked when the user taps a library
  /// row OR a subfolder row. absPath is what the grid should browse.
  let onPickPath: (URL, String, String) -> Void
  /// Lazy-fetch a directory listing on the server. Returns nil on
  /// auth/network failure; the row falls back to a "couldn't load" hint.
  let onListDir: (URL, String) async -> FsDirListing?
  /// Absolute path the user is currently browsing on this server, or
  /// nil if a different server (or no cloud library) is selected.
  /// Drives auto-expand-on-cold-start and tree-row highlighting.
  let cloudCurrentPath: String?
  let onSignOut: () -> Void
  let onRemoveServer: () -> Void
  /// Persist a new display name (nil clears the override). Wired to a
  /// "Rename…" context menu action that prompts for a string.
  let onRename: (String?) -> Void

  /// Per-server tree state — kept here (not on individual rows) so the
  /// disclosure state and fetched listings survive sibling re-renders.
  @State private var listingCache: [String: FsDirListing] = [:]
  @State private var expanded: Set<String> = []

  /// Rename-prompt state. Toggling `showRenameAlert` true brings up the
  /// SwiftUI alert; submitting commits via `onRename`.
  @State private var showRenameAlert: Bool = false
  @State private var renameDraft: String = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if isExpanded {
        ForEach(folders) { folder in
          CloudFolderTreeRow(
            serverURL: serverURL,
            libraryFolderID: folder.id,
            absPath: folder.path,
            displayName: folder.displayName,
            depth: 0,
            onListDir: onListDir,
            onPickPath: onPickPath,
            cloudCurrentPath: cloudCurrentPath,
            selection: $selection,
            listingCache: $listingCache,
            expanded: $expanded
          )
        }
      }
    }
    .alert("Rename server", isPresented: $showRenameAlert) {
      TextField("Display name", text: $renameDraft)
      Button("Save") { onRename(renameDraft) }
      Button("Reset to URL", role: .destructive) { onRename(nil) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Replaces \(serverURL.host ?? serverURL.absoluteString) in the sidebar header.")
    }
  }

  /// Section header — same visual recipe as LibrarySidebar's
  /// SectionHeaderRow (chevron + uppercased sectionHeader font +
  /// textMuted + 6pt vertical padding). Trailing: compact view-mode
  /// toggle.
  @ViewBuilder
  private var header: some View {
    Button(action: {
      withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
    }) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.down")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(MapleTokens.textMuted)
          .rotationEffect(.degrees(isExpanded ? 0 : -90))
        Text(displayName.uppercased())
          .font(MapleTokens.Typography.sectionHeader)
          .tracking(1.4)
          .foregroundStyle(MapleTokens.textMuted)
          .lineLimit(1)
        Spacer()
        viewModeToggle
      }
      .padding(.horizontal, MapleTokens.Spacing.rowHorizontal)
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button {
        renameDraft = displayName
        showRenameAlert = true
      } label: {
        Label("Rename…", systemImage: "pencil")
      }
      Divider()
      Button("Sign out", action: onSignOut)
      Button("Remove server", role: .destructive, action: onRemoveServer)
    }
  }

  /// Compact 2-icon view-mode toggle — replaces the previous
  /// `.segmented` Picker which forced the cloud header to be roughly
  /// 32pt tall. Two SF Symbol buttons (calendar = Timeline,
  /// folder = Folder); the active one is tinted primary.
  @ViewBuilder
  private var viewModeToggle: some View {
    HStack(spacing: 4) {
      Button(action: { onSetViewMode(.timeline) }) {
        Image(systemName: "calendar")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(viewMode == .timeline
                           ? MapleTokens.primary
                           : MapleTokens.textMuted)
          .frame(width: 22, height: 22)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Timeline view")

      Button(action: { onSetViewMode(.folder) }) {
        Image(systemName: "folder")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(viewMode == .folder
                           ? MapleTokens.primary
                           : MapleTokens.textMuted)
          .frame(width: 22, height: 22)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Folder view")
    }
  }
}

// MARK: - Previews
//
// Issue #139 — sidebar section for a connected cloud server. The
// folders array drives the inner CloudFolderTreeRow list; the listing
// closure returns nil so children stay collapsed. Coverage: with
// folders (loaded), no folders (empty), folder vs timeline modes.

private struct _CloudServerSectionPreviewWrapper: View {
  let folders: [CloudFolder]
  let viewMode: CloudViewMode
  @State private var isExpanded: Bool
  @State private var selection: LibrarySelection = .none

  init(folders: [CloudFolder], viewMode: CloudViewMode, expanded: Bool = true) {
    self.folders = folders
    self.viewMode = viewMode
    self._isExpanded = State(initialValue: expanded)
  }

  var body: some View {
    CloudServerSection(
      serverURL: URL(string: "https://preview.maple.invalid")!,
      folders: folders,
      viewMode: viewMode,
      displayName: "preview.maple",
      isExpanded: $isExpanded,
      selection: $selection,
      onSetViewMode: { _ in },
      onPickPath: { _, _, _ in },
      onListDir: { _, _ in nil },
      cloudCurrentPath: nil,
      onSignOut: {},
      onRemoveServer: {},
      onRename: { _ in }
    )
    .padding()
    .background(MapleTokens.sidebar)
    .frame(width: 320)
  }
}

#Preview("Loaded — folder mode") {
  _CloudServerSectionPreviewWrapper(
    folders: [
      CloudFolder(id: "1", path: "/photos", label: "Photos"),
      CloudFolder(id: "2", path: "/raws", label: "RAWs"),
    ],
    viewMode: .folder
  )
}

#Preview("Loaded — timeline mode") {
  _CloudServerSectionPreviewWrapper(
    folders: [
      CloudFolder(id: "1", path: "/photos", label: "Photos"),
    ],
    viewMode: .timeline
  )
}

#Preview("Empty (no folders)") {
  _CloudServerSectionPreviewWrapper(folders: [], viewMode: .folder)
}

#Preview("Collapsed") {
  _CloudServerSectionPreviewWrapper(folders: [
    CloudFolder(id: "1", path: "/photos", label: "Photos"),
  ], viewMode: .folder, expanded: false)
}
