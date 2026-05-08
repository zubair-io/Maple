// CloudFolderTreeRow.swift
//
// Recursive sidebar row for cloud library / subfolder navigation.
// Mirrors the local FolderTreeRow shape: tap-to-select, expand-to-
// drill-down, lazy children loaded on first expand and cached for the
// view's lifetime.
//
// Each row represents one directory on the server (a registered library
// at depth 0, or a subfolder at depth >= 1). Children are populated by
// calling `onListDir(server, absPath)` — the sidebar provides a closure
// that goes through CloudFoldersClient.listDir.

import SwiftUI
import MapleCore

struct CloudFolderTreeRow: View {
  let serverURL: URL
  /// Folder ID of the registered LIBRARY this row sits under. Inherited
  /// down the tree so subfolder rows still know which library row they
  /// belong to (for sidebar selection and breadcrumb).
  let libraryFolderID: String
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

  @State private var isLoading: Bool = false
  @State private var loadFailed: Bool = false
  /// Set on the first appear after we've auto-expanded for the current
  /// `cloudCurrentPath`. Without this, manual collapse → re-render
  /// would trigger unwanted re-expansion.
  @State private var didAutoExpand: Bool = false

  private var isExpandedBinding: Binding<Bool> {
    Binding(
      get: { expanded.contains(absPath) },
      set: { newValue in
        if newValue { expanded.insert(absPath) }
        else { expanded.remove(absPath) }
      }
    )
  }

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

  var body: some View {
    Group {
      if hasChildren {
        DisclosureGroup(isExpanded: isExpandedBinding) {
          if isLoading {
            HStack {
              ProgressView().scaleEffect(0.6)
              Text("Loading…").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.leading, CGFloat(depth + 1) * 14)
            .padding(.vertical, 2)
          } else if loadFailed {
            Text("Couldn't load")
              .font(.caption)
              .foregroundStyle(.red)
              .padding(.leading, CGFloat(depth + 1) * 14)
              .padding(.vertical, 2)
          } else {
            ForEach(dirs, id: \.path) { dir in
              CloudFolderTreeRow(
                serverURL: serverURL,
                libraryFolderID: libraryFolderID,
                absPath: dir.path,
                displayName: dir.name,
                depth: depth + 1,
                onListDir: onListDir,
                onPickPath: onPickPath,
                cloudCurrentPath: cloudCurrentPath,
                selection: $selection,
                listingCache: $listingCache,
                expanded: $expanded
              )
            }
          }
        } label: {
          rowLabel
        }
        .onAppear { autoExpandIfOnChain() }
        .onChange(of: cloudCurrentPath) { _, _ in
          // Clear the one-shot flag when the user navigates the grid
          // to a different path so we re-evaluate auto-expand against
          // the new chain on the next render.
          didAutoExpand = false
          autoExpandIfOnChain()
        }
        .onChange(of: isExpandedBinding.wrappedValue) { _, expanded in
          if expanded { loadIfNeeded() }
        }
      } else {
        rowLabel
      }
    }
  }

  private var rowLabel: some View {
    Button {
      onPickPath(serverURL, libraryFolderID, absPath)
    } label: {
      HStack(spacing: MapleTokens.Spacing.iconLabelGap) {
        Image(systemName: depth == 0 ? "folder.fill" : "folder")
          .font(.system(size: 16))
          .foregroundStyle(MapleTokens.textMuted)
          .frame(width: 22, alignment: .center)
        Text(displayName)
          .font(depth == 0 ? MapleTokens.Typography.row : MapleTokens.Typography.rowDense)
          .foregroundStyle(MapleTokens.textMain)
          .lineLimit(1)
        Spacer()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.leading, CGFloat(depth) * MapleTokens.Spacing.treeIndent)
    .padding(.vertical, MapleTokens.Spacing.rowVertical)
    .padding(.horizontal, MapleTokens.Spacing.rowHorizontal)
    .background(
      isSelected ? Color.accentColor.opacity(0.18) : .clear,
      in: RoundedRectangle(cornerRadius: 6)
    )
    .contextMenu {
      Button {
        refresh()
      } label: {
        Label("Refresh", systemImage: "arrow.clockwise")
      }
    }
  }

  private func loadIfNeeded() {
    guard listingCache[absPath] == nil, !isLoading else { return }
    isLoading = true
    loadFailed = false
    Task {
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
    // Force a re-fetch on the next render. If currently expanded the
    // body's onChange will fire loadIfNeeded; if collapsed, the next
    // user expand triggers it.
    if expanded.contains(absPath) {
      loadIfNeeded()
    }
  }
}
