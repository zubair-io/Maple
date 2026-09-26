#if os(iOS)
  import Foundation
  import MapleCore
  import SwiftUI

  /// The active Browse source, not a global list of unrelated destinations.
  /// The existing asset-drop handler remains the sole owner of file writes,
  /// collision decisions, and partial-failure reporting.
  enum PhoneAssetMoveSource {
    case local(rootURL: URL, rootBookmark: Data)
    case cloud(server: URL, libraryFolderID: String, libraryRootPath: String)

    var rootPath: String {
      switch self {
      case .local(let rootURL, _): rootURL.standardizedFileURL.path
      case .cloud(_, _, let libraryRootPath): libraryRootPath
      }
    }

    func destination(at path: String) -> AssetDropDestination? {
      switch self {
      case .local(let rootURL, let bookmark):
        guard PhoneAssetMoveEligibility.isWithin(path, root: rootURL.standardizedFileURL.path)
        else { return nil }
        return .local(folderURL: URL(fileURLWithPath: path), rootBookmark: bookmark)
      case .cloud(let server, let folderID, let root):
        guard PhoneAssetMoveEligibility.isWithin(path, root: root) else { return nil }
        return .cloud(
          server: server, libraryFolderID: folderID, libraryRootPath: root, absPath: path)
      }
    }
  }

  /// Pure capability and path checks; AppShell repeats the authoritative
  /// guards immediately before each relocation because state can change
  /// while the sheet is open.
  enum PhoneAssetMoveEligibility {
    static func canMove(_ assets: [AssetRef], from source: PhoneAssetMoveSource) -> Bool {
      guard !assets.isEmpty else { return false }
      return assets.allSatisfy { asset in
        guard asset.thumbnailProvenance != .photoKit else { return false }
        switch source {
        case .local(let rootURL, let bookmark):
          guard !bookmark.isEmpty, asset.catalog == nil, let url = asset.primaryURL else {
            return false
          }
          return isWithin(url.standardizedFileURL.path, root: rootURL.standardizedFileURL.path)
        case .cloud(let server, let folderID, let root):
          guard let catalog = asset.catalog, asset.stableID != nil else { return false }
          return catalog.serverID == server && catalog.folderID == folderID
            && isWithin(catalog.absPath, root: root)
        }
      }
    }

    static func isWithin(_ path: String, root: String) -> Bool {
      let normalizedRoot = (root as NSString).standardizingPath
      let normalizedPath = (path as NSString).standardizingPath
      guard normalizedRoot.hasPrefix("/"), normalizedPath.hasPrefix("/") else { return false }
      return normalizedPath == normalizedRoot
        || normalizedPath.hasPrefix(normalizedRoot == "/" ? "/" : normalizedRoot + "/")
    }

    static func isDirectChild(_ path: String, of parent: String) -> Bool {
      (path as NSString).deletingLastPathComponent == (parent as NSString).standardizingPath
        && !((path as NSString).lastPathComponent).hasPrefix(".")
    }
  }

  /// A drill-down picker for the current local folder or Cloud library.
  /// SMB is deliberately unavailable: its relocation contract accepts only
  /// the share root, which cannot offer a useful destination picker (#2697).
  /// `onConfirm` must call
  /// `handleAssetDrop(ids: Set(ids), destination: destination, copy: false)`.
  /// The picker never invokes a relocate primitive itself.
  struct PhoneAssetMovePicker: View {
    let assets: [AssetRef]
    let source: PhoneAssetMoveSource
    /// Pass `listCloudDirFor(server:absPath:)` for Cloud; nil elsewhere.
    var listCloudDirectory: ((URL, String) async -> FsDirListing?)? = nil
    let onConfirm: ([AssetRef.ID], AssetDropDestination) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var pathStack: [String] = []
    @State private var children: [Folder] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var didLoad = false
    @State private var reloadID = UUID()
    @State private var activeLoadID = UUID()

    private struct Folder: Identifiable, Sendable {
      let path: String
      let name: String
      var id: String { path }
    }

    private var currentPath: String { pathStack.last ?? source.rootPath }
    private var title: String {
      return URL(fileURLWithPath: currentPath).lastPathComponent
    }

    var body: some View {
      NavigationStack {
        List {
          Section {
            if isLoading {
              ProgressView("Finding folders…")
            } else if let errorMessage {
              ContentUnavailableView {
                Label("Couldn't load folders", systemImage: "exclamationmark.triangle")
              } description: {
                Text(errorMessage)
              } actions: {
                Button("Try Again") { reloadID = UUID() }
              }
            } else if children.isEmpty {
              Text("No subfolders")
                .foregroundStyle(.secondary)
            } else {
              ForEach(children) { folder in
                Button {
                  pathStack.append(folder.path)
                } label: {
                  Label(folder.name, systemImage: "folder")
                }
                .accessibilityIdentifier("phone-move-folder-\(folder.name)")
              }
            }
          } header: {
            Text(title)
          }
        }
        .navigationTitle("Move \(assets.count) Photos")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            if !pathStack.isEmpty {
              Button("Back", systemImage: "chevron.left") { pathStack.removeLast() }
                .accessibilityIdentifier("phone-move-back")
            } else {
              Button("Cancel") { dismiss() }
            }
          }
          ToolbarItem(placement: .topBarTrailing) {
            Button("Move Here") { confirm() }
              .disabled(!didLoad || isLoading || errorMessage != nil || !isEligible)
              .accessibilityIdentifier("phone-move-confirm")
          }
        }
        .task(id: "\(currentPath)|\(reloadID)") { await loadChildren() }
      }
    }

    private var isEligible: Bool {
      PhoneAssetMoveEligibility.canMove(assets, from: source)
        && source.destination(at: currentPath) != nil
    }

    private func confirm() {
      guard isEligible, didLoad, !isLoading, errorMessage == nil,
        let destination = source.destination(at: currentPath)
      else { return }
      onConfirm(assets.map(\.id), destination)
      dismiss()
    }

    private func loadChildren() async {
      let requestID = UUID()
      activeLoadID = requestID
      children = []
      didLoad = false
      errorMessage = nil
      isLoading = true
      defer { if activeLoadID == requestID { isLoading = false } }
      guard isEligible else {
        errorMessage = "These photos can't be moved from this source."
        return
      }
      do {
        let loaded: [Folder]
        switch source {
        case .local(let rootURL, let bookmark):
          let path = currentPath
          loaded = try await Task.detached(priority: .userInitiated) {
            try Self.localChildren(at: path, rootURL: rootURL, bookmark: bookmark)
          }.value
        case .cloud(let server, _, _):
          guard let listCloudDirectory,
            let listing = await listCloudDirectory(server, currentPath)
          else { throw PickerError.listingUnavailable }
          guard listing.path == currentPath else { throw PickerError.invalidListing }
          loaded = listing.dirs
            .filter {
              PhoneAssetMoveEligibility.isDirectChild($0.path, of: currentPath)
                && source.destination(at: $0.path) != nil
            }
            .map { Folder(path: $0.path, name: $0.name) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        }
        try Task.checkCancellation()
        guard activeLoadID == requestID else { return }
        children = loaded
        didLoad = true
      } catch is CancellationError {
        return
      } catch {
        if activeLoadID == requestID { errorMessage = error.localizedDescription }
      }
    }

    nonisolated private static func localChildren(
      at path: String, rootURL: URL, bookmark: Data
    ) throws
      -> [Folder]
    {
      var isStale = false
      let resolvedRoot = try URL(
        resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &isStale
      )
      guard !isStale,
        resolvedRoot.standardizedFileURL.path == rootURL.standardizedFileURL.path,
        PhoneAssetMoveEligibility.isWithin(path, root: resolvedRoot.standardizedFileURL.path)
      else { throw PickerError.invalidBookmark }
      let accessing = resolvedRoot.startAccessingSecurityScopedResource()
      defer { if accessing { resolvedRoot.stopAccessingSecurityScopedResource() } }
      let entries = try FileManager.default.contentsOfDirectory(
        at: URL(fileURLWithPath: path),
        includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
        options: [.skipsHiddenFiles])
      return try entries.compactMap { url -> Folder? in
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true,
          !url.lastPathComponent.hasPrefix("."),
          PhoneAssetMoveEligibility.isDirectChild(url.path, of: path),
          PhoneAssetMoveEligibility.isWithin(url.standardizedFileURL.path, root: resolvedRoot.path)
        else { return nil }
        return Folder(path: url.standardizedFileURL.path, name: url.lastPathComponent)
      }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private enum PickerError: LocalizedError {
      case listingUnavailable
      case invalidListing
      case invalidBookmark

      var errorDescription: String? {
        switch self {
        case .listingUnavailable:
          "The folder list is unavailable. Check the connection and try again."
        case .invalidListing: "The server returned folders for a different location."
        case .invalidBookmark: "The folder's saved access expired. Open it again from Sources."
        }
      }
    }
  }
#endif
