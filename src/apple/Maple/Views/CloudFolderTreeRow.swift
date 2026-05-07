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

  @Binding var selection: LibrarySelection
  /// Per-server cache of FsDirListing keyed by absPath. Lives on the
  /// LibrarySidebar so re-expansion is instant.
  @Binding var listingCache: [String: FsDirListing]
  /// Tracks which abs-paths the user has expanded so the disclosure
  /// state survives sidebar re-renders. Lives on the LibrarySidebar.
  @Binding var expanded: Set<String>

  @State private var isLoading: Bool = false
  @State private var loadFailed: Bool = false

  private var isExpandedBinding: Binding<Bool> {
    Binding(
      get: { expanded.contains(absPath) },
      set: { newValue in
        if newValue { expanded.insert(absPath) }
        else { expanded.remove(absPath) }
      }
    )
  }

  private var isSelected: Bool {
    if case .cloudLibrary(let s, let f) = selection {
      return s == serverURL && f == libraryFolderID && depth == 0
    }
    return false
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
                selection: $selection,
                listingCache: $listingCache,
                expanded: $expanded
              )
            }
          }
        } label: {
          rowLabel
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
      HStack(spacing: 6) {
        Image(systemName: depth == 0 ? "folder.fill" : "folder")
          .foregroundStyle(.secondary)
        Text(displayName)
          .lineLimit(1)
        Spacer()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.leading, CGFloat(depth) * 12)
    .padding(.vertical, 2)
    .background(
      isSelected ? Color.accentColor.opacity(0.18) : .clear,
      in: RoundedRectangle(cornerRadius: 6)
    )
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
}
