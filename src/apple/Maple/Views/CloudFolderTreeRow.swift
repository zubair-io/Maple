// CloudFolderTreeRow.swift
//
// Recursive sidebar row for cloud library / subfolder navigation.
// Mirrors the local FolderTreeRow shape one-for-one — left-side chevron
// Button toggles expansion, separate label Button fires onPickPath,
// MapleTokens.bgActive selection background, identical indent + padding
// tokens — so the sidebar reads as a single tree regardless of whether
// a row is local or cloud.
//
// Each row represents one directory on the server (a registered library
// at depth 0, or a subfolder at depth >= 1). Children are populated by
// calling `onListDir(server, absPath)` on first expand and cached for
// the view's lifetime. Auto-expand walks the chain to `cloudCurrentPath`
// on first appear so the user lands on the row they last selected.

import SwiftUI
import MapleCore

struct CloudFolderTreeRow: View {
  let serverURL: URL
  /// Folder ID of the registered LIBRARY this row sits under. Inherited
  /// down the tree so subfolder rows still know which library row they
  /// belong to (for sidebar selection and breadcrumb).
  let libraryFolderID: String
  /// Server-absolute path of the LIBRARY root (`CloudFolder.path`).
  /// Inherited down the tree unchanged — needed to derive the relative
  /// path `RemoteCatalog.makeDir`/`moveFolder` expect (#2645).
  let libraryRootPath: String
  /// Absolute path on the server. The library root passes the registered
  /// folder's path; subfolder rows pass their own.
  let absPath: String
  let displayName: String
  let depth: Int

  /// Lazy fetch — sidebar wires this to CloudFoldersClient.listDir.
  /// Returns nil on auth/network error so the row falls back to a
  /// "couldn't load" indicator instead of crashing.
  let onListDir: (URL, String) async -> FsDirListing?

  /// User clicked this row — load its contents in the grid.
  let onPickPath: (URL, String, String) -> Void

  /// Absolute path the user is currently browsing in this server's
  /// tree, or nil when no cloud library is selected (or a different
  /// server is selected). Used to auto-expand the ancestor chain on
  /// cold start and to highlight the matching row.
  let cloudCurrentPath: String?

  @Binding var selection: LibrarySelection
  /// Per-server cache of FsDirListing keyed by absPath. Lives on the
  /// LibrarySidebar so re-expansion is instant.
  @Binding var listingCache: [String: FsDirListing]
  /// Tracks which abs-paths the user has expanded so the disclosure
  /// state survives sidebar re-renders. Lives on the LibrarySidebar.
  @Binding var expanded: Set<String>

  /// Source-tree context menu (#2645). Bumped after New Folder / Rename
  /// commits anywhere in this server's tree — re-fetches this row's
  /// listing if expanded.
  var refreshGeneration: Int = 0
  /// (libraryFolderID, libraryRootPath, parentAbsPath, name). `nil`
  /// suppresses the "New Folder" menu item (kept optional so the preview
  /// wrapper doesn't need every call site updated).
  var onCreateFolder: ((String, String, String, String) -> Void)? = nil
  /// (libraryFolderID, libraryRootPath, absPath, newName).
  var onRenameFolder: ((String, String, String, String) -> Void)? = nil
  /// (libraryFolderID, libraryRootPath, absPath) — recursive Move to Trash
  /// via `POST /api/folders/:id/trash-folder` (#2630/#2695, wired #2696).
  /// `nil` suppresses the menu item (kept optional for the preview wrapper).
  var onTrashFolder: ((String, String, String) -> Void)? = nil
  /// "Show Trash…" (#2653) — library root only (depth == 0). `(libraryFolderID, displayName)`.
  var onShowTrash: ((String, String) -> Void)? = nil
  /// Drag-onto-source-tree (#2646). `ids == nil` ⇒ "use current grid
  /// selection" (the "Move/Copy Selected Here" menu path).
  var onDropAssets: (String, String, String, Set<AssetRef.ID>?, Bool) -> Void = { _, _, _, _, _ in }
  /// OS file/folder drop-to-mount (#2649). See `LibrarySidebar.onDropURLs`.
  var onDropURLs: ([URL]) -> Bool = { _ in false }
  /// Gates the "Move/Copy Selected Here" context-menu items.
  var selectedAssetCount: Int = 0

