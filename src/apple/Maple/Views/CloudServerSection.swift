// CloudServerSection.swift
//
// One sidebar section per connected cloud server: collapsible header with
// a Timeline | Folder segmented control on the right, and a tree of
// libraries (registered folders) with lazy subfolder drill-down beneath.
//
// Each library is rendered as a CloudFolderTreeRow at depth 0; its
// children are populated on first expand via /api/fs/dir.

import SwiftUI
import MapleCore

struct CloudServerSection: View {
  let serverURL: URL
  let folders: [CloudFolder]
  let viewMode: CloudViewMode
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

  /// Per-server tree state — kept here (not on individual rows) so the
  /// disclosure state and fetched listings survive sibling re-renders.
  @State private var listingCache: [String: FsDirListing] = [:]
  @State private var expanded: Set<String> = []

  var body: some View {
    DisclosureGroup(isExpanded: $isExpanded) {
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
    } label: {
      HStack {
        Text(serverURL.host ?? serverURL.absoluteString)
          .font(MapleTokens.Typography.groupHeader)
          .foregroundStyle(MapleTokens.textMain)
          .lineLimit(1)
        Spacer()
        Picker("", selection: Binding(
          get: { viewMode },
          set: onSetViewMode
        )) {
          Image(systemName: "calendar").tag(CloudViewMode.timeline)
          Image(systemName: "folder").tag(CloudViewMode.folder)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 88)
      }
      .padding(.vertical, 4)
      .contextMenu {
        Button("Sign out", action: onSignOut)
        Button("Remove server", role: .destructive, action: onRemoveServer)
      }
    }
  }
}
