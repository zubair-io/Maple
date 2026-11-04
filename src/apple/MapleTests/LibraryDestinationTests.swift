#if os(iOS)

  import MapleCore
  import XCTest

  @testable import Maple

  final class LibraryDestinationTests: XCTestCase {
    func testPreviewHeroIsVisibleForPreviewAlone() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertTrue(LibraryDestination.presentsPreviewHero(in: [.preview(asset)]))
    }

    func testPreviewHeroIsHiddenWhileEditorIsPushed() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertFalse(
        LibraryDestination.presentsPreviewHero(in: [.preview(asset), .edit(asset)]),
        "the Preview overlay must not cover or intercept the pushed editor")
    }

    func testPreviewHeroIsHiddenWhenNoPreviewIsOpen() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertFalse(LibraryDestination.presentsPreviewHero(in: []))
      XCTAssertFalse(LibraryDestination.presentsPreviewHero(in: [.edit(asset)]))
    }

    func testPushedDestinationsExcludePreviewAndPreserveEditor() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertEqual(
        LibraryDestination.pushedDestinations(in: [.preview(asset), .edit(asset)]),
        [.edit(asset)])
    }

    func testEditorFilmstripSwitchKeepsPreviewAndEditorOnSamePhoto() {
      let first = AssetRef.preview(displayName: "IMG_0001.dng")
      let second = AssetRef.preview(displayName: "IMG_0002.dng")

      XCTAssertEqual(
        LibraryDestination.replacingAsset(in: [.preview(first), .edit(first)], with: second),
        [.preview(second), .edit(second)])
    }

    // MARK: - Folder stack (#5674)

    @MainActor
    private func folder(_ path: String) -> LibraryDestination {
      .folder(
        FolderLevel(
          path: path, title: URL(fileURLWithPath: path).lastPathComponent,
          browseVM: BrowseViewModel()))
    }

    @MainActor
    func testPreviewHeroStaysVisibleAboveFolderLevels() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")
      let path = [folder("/r/a"), folder("/r/a/b"), .preview(asset)]

      XCTAssertTrue(LibraryDestination.presentsPreviewHero(in: path))
      XCTAssertFalse(LibraryDestination.presentsPreviewHero(in: path + [.edit(asset)]))
      XCTAssertFalse(LibraryDestination.presentsPreviewHero(in: [folder("/r/a")]))
    }

    @MainActor
    func testEditorPopReturnsToPreviewInsideFolder() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")
      let a = folder("/r/a")
      let path: [LibraryDestination] = [a, .preview(asset), .edit(asset)]

      XCTAssertEqual(LibraryDestination.pushedDestinations(in: path), [a, .edit(asset)])
      XCTAssertEqual(
        LibraryDestination.applyingPushedDestinations([a], to: path), [a, .preview(asset)])
    }

    @MainActor
    func testFolderPopDropsLevelsAndAnyPhotoOpenedFromThem() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")
      let a = folder("/r/a")
      let b = folder("/r/a/b")

      XCTAssertEqual(LibraryDestination.applyingPushedDestinations([a], to: [a, b]), [a])
      XCTAssertEqual(
        LibraryDestination.applyingPushedDestinations([a], to: [a, b, .preview(asset)]), [a])
      XCTAssertEqual(LibraryDestination.applyingPushedDestinations([], to: [a, b]), [])
    }

    @MainActor
    func testPhotoChangesKeepFolderLevels() {
      let first = AssetRef.preview(displayName: "IMG_0001.dng")
      let second = AssetRef.preview(displayName: "IMG_0002.dng")
      let a = folder("/r/a")
      let path: [LibraryDestination] = [a, .preview(first), .edit(first)]

      XCTAssertEqual(
        LibraryDestination.replacingAsset(in: path, with: second),
        [a, .preview(second), .edit(second)])
      XCTAssertEqual(LibraryDestination.folderEntries(in: path), [a])
    }

    func testLevelPathsWalkPhysicalAncestorsBelowRoot() {
      let location = PhoneFolderLocation(
        source: .local, rootPath: "/r", currentPath: "/r/a/b/c", rootTitle: "r")

      XCTAssertEqual(location.levelPaths, ["/r/a", "/r/a/b", "/r/a/b/c"])
    }

    func testLevelPathsAreEmptyAtRootOrOutsideIt() {
      XCTAssertEqual(
        PhoneFolderLocation(source: .local, rootPath: "/r/", currentPath: "/r", rootTitle: "r")
          .levelPaths, [])
      XCTAssertEqual(
        PhoneFolderLocation(source: .local, rootPath: "/r", currentPath: "/other/a", rootTitle: "r")
          .levelPaths, [])
      XCTAssertEqual(
        PhoneFolderLocation(source: .local, rootPath: "/r/a", currentPath: "/r/ab", rootTitle: "a")
          .levelPaths, [])
    }

    func testPrivateVarAliasMatchesVar() {
      let location = PhoneFolderLocation(
        source: .local, rootPath: "/private/var/mobile/Photos",
        currentPath: "/var/mobile/Photos/2026", rootTitle: "Photos")

      XCTAssertEqual(location.levelPaths, ["/var/mobile/Photos/2026"])
      XCTAssertTrue(
        PhoneFolderLocation.samePath("/private/var/mobile/Photos", "/var/mobile/Photos/"))
    }

    @MainActor
    func testReloadSubfoldersPicksUpFolderChangesAndKeepsPhotos() async throws {
      let root = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
      defer { try? FileManager.default.removeItem(at: root) }
      for name in ["Keep", "Old", ".maple"] {
        try FileManager.default.createDirectory(
          at: root.appendingPathComponent(name), withIntermediateDirectories: true)
      }
      let model = BrowseViewModel()
      await model.loadFolder(url: root)
      let photos = model.assets
      try FileManager.default.moveItem(
        at: root.appendingPathComponent("Old"), to: root.appendingPathComponent("New"))

      await model.reloadSubfolders(of: root)

      XCTAssertEqual(model.subfolders.map(\.lastPathComponent), ["Keep", "New"])
      XCTAssertEqual(model.assets, photos)
    }

    func testSourceSwitchIsDetectedAcrossKindsAndCloudLibraries() {
      let server = URL(string: "https://maple.example")!
      let local = LibrarySelection.folder(path: "/var/mobile/Photos/2026")
      let cloud = LibrarySelection.cloudLibrary(serverID: server, folderID: "a")

      XCTAssertTrue(
        PhoneFolderLocation.sameSource(local, .folder(path: "/var/mobile/Photos")))
      XCTAssertTrue(
        PhoneFolderLocation.sameSource(cloud, .cloudLibrary(serverID: server, folderID: "a")))
      XCTAssertFalse(PhoneFolderLocation.sameSource(local, cloud))
      XCTAssertFalse(
        PhoneFolderLocation.sameSource(cloud, .cloudLibrary(serverID: server, folderID: "b")))
    }
  }

#endif
