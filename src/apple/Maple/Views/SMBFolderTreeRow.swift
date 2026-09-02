// SMBFolderTreeRow.swift — #2697.
//
// Recursive sidebar row for SMB per-directory browsing. Mirrors
// `CloudFolderTreeRow`'s shape (left-side chevron toggles expansion, a
// separate label press picks the row, `MuiTreeRow` chrome, lazy per-path
// listing cache) so the sidebar's SMB section reads as the same kind of
// tree as the local Filesystem and Cloud sections, rather than the flat
// single leaf it was before.
//
// Two things are deliberately simpler than `CloudFolderTreeRow`, because
// SMB itself is simpler:
//   - `SMBSource.connect(credentials:remotePath:)` always walks the WHOLE
//     share recursively (`recursive: true`) into one flat asset list —
//     there is no per-subfolder "browse just this" scope on the SMB source
//     today, unlike local/Cloud. So every row's press (root or subfolder)
//     opens the SAME share the root row already did; the tree exists to
//     give Rename/Move to Trash a subfolder row to act on (the ticket's
//     whole point), not to add SMB grid-scoping, which is a bigger,
//     separate feature nobody's asked for yet.
//   - No `cloudCurrentPath`-style auto-expand-to-selection chain: since
//     every row opens the same share, there's no "the grid is showing
//     THIS exact subfolder" state to chase.
//
// Depth 0 renders the share itself (folding what used to be the standalone
// `SMBShareRow`); depth > 0 renders a subfolder discovered by
// `SMBFileOperations.listSubdirectories`.

import SwiftUI
import MapleCore
import MapleUI

struct SMBFolderTreeRow: View {
  let share: SMBCredentialStore.SavedShare
  /// Share-relative path — `"/"` for the share root (depth 0), else e.g.
  /// `/Photos/2024`.
  let path: String
  let displayName: String
  let depth: Int

  /// Lazy fetch — the sidebar wires this to
  /// `AppShell.listSMBSubdirectories(share:path:)`. Returns `nil` on
  /// auth/network error so the row falls back to a "couldn't load"
  /// indicator instead of crashing.
  let onListDir: (SMBCredentialStore.SavedShare, String) async -> [SMBFileOperations.DirEntry]?

  /// User pressed this row (root or subfolder) — opens the connected
  /// share, same as pressing the old flat `SMBShareRow` always did (see
  /// the file header for why every row shares one target).
  let onPick: (SMBCredentialStore.SavedShare) -> Void
  let isSelected: Bool

  /// Per-share cache of child listings keyed by share-relative path. Lives
  /// on `LibrarySidebar` so re-expansion is instant.
  @Binding var listingCache: [String: [SMBFileOperations.DirEntry]]
  /// Tracks which paths the user has expanded so disclosure state survives
  /// sidebar re-renders. Lives on `LibrarySidebar`.
  @Binding var expanded: Set<String>

  /// Bumped after New Folder / Rename / Trash commits anywhere in this
  /// share's tree — re-fetches this row's listing if expanded.
  var refreshGeneration: Int = 0
  /// `nil` suppresses the "New Folder" menu item.
  var onCreateFolder: ((SMBCredentialStore.SavedShare, String, String) -> Void)? = nil
  /// (share, path, newName). Subfolder rows only (depth > 0) — renaming
  /// the share connection itself isn't a folder rename.
  var onRenameFolder: ((SMBCredentialStore.SavedShare, String, String) -> Void)? = nil
  /// (share, path). Subfolder rows only (depth > 0), same reasoning.
  var onTrashFolder: ((SMBCredentialStore.SavedShare, String) -> Void)? = nil
  /// "Show Trash…" — share root only (depth == 0), matching the old
  /// `SMBShareRow`'s placement (SMB always uses one `.maple/trash` per
  /// share, not a per-folder trash).
  var onShowTrash: ((SMBCredentialStore.SavedShare) -> Void)? = nil
  /// Drag-onto-source-tree, share ROOT only (depth == 0) — SMB has no
  /// per-subfolder drop target yet (`AssetDropDestination.smb` carries only
  /// a `SavedShare`, no path); see `AssetDropTypes.swift`.
  var onDropAssets: (SMBCredentialStore.SavedShare, Set<AssetRef.ID>?, Bool) -> Void = { _, _, _ in }
  var onDropURLs: ([URL]) -> Bool = { _ in false }
  var selectedAssetCount: Int = 0