  @State private var isDropTargeted = false
  @State private var isLoading: Bool = false
  @State private var loadFailed: Bool = false
  /// Set on the first appear after we've auto-expanded for the current
  /// `cloudCurrentPath`. Without this, manual collapse → re-render
  /// would trigger unwanted re-expansion.
  @State private var didAutoExpand: Bool = false
  @State private var showNewFolderAlert = false
  @State private var newFolderDraft = ""
  @State private var showRenameAlert = false
  @State private var renameDraft = ""
  @State private var showTrashConfirm = false

  private var isExpanded: Bool { expanded.contains(absPath) }

  /// True when the grid is showing this exact row's path.
  private var isSelected: Bool {
    cloudCurrentPath == absPath
  }

  /// True when this row is an ancestor of the currently-browsed path
  /// (i.e. it should auto-expand to keep the chain visible).
  private var isOnChainToCurrent: Bool {
    guard let current = cloudCurrentPath else { return false }
    if current == absPath { return false }   // self, not ancestor
    return current.hasPrefix(absPath + "/")
  }

  private var dirs: [FsDirEntry] {
    listingCache[absPath]?.dirs ?? []
  }

  private var hasChildren: Bool {
    // We don't know definitively until we fetch — show a chevron
    // optimistically. After the first expand the cache reflects truth
    // and the chevron disappears for empty leaves.
    if let listing = listingCache[absPath] { return !listing.dirs.isEmpty }
    return true
  }

