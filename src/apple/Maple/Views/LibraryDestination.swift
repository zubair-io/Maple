// LibraryDestination.swift — typed navigation route for the iPhone Library
// tab's NavigationStack (Fast Preview epic §1, folder stack #5674).
//
// The path is always shaped `[folder…, preview?, edit?]`: zero or more folder
// levels below the selected source's root, then the photo being viewed.
// Back pops one level (`editor → preview → folder → parent folder → root`).

#if os(iOS)

  import MapleCore

  /// One folder level pushed below the source root. Each level owns its own
  /// `BrowseViewModel`, so the parent's listing and scroll position stay live
  /// beneath the child while the interactive back swipe is in progress.
  struct FolderLevel: Hashable {
    /// Local file path or cloud server path of this folder.
    let path: String
    let title: String
    let browseVM: BrowseViewModel

    static func == (lhs: FolderLevel, rhs: FolderLevel) -> Bool {
      lhs.path == rhs.path && lhs.browseVM === rhs.browseVM
    }

    func hash(into hasher: inout Hasher) {
      hasher.combine(path)
      hasher.combine(ObjectIdentifier(browseVM))
    }
  }

  /// One entry on the iPhone Library tab's navigation stack.
  enum LibraryDestination: Hashable {
    /// A subfolder below the selected source's root.
    case folder(FolderLevel)
    /// The fast static Preview surface (default target of a grid / filmstrip /
    /// cloud-result tap).
    case preview(AssetRef)
    /// The live editor for the asset (reached only from Preview's Edit button).
    case edit(AssetRef)

    /// The photo this destination is about; nil for a folder level.
    var asset: AssetRef? {
      switch self {
      case .preview(let a), .edit(let a): return a
      case .folder: return nil
      }
    }

    var folderLevel: FolderLevel? {
      guard case .folder(let level) = self else { return nil }
      return level
    }

    static func folderLevels(in path: [LibraryDestination]) -> [FolderLevel] {
      path.compactMap(\.folderLevel)
    }

    /// The path with the open photo (Preview and Editor) dropped, keeping the
    /// folder the user is in.
    static func folderEntries(in path: [LibraryDestination]) -> [LibraryDestination] {
      path.filter { $0.folderLevel != nil }
    }

    /// The destinations the iPhone `NavigationStack` actually pushes.
    /// Preview is rendered by `PreviewHero` above the stack so the grid can
    /// remain alive beneath it; every other route is a normal stack push.
    static func pushedDestinations(in path: [LibraryDestination]) -> [LibraryDestination] {
      path.filter {
        if case .preview = $0 { return false }
        return true
      }
    }

    /// Applies a NavigationStack write-back (a pop, or a jump from the back
    /// button's ancestor menu) to the full path. Preview is not on the stack,
    /// so it goes back in its slot unless its folder was popped too.
    static func applyingPushedDestinations(
      _ pushed: [LibraryDestination], to path: [LibraryDestination]
    ) -> [LibraryDestination] {
      let folders = folderEntries(in: pushed)
      let media = pushed.filter { $0.folderLevel == nil }
      let previews = path.filter {
        if case .preview = $0 { return true }
        return false
      }
      let keepsPreview = folders == folderEntries(in: path)
      return folders + (keepsPreview ? previews : []) + media
    }

    /// Switching an editor-filmstrip photo must update the Preview beneath
    /// it too, so Back shows the newly edited photo rather than the old one.
    static func replacingAsset(
      in path: [LibraryDestination], with asset: AssetRef
    ) -> [LibraryDestination] {
      path.map { destination in
        switch destination {
        case .preview: return .preview(asset)
        case .edit: return .edit(asset)
        case .folder: return destination
        }
      }
    }

    /// Whether the Preview hero should be visible and interactive.
    ///
    /// The hero remains mounted while the editor is pushed so its paging and
    /// zoom state survive an Editor -> Preview back navigation. It must still
    /// become transparent and stop hit-testing while any pushed destination
    /// is above Preview; otherwise its overlay covers the editor and makes the
    /// Edit button appear inert (#3819). Folder levels sit below Preview.
    static func presentsPreviewHero(in path: [LibraryDestination]) -> Bool {
      guard
        let previewIndex = path.firstIndex(where: {
          if case .preview = $0 { return true }
          return false
        })
      else { return false }
      return path.index(after: previewIndex) == path.endIndex
    }
  }

#endif