  @State private var isDropTargeted = false
  @State private var isLoading = false
  @State private var loadFailed = false
  @State private var showNewFolderAlert = false
  @State private var newFolderDraft = ""
  @State private var showRenameAlert = false
  @State private var renameDraft = ""
  @State private var showTrashConfirm = false

  private var isExpanded: Bool { expanded.contains(path) }

  private var children: [SMBFileOperations.DirEntry] {
    listingCache[path] ?? []
  }

  private var hasChildren: Bool {
    // Unknown until the first fetch — show a chevron optimistically, same
    // as `CloudFolderTreeRow`. After the first expand the cache reflects
    // truth and the chevron disappears for empty leaves.
    if let cached = listingCache[path] { return !cached.isEmpty }
    return true
  }

  private var newFolderDraftIsValid: Bool {
    FilenameValidation.isValidPathComponent(newFolderDraft.trimmingCharacters(in: .whitespacesAndNewlines))
  }
  private var renameDraftIsValid: Bool {
    FilenameValidation.isValidPathComponent(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      // Row shell — `MuiTreeRow`, the same primitive `CloudFolderTreeRow`
      // and `FolderTreeRow` use, so the sidebar reads as one tree
      // regardless of source kind.
      MuiTreeRow(
        label: depth == 0 ? "\(share.host) / \(share.share)" : displayName,
        icon: depth == 0 ? "externaldrive.connected.to.line.below" : "folder",
        expandable: hasChildren,
        expanded: Binding(
          get: { isExpanded },
          set: { newValue in
            withAnimation(.easeInOut(duration: 0.12)) {
              setExpanded(newValue)
            }
          }
        ),
        depth: depth,
        loading: isLoading,
        active: isSelected,
        pressed: { onPick(share) }
      )
      .overlay(
        RoundedRectangle(cornerRadius: 6)
          .fill(isDropTargeted ? MapleTokens.primary.opacity(0.15) : Color.clear)
          .allowsHitTesting(false)
      )
      .applyingIf(depth == 0) { view in
        view.dropDestination(for: DraggedAssetPayload.self, action: { payloads, _ in
          guard let payload = payloads.first, !payload.ids.isEmpty else { return false }
          onDropAssets(share, Set(payload.ids), MapleDragModifier.isCopyRequested())
          return true
        }, isTargeted: { targeted in isDropTargeted = targeted })
        .urlDropDestination(perform: onDropURLs)
      }
      .contextMenu {
        if depth == 0, selectedAssetCount > 0 {
          Button {
            onDropAssets(share, nil, false)
          } label: {
            Label("Move Selected Here", systemImage: "arrow.right.doc.on.clipboard")
          }
          .accessibilityIdentifier("smbFolderTree.moveSelectedHere.\(path)")
          Button {
            onDropAssets(share, nil, true)
          } label: {
            Label("Copy Selected Here", systemImage: "doc.on.doc")
          }
          .accessibilityIdentifier("smbFolderTree.copySelectedHere.\(path)")
          Divider()
        }
        if onCreateFolder != nil {
          Button {
            newFolderDraft = ""
            showNewFolderAlert = true
          } label: {
            Label("New Folder", systemImage: "folder.badge.plus")
          }
          .accessibilityIdentifier("smbFolderTree.newFolder.\(path)")
        }
        if onRenameFolder != nil, depth > 0 {
          Button {
            renameDraft = displayName
            showRenameAlert = true
          } label: {
            Label("Rename…", systemImage: "pencil")
          }
          .accessibilityIdentifier("smbFolderTree.rename.\(path)")
        }
        if onTrashFolder != nil, depth > 0 {
          Button(role: .destructive) {
            showTrashConfirm = true
          } label: {
            Label("Move to Trash", systemImage: "trash")
          }
          .accessibilityIdentifier("smbFolderTree.trash.\(path)")
        }
        if depth == 0, let onShowTrash {
          Button {
            onShowTrash(share)
          } label: {
            Label("Show Trash…", systemImage: "trash.circle")
          }
          .accessibilityIdentifier("smbFolderTree.showTrash.\(path)")
        }
        Divider()
        Button {
          refresh()
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
      }
      .alert("New Folder", isPresented: $showNewFolderAlert) {
        TextField("Name", text: $newFolderDraft)
        Button("Create") {
          let name = newFolderDraft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard FilenameValidation.isValidPathComponent(name) else { return }
          onCreateFolder?(share, path, name)
        }
        .disabled(!newFolderDraftIsValid)
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(newFolderDraftIsValid
          ? "Creates a new folder inside \(depth == 0 ? "\(share.host) / \(share.share)" : displayName)."
          : FilenameValidation.invalidNameMessage)
      }
      .alert("Rename Folder", isPresented: $showRenameAlert) {
        TextField("Name", text: $renameDraft)
        Button("Rename") {
          let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard FilenameValidation.isValidPathComponent(name), name != displayName else { return }
          onRenameFolder?(share, path, name)
        }
        .disabled(!renameDraftIsValid)
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(renameDraftIsValid ? " " : FilenameValidation.invalidNameMessage)
      }
      .confirmationDialog("Move to Trash", isPresented: $showTrashConfirm, titleVisibility: .visible) {
        Button("Move to Trash", role: .destructive) {
          onTrashFolder?(share, path)
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("\"\(displayName)\" and everything inside it will move to this share's Trash. Recursive — every asset underneath goes too.")
      }
      .onChange(of: refreshGeneration) { _, _ in
        if isExpanded { refresh() }
      }

      if isExpanded {
        if isLoading {
          EmptyView()
        } else if loadFailed {
          Text("Couldn't load")
            .font(MapleTokens.Typography.body)
            .foregroundStyle(.red)
            .padding(.leading, MapleTokens.Spacing.rowHorizontal
              + CGFloat(depth + 1) * MapleTokens.Spacing.treeIndent)
            .padding(.vertical, 4)
        } else {
          ForEach(children, id: \.path) { child in
            SMBFolderTreeRow(
              share: share,
              path: child.path,
              displayName: child.name,
              depth: depth + 1,
              onListDir: onListDir,
              onPick: onPick,
              isSelected: false,
              listingCache: $listingCache,
              expanded: $expanded,
              refreshGeneration: refreshGeneration,
              onCreateFolder: onCreateFolder,
              onRenameFolder: onRenameFolder,
              onTrashFolder: onTrashFolder,
              selectedAssetCount: selectedAssetCount
            )
          }
        }
      }
    }
  }

  private func setExpanded(_ value: Bool) {
    if value {
      expanded.insert(path)
      loadIfNeeded()
    } else {
      expanded.remove(path)
    }
  }

  private func loadIfNeeded() {
    guard listingCache[path] == nil, !isLoading else { return }
    isLoading = true
    loadFailed = false
    // @MainActor: SwiftUI views are MainActor-isolated, and the post-await
    // writes below touch @State/@Binding — same reasoning as
    // `CloudFolderTreeRow.loadIfNeeded`.
    Task { @MainActor in
      let listing = await onListDir(share, path)
      isLoading = false
      if let listing {
        listingCache[path] = listing
      } else {
        loadFailed = true
      }
    }
  }

  /// Drop the cached listing for this path AND every descendant path, then
  /// re-expand to refetch.
  private func refresh() {
    let prefix = path.hasSuffix("/") ? path : path + "/"
    listingCache = listingCache.filter { key, _ in
      key != path && !key.hasPrefix(prefix)
    }
    if isExpanded {
      loadIfNeeded()
    }
  }
}

// MARK: - Conditional modifier helper

private extension View {
  /// Applies `transform` only when `condition` is true — used above to
  /// attach the drop-destination modifiers to the share-root row only
  /// without duplicating the whole `contextMenu`/`alert` chain in two
  /// separate `if` branches.
  @ViewBuilder
  func applyingIf<Transformed: View>(_ condition: Bool, _ transform: (Self) -> Transformed) -> some View {
    if condition {
      transform(self)
    } else {
      self
    }
  }
}

// MARK: - Previews

private struct _SMBFolderTreeRowPreviewWrapper: View {
  let depth: Int
  let selected: Bool
  @State private var cache: [String: [SMBFileOperations.DirEntry]] = [:]
  @State private var expanded: Set<String> = []

  var body: some View {
    SMBFolderTreeRow(
      share: SMBCredentialStore.SavedShare(host: "nas.local", share: "Photos", username: "user"),
      path: depth == 0 ? "/" : "/2024",
      displayName: "2024",
      depth: depth,
      onListDir: { _, _ in [] },
      onPick: { _ in },
      isSelected: selected,
      listingCache: $cache,
      expanded: $expanded
    )
    .padding()
    .background(MapleTokens.sidebar)
    .frame(width: 280)
  }
}

#Preview("Share root (depth 0)") {
  _SMBFolderTreeRowPreviewWrapper(depth: 0, selected: false)
}

#Preview("Selected root") {
  _SMBFolderTreeRowPreviewWrapper(depth: 0, selected: true)
}

#Preview("Subfolder (depth 1)") {
  _SMBFolderTreeRowPreviewWrapper(depth: 1, selected: false)
}
