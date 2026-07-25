// CloudServerSection.swift
//
// One sidebar section per connected cloud server. Header style mirrors
// the local FOLDERS / PHOTOS LIBRARY / CONNECTIONS sections — uppercased
// section-header type at MapleTokens.textMuted, leading rotating
// chevron, same vertical padding — so the sidebar reads as one
// consistent tree of sections.
//
// The Timeline | Folder view-mode toggle that used to sit at the
// trailing edge of this header moved into the main browse header
// (`AppShellToolbar`) in #782, so the section header is now just the
// chevron + server name.
//
// Each library is rendered as a CloudFolderTreeRow at depth 0; its
// children are populated on first expand via /api/fs/dir.

import SwiftUI
import MapleCore

struct CloudServerSection: View {
  let serverURL: URL
  let folders: [CloudFolder]
  /// Display name to render in the header. Caller passes
  /// `registry.displayName(for: url) ?? url.host ?? url.absoluteString`
  /// so the header always has something readable. Up-cased on render
  /// to match the other section headers.
  let displayName: String
  @Binding var isExpanded: Bool
  @Binding var selection: LibrarySelection
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
  /// The server's auth session. Observed — reading `isSignedIn` here makes the
  /// "Sign in" affordance appear the instant a mid-session 401 de-auths the
  /// server (#1381).
  let session: AuthSession
  /// Present sign-in for this server (prefilled re-auth).
  let onSignIn: () -> Void

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
      // Signed out (token cleared by a failed refresh, or an explicit sign
      // out) — a visible way back in, not just a context-menu item (#1381).
      if !session.isSignedIn {
        Button(action: onSignIn) {
          HStack(spacing: 6) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
            Text("Sign in")
          }
          .font(.callout.weight(.semibold))
          .padding(.horizontal, MapleTokens.Spacing.rowHorizontal)
          .padding(.vertical, 4)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tint)
        .accessibilityIdentifier("cloud.signIn.\(serverURL.host ?? serverURL.absoluteString)")
      }
      if isExpanded {
        // Reversed to match the grid's first-level folder order (#782).
        ForEach(Array(folders.reversed())) { folder in
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
  /// textMuted + the shared `MapleTokens.Spacing.sectionHeaderHeight`
  /// fixed height, #2271). Trailing: compact view-mode toggle.
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
          .font(MapleTokens.Typography.eyebrow)
          .tracking(1.4)
          .foregroundStyle(MapleTokens.textMuted)
          .lineLimit(1)
        Spacer()
      }
      .padding(.horizontal, MapleTokens.Spacing.rowHorizontal)
      .frame(height: MapleTokens.Spacing.sectionHeaderHeight, alignment: .leading)
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
      if session.isSignedIn {
        Button("Sign out", action: onSignOut)
      } else {
        Button("Sign in", action: onSignIn)
      }
      Button("Remove server", role: .destructive, action: onRemoveServer)
    }
  }

}

// MARK: - Previews
//
// Issue #139 — sidebar section for a connected cloud server. The
// folders array drives the inner CloudFolderTreeRow list; the listing
// closure returns nil so children stay collapsed. Coverage: with
// folders (loaded), no folders (empty), collapsed.

private struct _CloudServerSectionPreviewWrapper: View {
  let folders: [CloudFolder]
  @State private var isExpanded: Bool
  @State private var selection: LibrarySelection = .none

  init(folders: [CloudFolder], expanded: Bool = true) {
    self.folders = folders
    self._isExpanded = State(initialValue: expanded)
  }

  var body: some View {
    CloudServerSection(
      serverURL: URL(string: "https://preview.maple.invalid")!,
      folders: folders,
      displayName: "preview.maple",
      isExpanded: $isExpanded,
      selection: $selection,
      onPickPath: { _, _, _ in },
      onListDir: { _, _ in nil },
      cloudCurrentPath: nil,
      onSignOut: {},
      onRemoveServer: {},
      onRename: { _ in },
      session: AuthSession.preview(),
      onSignIn: {}
    )
    .padding()
    .background(MapleTokens.sidebar)
    .frame(width: 320)
  }
}

#Preview("Loaded") {
  _CloudServerSectionPreviewWrapper(
    folders: [
      CloudFolder(id: "1", path: "/photos", label: "Photos"),
      CloudFolder(id: "2", path: "/raws", label: "RAWs"),
    ]
  )
}

#Preview("Empty (no folders)") {
  _CloudServerSectionPreviewWrapper(folders: [])
}

#Preview("Collapsed") {
  _CloudServerSectionPreviewWrapper(folders: [
    CloudFolder(id: "1", path: "/photos", label: "Photos"),
  ], expanded: false)
}
