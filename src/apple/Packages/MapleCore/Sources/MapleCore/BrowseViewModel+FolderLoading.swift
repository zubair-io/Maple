import Foundation

public struct BrowseFolderUnavailableError: LocalizedError {
  public var errorDescription: String? {
    "This folder is temporarily unavailable. Reconnect its storage, then Retry."
  }
}

extension BrowseViewModel {
  /// Clear the previous source before folder setup suspends for cache or
  /// bookmark work. A PhotoKit filter must never page into the new folder.
  public func beginLoadingFilesystemFolder() {
    loadGeneration &+= 1
    invalidateGridFilterForAssetIdentityChange()
    assets = []
    subfolders = []
    selectedID = nil
    selectedIDs = []
    currentSource = nil
    pagedPhotoKitSource = nil
    photoKitNextOffset = 0
    photoKitTotalCount = 0
    finishPhotoKitPageLoad()
    loadError = nil
    photosAuthNeeded = false
    isLoading = true
  }

  /// Enumerate and construct refs off MainActor, including NAS metadata reads.
  /// Publish only if this request still owns the current folder generation.
  public func loadFolder(url: URL, prepareRetry: (@MainActor () async -> Void)? = nil) async {
    guard !Task.isCancelled else { return }
    retryLoader = { [weak self] in
      guard let self else { return }
      await prepareRetry?()
      await self.loadFolder(url: url, prepareRetry: prepareRetry)
    }
    beginLoadingFilesystemFolder()
    let gen = loadGeneration

    isLoading = true
    defer {
      if gen == loadGeneration {
        isLoading = false
        folderEnumerationTask = nil
      }
    }
    let scope = currentScopeRoot ?? url
    let checkpoint = folderEnumerationCheckpoint
    let slots = folderEnumerationSlots
    let stacksPairs = stacksRawJpegPairs()
    let task = Task.detached(priority: .utility) { () throws -> ([AssetRef], [URL]) in
      try await slots.acquire()
      do {
        try Task.checkCancellation()
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        let contents: [URL]
        do {
          contents = try fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
          )
        } catch {
          if !fm.fileExists(atPath: url.path) { throw BrowseFolderUnavailableError() }
          throw error
        }

        // Partition into sub-folders (minus dotfolders like .maple/) and RAW
        // files at this depth only. Grandchildren are NOT walked — the user
        // drills down by clicking a sub-folder which triggers another
        // `loadFolder(url:)`.
        try Task.checkCancellation()
        await checkpoint?()
        try Task.checkCancellation()
        var subs: [URL] = []
        var raws: [URL] = []
        for entry in contents {
          try Task.checkCancellation()
          if entry.lastPathComponent.hasPrefix(".") { continue }
          let isDir =
            (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
          if isDir {
            subs.append(entry)
          } else if SupportedImageExtensions.all.contains(
            entry.pathExtension.lowercased())
          {
            raws.append(entry)
          }
        }
        subs.sort { $0.lastPathComponent < $1.lastPathComponent }
        raws.sort { $0.lastPathComponent < $1.lastPathComponent }
        // Stamp each AssetRef with the scope root AppShell set before the
        // walk. If nothing's been set we fall back to the folder URL itself
        // — better than nothing when the folder came from `fileImporter` and
        // is already scope-backed.
        let links = await LivePhotoPairing.links(for: raws.map(\.path)) { path in
          let url = URL(fileURLWithPath: path)
          guard let kind = LivePhotoPairing.Kind(filename: url.lastPathComponent) else {
            return nil
          }
          return await LiveContentIdentifier.read(fileAt: url, kind: kind)
        }
        let refs = RawJpegStacking.localRefs(
          raws, scopeParentURL: scope, livePhotoLinks: links, stacksPairs: stacksPairs)

        try Task.checkCancellation()
        await slots.release()
        return (refs, subs)
      } catch {
        await slots.release()
        throw error
      }
    }
    folderEnumerationTask = task
    do {
      let (refs, subs) = try await withTaskCancellationHandler {
        try await task.value
      } onCancel: {
        task.cancel()
      }
      try Task.checkCancellation()
      guard gen == loadGeneration else { return }
      assets = refs
      subfolders = subs
      // Don't auto-select the first image — the user should see the whole
      // folder contents first. Selection (highlight) happens on click; the
      // editor only opens on double-click.
      selectedID = nil
      loadError = nil
      photosAuthNeeded = false  // a folder is never the Photos-permission state (#3536)
      listingGeneration &+= 1
    } catch {
      guard !error.isCancellation, !Task.isCancelled, gen == loadGeneration else { return }
      loadError = error
    }
  }

  /// Re-reads only `url`'s subfolders, leaving its photos and scroll position
  /// alone: for a folder renamed, trashed or created beside a listing the
  /// user is not looking at.
  public func reloadSubfolders(of url: URL) async {
    let gen = loadGeneration
    let scope = currentScopeRoot ?? url
    let subs = await Task.detached(priority: .utility) { () -> [URL]? in
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      guard
        let contents = try? FileManager.default.contentsOfDirectory(
          at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
      else { return nil }
      return
        contents
        .filter { entry in
          !entry.lastPathComponent.hasPrefix(".")
            && (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }.value
    guard let subs, gen == loadGeneration, subs != subfolders else { return }
    subfolders = subs
  }

  /// The cloud counterpart of `reloadSubfolders(of:)`.
  public func reloadCloudSubfolders(_ source: CloudSource, absPath: String) async {
    let gen = loadGeneration
    guard let listing = try? await source.listDir(absPath: absPath), gen == loadGeneration
    else { return }
    let subs = listing.dirs.map { URL(fileURLWithPath: $0.path) }
    guard subs != subfolders else { return }
    subfolders = subs
  }
}