  private var newFolderDraftIsValid: Bool {
    FilenameValidation.isValidFolderName(newFolderDraft.trimmingCharacters(in: .whitespacesAndNewlines))
  }
  private var renameDraftIsValid: Bool {
    FilenameValidation.isValidFolderName(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  private var indent: CGFloat {
    MapleTokens.Spacing.rowHorizontal + CGFloat(depth) * MapleTokens.Spacing.treeIndent
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        // Left-side chevron Button — toggles expansion only. Mirror of
        // the local FolderTreeRow's chevron exactly: same SF symbol,
        // same point size, same rotation, same opacity rule for empty
        // leaves.
        Button(action: {
          withAnimation(.easeInOut(duration: 0.12)) {
            toggleExpanded()
          }
        }) {
          Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(MapleTokens.textMuted)
            .opacity(hasChildren ? 0.6 : 0.15)
            .rotationEffect(.degrees(isExpanded ? 90 : 0))
            .frame(width: 14, height: 14)
        }
        .buttonStyle(.plain)
        .disabled(!hasChildren)

        // Folder icon + label Button — the navigate target. Tinted
        // primary when selected, same as the local tree.
        Button(action: { onPickPath(serverURL, libraryFolderID, absPath) }) {
          HStack(spacing: MapleTokens.Spacing.iconLabelGap) {
            Image(systemName: "folder")
              .font(.system(size: 16))
              .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMuted)
              .frame(width: 22, alignment: .center)
            Text(displayName)
              .font(depth == 0 ? MapleTokens.Typography.rowLabel : MapleTokens.Typography.body)
              .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMain)
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer()
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
      .padding(.leading, indent)
      .padding(.trailing, MapleTokens.Spacing.rowHorizontal)
      .padding(.vertical, MapleTokens.Spacing.rowVertical)
      .background(isDropTargeted ? MapleTokens.primary.opacity(0.15)
                  : (isSelected ? MapleTokens.bgActive : Color.clear))
      // Drag-onto-source-tree (#2646). See `FolderTreeRow`'s identical
      // modifier (`LibrarySidebar.swift`) for the payload/modifier-key
      // contract — this is its Cloud-row twin.
      .dropDestination(for: DraggedAssetPayload.self, action: { payloads, _ in
        guard let payload = payloads.first, !payload.ids.isEmpty else { return false }
        onDropAssets(libraryFolderID, libraryRootPath, absPath, Set(payload.ids), MapleDragModifier.isCopyRequested())
        return true
      }, isTargeted: { targeted in isDropTargeted = targeted })
      // Second, same-view drop target for OS file/folder drops (#2649).
      .urlDropDestination(perform: onDropURLs)
      .contextMenu {
        if selectedAssetCount > 0 {
          Button {
            onDropAssets(libraryFolderID, libraryRootPath, absPath, nil, false)
          } label: {
            Label("Move Selected Here", systemImage: "arrow.right.doc.on.clipboard")
          }
          .accessibilityIdentifier("cloudFolderTree.moveSelectedHere.\(absPath)")
          Button {
            onDropAssets(libraryFolderID, libraryRootPath, absPath, nil, true)
          } label: {
            Label("Copy Selected Here", systemImage: "doc.on.doc")
          }
          .accessibilityIdentifier("cloudFolderTree.copySelectedHere.\(absPath)")
          Divider()
        }
        if onCreateFolder != nil {
          Button {
            newFolderDraft = ""
            showNewFolderAlert = true
          } label: {
            Label("New Folder", systemImage: "folder.badge.plus")
          }
          .accessibilityIdentifier("cloudFolderTree.newFolder.\(absPath)")
        }
        // Rename is offered on a SUBFOLDER row only (depth > 0), never on
        // the library-root row (depth 0, #2645 review): `RemoteCatalog
        // .moveFolder` requires a non-empty relative path, and the root's
        // relative path IS empty by definition — offering Rename there is
        // a guaranteed server 400 ("Empty path" from `validateRelPathHeader`
        // on an empty `X-Maple-Source-Path`). Renaming the library itself
        // is a distinct operation (re-pointing the registered folder), not
        // a subtree move, and isn't in scope here.
        if onRenameFolder != nil, depth > 0 {
          Button {
            renameDraft = displayName
            showRenameAlert = true
          } label: {
            Label("Rename…", systemImage: "pencil")
          }
          .accessibilityIdentifier("cloudFolderTree.rename.\(absPath)")
        }
        // Move to Trash — wired to `POST /api/folders/:id/trash-folder`
        // (#2630/#2695) as of #2696. Subfolder rows only (depth > 0), same
        // reasoning as Rename above: the library root's relative path is
        // empty, and trashing an entire registered library is a distinct
        // "remove this library" operation this menu doesn't own.
        if onTrashFolder != nil, depth > 0 {
          Button(role: .destructive) {
            showTrashConfirm = true
          } label: {
            Label("Move to Trash", systemImage: "trash")
          }
          .accessibilityIdentifier("cloudFolderTree.trash.\(absPath)")
        }
        if depth == 0, let onShowTrash {
          Button {
            onShowTrash(libraryFolderID, displayName)
          } label: {
            Label("Show Trash…", systemImage: "trash.circle")
          }
          .accessibilityIdentifier("cloudFolderTree.showTrash.\(absPath)")
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
          guard FilenameValidation.isValidFolderName(name) else { return }
          onCreateFolder?(libraryFolderID, libraryRootPath, absPath, name)
        }
        .disabled(!newFolderDraftIsValid)
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(newFolderDraftIsValid
          ? "Creates a new folder inside \(displayName)."
          : FilenameValidation.invalidNameMessage)
      }
      .alert("Rename Folder", isPresented: $showRenameAlert) {
        TextField("Name", text: $renameDraft)
        Button("Rename") {
          let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard FilenameValidation.isValidFolderName(name), name != displayName else { return }
          onRenameFolder?(libraryFolderID, libraryRootPath, absPath, name)
        }
        .disabled(!renameDraftIsValid)
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(renameDraftIsValid ? " " : FilenameValidation.invalidNameMessage)
      }
      .confirmationDialog("Move to Trash", isPresented: $showTrashConfirm, titleVisibility: .visible) {
        Button("Move to Trash", role: .destructive) {
          onTrashFolder?(libraryFolderID, libraryRootPath, absPath)
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("\"\(displayName)\" and everything inside it will move to this server's Trash. Recursive — every asset underneath goes too.")
      }
      .onAppear { autoExpandIfOnChain() }
      .onChange(of: cloudCurrentPath) { _, _ in
        // Clear the one-shot flag when the user navigates the grid to
        // a different path so we re-evaluate auto-expand against the
        // new chain on the next render.
        didAutoExpand = false
        autoExpandIfOnChain()
      }
      .onChange(of: refreshGeneration) { _, _ in
        if isExpanded { refresh() }
      }

      // Children — same depth-recursive pattern as the local tree.
      if isExpanded {
        if isLoading {
          HStack {
            ProgressView().controlSize(.small)
            Text("Loading…")
              .font(MapleTokens.Typography.body)
              .foregroundStyle(MapleTokens.textMuted)
          }
          .padding(.leading, indent + MapleTokens.Spacing.treeIndent)
          .padding(.vertical, 4)
        } else if loadFailed {
          Text("Couldn't load")
            .font(MapleTokens.Typography.body)
            .foregroundStyle(.red)
            .padding(.leading, indent + MapleTokens.Spacing.treeIndent)
            .padding(.vertical, 4)
        } else {
          // Reversed to match the grid's first-level folder order (#782).
          ForEach(Array(dirs.reversed()), id: \.path) { dir in
            CloudFolderTreeRow(
              serverURL: serverURL,
              libraryFolderID: libraryFolderID,
              libraryRootPath: libraryRootPath,
              absPath: dir.path,
              displayName: dir.name,
              depth: depth + 1,
              onListDir: onListDir,
              onPickPath: onPickPath,
              cloudCurrentPath: cloudCurrentPath,
              selection: $selection,
              listingCache: $listingCache,
              expanded: $expanded,
              refreshGeneration: refreshGeneration,
              onCreateFolder: onCreateFolder,
              onRenameFolder: onRenameFolder,
              onTrashFolder: onTrashFolder,
              onShowTrash: onShowTrash,
              onDropAssets: onDropAssets,
              onDropURLs: onDropURLs,
              selectedAssetCount: selectedAssetCount
            )
          }
        }
      }
    }
  }

  private func toggleExpanded() {
    if isExpanded {
      expanded.remove(absPath)
    } else {
      expanded.insert(absPath)
      loadIfNeeded()
    }
  }

  private func loadIfNeeded() {
    guard listingCache[absPath] == nil, !isLoading else { return }
    isLoading = true
    loadFailed = false
    // @MainActor on the Task so the post-await writes to @State
    // (`isLoading`, `loadFailed`) and @Binding (`listingCache`) all
    // land on the main actor — SwiftUI views are MainActor-isolated
    // and an unannotated Task ran the continuation off-main, which
    // is a data-race risk under Swift 6 strict concurrency.
    Task { @MainActor in
      let listing = await onListDir(serverURL, absPath)
      isLoading = false
      if let listing {
        listingCache[absPath] = listing
      } else {
        loadFailed = true
      }
    }
  }

  /// If this row is on the chain to `cloudCurrentPath`, expand it
  /// (which triggers `loadIfNeeded` via the existing onChange) so the
  /// recursive descendants can do the same. One-shot via `didAutoExpand`
  /// to prevent fighting the user when they manually collapse a node.
  private func autoExpandIfOnChain() {
    guard !didAutoExpand, isOnChainToCurrent else { return }
    didAutoExpand = true
    if !expanded.contains(absPath) {
      expanded.insert(absPath)
    }
    loadIfNeeded()
  }

  /// Drop the cached listing for this path AND every descendant path
  /// in the same server's cache, then re-expand to refetch. Lets the
  /// user invalidate stale state when files have changed on disk and
  /// the indexer hasn't caught up.
  private func refresh() {
    let prefix = absPath + "/"
    listingCache = listingCache.filter { key, _ in
      key != absPath && !key.hasPrefix(prefix)
    }
    if isExpanded {
      loadIfNeeded()
    }
  }
}

// MARK: - Previews
//
// Issue #139 — sidecar row for cloud folder navigation. Bindings + the
// `onListDir` closure return an always-empty listing so the row stays
// collapsed unless the user expands it. Different depths exercise the
// indent token.

private struct _CloudFolderTreeRowPreviewWrapper: View {
  let depth: Int
  let selected: Bool
  @State private var selection: LibrarySelection = .none
  @State private var cache: [String: FsDirListing] = [:]
  @State private var expanded: Set<String> = []

  var body: some View {
    CloudFolderTreeRow(
      serverURL: URL(string: "https://preview.maple.invalid")!,
      libraryFolderID: "lib-1",
      libraryRootPath: "/photos",
      absPath: "/photos/2024",
      displayName: "2024",
      depth: depth,
      onListDir: { _, _ in nil },
      onPickPath: { _, _, _ in },
      cloudCurrentPath: selected ? "/photos/2024" : "/photos/2023",
      selection: $selection,
      listingCache: $cache,
      expanded: $expanded
    )
    .padding()
    .background(MapleTokens.sidebar)
    .frame(width: 280)
  }
}

#Preview("Default (depth 0)") {
  _CloudFolderTreeRowPreviewWrapper(depth: 0, selected: false)
}

#Preview("Selected (depth 0)") {
  _CloudFolderTreeRowPreviewWrapper(depth: 0, selected: true)
}

#Preview("Nested (depth 2)") {
  _CloudFolderTreeRowPreviewWrapper(depth: 2, selected: false)
}
