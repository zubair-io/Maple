// AppShell+PhoneFolderStack.swift — the iPhone Library tab's folder stack
// (#5674).
//
// On iPhone every opened subfolder is its own entry on the Library tab's
// NavigationStack with its own `BrowseViewModel`, so the system back swipe
// shows the real parent underneath and can be cancelled. `browseVM` always
// points at the TOP level's model: every existing action (rename, trash,
// move, export, selection) keeps acting on the folder the user sees.
//
// Two paths keep the stack and the browsing location in agreement:
//   • A grid tap pushes a level (`pushPhoneFolderLevel`) and a back swipe
//     pops one (`phoneLibraryPathChanged`). Both update the location to
//     match, so the stack is never rebuilt behind the user's gesture.
//   • Anything else that moves the location — a side-menu jump, a deep
//     link, relaunch restore, Reveal in Folder — is caught by
//     `reconcilePhoneFolderStack`, which rebuilds the stack from the folder's
//     physical ancestors, bounded by the source's root.
//
// iPad and Mac never call into this file: they keep loading folders in place.

#if os(iOS)

  import MapleCore
  import SwiftUI

  /// The root level of the folder stack, captured while a subfolder is open.
  struct PhoneFolderRoot {
    let browseVM: BrowseViewModel
    /// The selection to restore when the user returns to the root.
    let selection: LibrarySelection
    let path: String
    let title: String
  }

  /// The cheap inputs that decide where the Library tab is browsing. The
  /// stack reconciles only when this changes.
  struct PhoneFolderLocationKey: Equatable {
    let selection: LibrarySelection
    let cloudPath: String?
    let scopeRoot: URL?
    let showsCloudTimeline: Bool
  }

  /// Where the Library tab is browsing, resolved against its source's root.
  struct PhoneFolderLocation: Equatable {
    enum Source: Equatable {
      case local
      case cloud(serverID: URL, folderID: String)
    }

    let source: Source
    let rootPath: String
    let currentPath: String
    let rootTitle: String

    /// Each folder from just below the root down to the current folder.
    /// Empty when the current folder is the root, or is not inside it.
    var levelPaths: [String] {
      let root = Self.components(of: rootPath)
      let current = Self.components(of: currentPath)
      guard current.count > root.count, Array(current.prefix(root.count)) == root else {
        return []
      }
      let depth = current.count - root.count
      let currentURL = URL(fileURLWithPath: currentPath)
      return (0..<depth).reversed().map { up in
        (0..<up).reduce(currentURL) { url, _ in url.deletingLastPathComponent() }.path
      }
    }

    /// Path components with iOS's `/private` alias for `/var` folded away,
    /// so a bookmark-resolved root and a listed child compare equal.
    static func components(of path: String) -> [String] {
      let parts = URL(fileURLWithPath: path).standardizedFileURL.pathComponents
        .filter { $0 != "/" }
      return parts.first == "private" && parts.dropFirst().first == "var"
        ? Array(parts.dropFirst()) : parts
    }

    static func samePath(_ lhs: String, _ rhs: String) -> Bool {
      components(of: lhs) == components(of: rhs)
    }

    static func sameSource(_ lhs: LibrarySelection, _ rhs: LibrarySelection) -> Bool {
      switch (lhs, rhs) {
      case (.folder, .folder): return true
      case (.cloudLibrary(let lServer, let lID), .cloudLibrary(let rServer, let rID)):
        return lServer == rServer && lID == rID
      default: return false
      }
    }
  }

  enum PhoneFolderResolution {
    /// Timeline, PhotoKit, Map, SMB, or a cloud library in timeline mode:
    /// nothing to stack.
    case rootOnly
    /// A folder source whose root is not known yet (a scope still being
    /// claimed, or no cached cloud library record). Leave the stack alone.
    case unresolved
    case located(PhoneFolderLocation)
  }

  @MainActor
  extension AppShell {
    var phoneFolderLocationKey: PhoneFolderLocationKey {
      PhoneFolderLocationKey(
        selection: librarySelection,
        cloudPath: cloudCurrentPath,
        scopeRoot: phoneLocalScopeRoot,
        showsCloudTimeline: cloudTimelineVM != nil)
    }

    /// The local source's root. A folder inside the app's own container
    /// needs no security scope, so `activeScopeURL` stays nil for it; the
    /// browse model still records the root it enumerates under.
    var phoneLocalScopeRoot: URL? { activeScopeURL ?? browseVM.currentScopeRoot }

    /// The model the Library tab's root screen renders.
    var phoneRootBrowseVM: BrowseViewModel { phoneFolderRoot?.browseVM ?? browseVM }

    var phoneRootTitle: String { phoneFolderRoot?.title ?? libraryTitle }

    func resolvePhoneFolderLocation() -> PhoneFolderResolution {
      switch librarySelection {
      case .folder(let path):
        guard let root = phoneLocalScopeRoot else { return .unresolved }
        return .located(
          PhoneFolderLocation(
            source: .local, rootPath: root.path, currentPath: path,
            rootTitle: root.lastPathComponent))
      case .cloudLibrary(let serverID, let folderID):
        guard cloudTimelineVM == nil else { return .rootOnly }
        guard let current = cloudCurrentPath,
          let library = CloudFoldersCache.load(server: serverID)?
            .first(where: { $0.id == folderID })
        else { return .unresolved }
        return .located(
          PhoneFolderLocation(
            source: .cloud(serverID: serverID, folderID: folderID),
            rootPath: library.path, currentPath: current,
            rootTitle: cloudLibraryTitle(
              serverID: serverID, folderID: folderID, libraryPath: library.path)))
      default:
        return .rootOnly
      }
    }

    /// A grid folder tap on iPhone: push a level with its own model and point
    /// `browseVM` at it, so the caller's load fills the child while the
    /// parent keeps its listing. Call BEFORE the caller updates the location.
    func pushPhoneFolderLevel(_ url: URL) {
      guard MapleShellKind.current == .phoneTab else { return }
      let parent = browseVM
      if phoneFolderRoot == nil {
        phoneFolderRoot = PhoneFolderRoot(
          browseVM: parent,
          selection: librarySelection,
          path: phoneCurrentFolderPath ?? url.deletingLastPathComponent().path,
          title: libraryTitle)
      }
      let child = BrowseViewModel()
      child.currentScopeRoot = parent.currentScopeRoot
      browseVM = child
      libraryPath =
        LibraryDestination.folderEntries(in: libraryPath)
        + [.folder(FolderLevel(path: url.path, title: url.lastPathComponent, browseVM: child))]
    }

    /// The folder the top level shows, in the location's own terms.
    private var phoneCurrentFolderPath: String? {
      switch librarySelection {
      case .folder(let path): return path
      case .cloudLibrary: return cloudCurrentPath
      default: return nil
      }
    }

    /// Follows NavigationStack write-backs. A pop (back swipe completed, back
    /// button, or an ancestor picked from the back button's menu) moves
    /// `browseVM` and the browsing location to the new top level. A cancelled
    /// swipe never writes the path, so nothing changes.
    func phoneLibraryPathChanged(from old: [LibraryDestination], to new: [LibraryDestination]) {
      let oldLevels = LibraryDestination.folderLevels(in: old)
      let newLevels = LibraryDestination.folderLevels(in: new)
      guard newLevels.count < oldLevels.count,
        Array(oldLevels.prefix(newLevels.count)) == newLevels,
        let root = phoneFolderRoot
      else { return }
      let target = newLevels.last
      browseVM = target?.browseVM ?? root.browseVM
      let path = target?.path ?? root.path
      libraryTitle = target?.title ?? root.title
      if newLevels.isEmpty { phoneFolderRoot = nil }
      switch librarySelection {
      case .folder:
        librarySelection = target.map { .folder(path: $0.path) } ?? root.selection
        let folderURL = URL(fileURLWithPath: path)
        Task { await RenderedPreviewCache.shared.configure(folderURL: folderURL) }
      case .cloudLibrary(let serverID, let folderID):
        cloudCurrentPath = path
        SourceSelectionStore.save(
          .cloudLibrary(serverID: serverID, folderID: folderID, libraryPath: path))
        if let source = browseVM.currentSource as? CloudSource {
          Task { await source.navigate(to: path) }
        }
      default:
        break
      }
    }

    /// Rebuilds the stack when the browsing location moved without a push or
    /// pop: the levels become the location's physical ancestors. The top
    /// level keeps `browseVM` (whatever moved the location is loading into
    /// it); levels whose folder is unchanged keep their model and scroll
    /// position; new ancestors get a model that starts loading at once, so
    /// the parent is ready before the first back swipe.
    func reconcilePhoneFolderStack() {
      guard MapleShellKind.current == .phoneTab else { return }
      switch resolvePhoneFolderLocation() {
      case .unresolved:
        // The new source's root is not known yet, but levels from another
        // source must not survive to be popped into this one.
        guard let root = phoneFolderRoot,
          !PhoneFolderLocation.sameSource(root.selection, librarySelection)
        else { return }
        phoneFolderRoot = nil
        libraryPath = []
      case .rootOnly:
        guard phoneFolderRoot != nil || !LibraryDestination.folderLevels(in: libraryPath).isEmpty
        else { return }
        phoneFolderRoot = nil
        libraryPath = []
      case .located(let location):
        rebuildPhoneFolderStack(for: location)
      }
    }

    private func rebuildPhoneFolderStack(for location: PhoneFolderLocation) {
      let wanted = location.levelPaths
      // Two servers can share paths, so a level is only kept for the same
      // source as the one it was opened in.
      let sameSource = phoneFolderRoot.map {
        PhoneFolderLocation.sameSource($0.selection, librarySelection)
      }
      let stacked = LibraryDestination.folderLevels(in: libraryPath)
      let current = sameSource == false ? [] : stacked
      let sameRoot =
        sameSource == true
        && phoneFolderRoot.map { PhoneFolderLocation.samePath($0.path, location.rootPath) } == true
      let sameLevels =
        sameSource != false && stacked.count == wanted.count
        && zip(stacked, wanted).allSatisfy { PhoneFolderLocation.samePath($0.path, $1) }
      guard !(sameLevels && (wanted.isEmpty || sameRoot)) else { return }

      let top = browseVM
      guard let topPath = wanted.last else {
        phoneFolderRoot = nil
        libraryPath = []
        return
      }
      let reusable = current.filter { $0.browseVM !== top }
      func reused(_ path: String) -> BrowseViewModel? {
        reusable.first { PhoneFolderLocation.samePath($0.path, path) }?.browseVM
      }
      let keptRoot = sameRoot && phoneFolderRoot?.browseVM !== top ? phoneFolderRoot : nil
      let root =
        keptRoot
        ?? PhoneFolderRoot(
          browseVM: freshPhoneFolderModel(path: location.rootPath, location: location),
          selection: location.source == .local
            ? .folder(path: location.rootPath) : librarySelection,
          path: location.rootPath,
          title: location.rootTitle)
      let levels = wanted.map { path in
        FolderLevel(
          path: path,
          title: URL(fileURLWithPath: path).lastPathComponent,
          browseVM: path == topPath
            ? top : reused(path) ?? freshPhoneFolderModel(path: path, location: location))
      }
      phoneFolderRoot = root
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) {
        libraryPath = levels.map { .folder($0) }
      }
    }

    /// A model for an ancestor the user has not opened in this session,
    /// loaded immediately in its own task.
    private func freshPhoneFolderModel(path: String, location: PhoneFolderLocation)
      -> BrowseViewModel
    {
      let model = BrowseViewModel()
      switch location.source {
      case .local:
        model.currentScopeRoot = phoneLocalScopeRoot
        Task { await model.loadFolder(url: URL(fileURLWithPath: path)) }
      case .cloud(let serverID, let folderID):
        model.isLoading = true
        Task {
          let session = sessionFor(serverID)
          if !session.isSignedIn { await session.bootstrapAndRestore() }
          guard session.isSignedIn else {
            model.isLoading = false
            return
          }
          // Each ancestor gets its own source: `CloudSource` tracks one
          // current path, which the top level's actions rely on.
          await model.loadCloudDir(
            makeCloudLibrarySource(
              serverID: serverID, folderID: folderID, path: location.rootPath),
            absPath: path)
        }
      }
      return model
    }

    /// A move or copy into a folder that is on the stack: reload that level,
    /// so the photos are there after a back swipe, or on screen if the user
    /// already swiped back to it while the batch ran.
    func reloadPhoneFolderLevels(receiving destination: AssetDropDestination) {
      let destinationSource: LibrarySelection? =
        switch destination {
        case .local(let url, _): .folder(path: url.path)
        case .cloud(let server, let folderID, _, _):
          .cloudLibrary(serverID: server, folderID: folderID)
        case .smb: nil
        }
      // The batch may finish after the user switched to a source that
      // happens to share the destination's paths.
      guard MapleShellKind.current == .phoneTab, let destinationSource,
        PhoneFolderLocation.sameSource(destinationSource, librarySelection)
      else { return }
      let destinationPath: String? =
        switch destination {
        case .local(let url, _): url.path
        case .cloud(_, _, _, let absPath): absPath
        case .smb: nil
        }
      if let destinationPath, let top = phoneCurrentFolderPath,
        PhoneFolderLocation.samePath(top, destinationPath)
      {
        let model = browseVM
        Task { await model.retryLastLoad() }
      }
      for (path, model) in phoneLevelsBelowTop {
        switch destination {
        case .local(let url, _) where PhoneFolderLocation.samePath(path, url.path):
          Task { await model.loadFolder(url: url) }
        case .cloud(let server, let folderID, let libraryRoot, let absPath)
        where PhoneFolderLocation.samePath(path, absPath):
          // A source of its own: the shared one tracks the top level's path.
          let source = makeCloudLibrarySource(
            serverID: server, folderID: folderID, path: libraryRoot)
          Task { await model.loadCloudDir(source, absPath: absPath) }
        default:
          continue
        }
      }
    }

    /// Every level under the one on screen, root included.
    private var phoneLevelsBelowTop: [(path: String, model: BrowseViewModel)] {
      let levels =
        LibraryDestination.folderLevels(in: libraryPath).map { ($0.path, $0.browseVM) }
        + [phoneFolderRoot].compactMap { $0 }.map { ($0.path, $0.browseVM) }
      return levels.filter { $0.1 !== browseVM }.map { (path: $0.0, model: $0.1) }
    }

    /// Every level below the one on screen holds a listing that folded or split RAW+JPEG pairs the
    /// old way (#5050).
    func reloadPhoneLevelsForRawJpegStackChange() {
      for (_, model) in phoneLevelsBelowTop {
        Task { await model.retryLastLoad() }
      }
    }

    /// A folder renamed, trashed or created from the side menu can change the
    /// subfolders of a level the user will swipe back to.
    func refreshPhoneFolderSubfolders() {
      guard MapleShellKind.current == .phoneTab,
        case .located(let location) = resolvePhoneFolderLocation()
      else { return }
      for (path, model) in phoneLevelsBelowTop {
        switch location.source {
        case .local:
          Task { await model.reloadSubfolders(of: URL(fileURLWithPath: path)) }
        case .cloud(let serverID, let folderID):
          let source = makeCloudLibrarySource(
            serverID: serverID, folderID: folderID, path: location.rootPath)
          Task { await model.reloadCloudSubfolders(source, absPath: path) }
        }
      }
    }

    /// Keeps the grid filter the same at every level, so the parent revealed
    /// by a back swipe looks the way the user left the child.
    func syncPhoneFolderGridFilter(_ filter: GridFilter) {
      let models =
        LibraryDestination.folderLevels(in: libraryPath).map(\.browseVM)
        + [phoneFolderRoot?.browseVM].compactMap { $0 }
      for model in models where model !== browseVM && model.gridFilter != filter {
        model.selectGridFilter(filter)
      }
    }
  }

#endif
