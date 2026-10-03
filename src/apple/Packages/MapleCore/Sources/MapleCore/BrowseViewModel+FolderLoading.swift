import Foundation

extension BrowseViewModel {
  /// Enumerate and construct refs off MainActor, including NAS metadata reads.
  /// Publish only if this request still owns the current folder generation.
  public func loadFolder(url: URL) async {
    loadGeneration &+= 1
    let gen = loadGeneration

    isLoading = true
    defer { if gen == loadGeneration { isLoading = false } }
    let scope = currentScopeRoot ?? url
    do {
      let (refs, subs) = try await Task.detached(priority: .utility) {
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        guard
          let contents = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
          )
        else {
          throw CocoaError(.fileReadUnknown)
        }

        // Partition into sub-folders (minus dotfolders like .maple/) and RAW
        // files at this depth only. Grandchildren are NOT walked — the user
        // drills down by clicking a sub-folder which triggers another
        // `loadFolder(url:)`.
        var subs: [URL] = []
        var raws: [URL] = []
        for entry in contents {
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
        let refs = raws.map { AssetRef(url: $0, scopeParentURL: scope) }

        return (refs, subs)
      }.value
      guard gen == loadGeneration else { return }
      assets = refs
      subfolders = subs
      // Don't auto-select the first image — the user should see the whole
      // folder contents first. Selection (highlight) happens on click; the
      // editor only opens on double-click.
      selectedID = nil
      loadError = nil
      photosAuthNeeded = false  // a folder is never the Photos-permission state (#3536)
    } catch {
      guard gen == loadGeneration else { return }
      loadError = error
    }
  }

}
