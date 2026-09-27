#if os(iOS)
  import Foundation
  import MapleCore
  import XCTest

  @testable import Maple

  @MainActor
  final class PhoneSelectionActionCapabilityTests: XCTestCase {
    private let localRoot = URL(fileURLWithPath: "/Photos")
    private let cloudServer = URL(string: "https://maple.example")!

    func testZeroOneMultipleAndAllCheckedSelection() {
      let assets = [local("a.dng"), local("b.dng"), local("c.dng")]
      let vm = BrowseViewModel()
      vm.assets = assets
      vm.selectedID = assets[0].id

      vm.toggleSelected(assets[0].id)
      XCTAssertTrue(vm.selectedAssets.isEmpty, "Checking is inert outside Select mode")

      vm.enterSelectMode()
      XCTAssertTrue(vm.selectedAssets.isEmpty)
      XCTAssertFalse(vm.canMergePanorama)
      XCTAssertEqual(vm.selectedID, assets[0].id)

      vm.toggleSelected(assets[1].id)
      XCTAssertEqual(vm.selectedAssets.map(\.id), [assets[1].id])
      XCTAssertFalse(vm.canMergePanorama)

      vm.toggleSelected(assets[2].id)
      XCTAssertEqual(vm.selectedAssets.map(\.id), [assets[1].id, assets[2].id])
      XCTAssertTrue(vm.canMergePanorama)

      vm.selectedIDs = Set(vm.assets.map(\.id))
      XCTAssertEqual(vm.selectedAssets.map(\.id), assets.map(\.id))
      XCTAssertEqual(vm.selectedIDs.count, vm.assets.count)

      vm.clearSelection()
      XCTAssertTrue(vm.isSelecting)
      XCTAssertTrue(vm.selectedAssets.isEmpty)
      vm.select(assets[0].id)
      vm.exitSelectMode()
      XCTAssertFalse(vm.isSelecting)
      XCTAssertTrue(vm.selectedIDs.isEmpty)
      XCTAssertEqual(vm.selectedID, assets[0].id)
    }

    func testLocalMoveRequiresAllCheckedAssetsInsideAuthorizedRoot() {
      let source = PhoneAssetMoveSource.local(rootURL: localRoot, rootBookmark: Data([1]))
      let first = local("a.dng")
      let second = local("b.dng")
      let outside = AssetRef(url: URL(fileURLWithPath: "/Photos-Other/c.dng"))
      let vm = selection([first, second, outside])

      XCTAssertFalse(PhoneAssetMoveEligibility.canMove(vm.selectedAssets, from: source))
      vm.select(first.id)
      XCTAssertTrue(PhoneAssetMoveEligibility.canMove(vm.selectedAssets, from: source))
      vm.select(second.id)
      XCTAssertTrue(PhoneAssetMoveEligibility.canMove(vm.selectedAssets, from: source))
      vm.select(outside.id)
      XCTAssertFalse(PhoneAssetMoveEligibility.canMove(vm.selectedAssets, from: source))
      XCTAssertFalse(
        PhoneAssetMoveEligibility.canMove(
          [first], from: .local(rootURL: localRoot, rootBookmark: Data())))
    }

    func testPhotoKitAndSMBSelectionCannotUseLocalOrCloudMovePicker() {
      let photo = sourceless("photo.dng", id: "ph-id", provenance: .photoKit)
      let smb = sourceless("share.dng", id: "smb-id", provenance: .smb)
      let local = PhoneAssetMoveSource.local(rootURL: localRoot, rootBookmark: Data([1]))
      let cloud = cloudMoveSource()

      for assets in [[photo], [smb], [photo, smb]] {
        XCTAssertFalse(PhoneAssetMoveEligibility.canMove(assets, from: local))
        XCTAssertFalse(PhoneAssetMoveEligibility.canMove(assets, from: cloud))
      }
      XCTAssertNotNil(photo.adjustmentTransferTarget)
      XCTAssertNotNil(smb.adjustmentTransferTarget)
      XCTAssertNil(photo.primaryURL)
      XCTAssertNil(smb.primaryURL)
    }

    func testCloudMoveRejectsMixedServerOrLibrarySelection() {
      let source = cloudMoveSource()
      let first = cloud("a.dng", server: cloudServer, folderID: "library-a")
      let second = cloud("b.dng", server: cloudServer, folderID: "library-a")
      let otherServer = cloud(
        "c.dng", server: URL(string: "https://other.example")!, folderID: "library-a")
      let otherLibrary = cloud("d.dng", server: cloudServer, folderID: "library-b")
      let vm = selection([first, second, otherServer, otherLibrary])

      vm.selectedIDs = [first.id, second.id]
      XCTAssertTrue(PhoneAssetMoveEligibility.canMove(vm.selectedAssets, from: source))
      vm.select(otherServer.id)
      XCTAssertFalse(PhoneAssetMoveEligibility.canMove(vm.selectedAssets, from: source))
      vm.deselect(otherServer.id)
      vm.select(otherLibrary.id)
      XCTAssertFalse(PhoneAssetMoveEligibility.canMove(vm.selectedAssets, from: source))
    }

    func testSettingsTransferRequiresStableTargetsAndExcludesUnsupportedFormats() {
      let source = local("source.dng")
      let target = cloud("target.dng", server: cloudServer, folderID: "library-a")
      let photo = sourceless("photo.dng", id: "ph-id", provenance: .photoKit)
      let smb = sourceless("share.dng", id: "smb-id", provenance: .smb)
      let missingID = sourceless("missing.dng", id: nil, provenance: nil)
      let video = local("clip.mov")
      let audio = local("note.mp3")
      let stub = local("archive.eip")
      let vm = selection([source, target, photo, smb, missingID, video, audio, stub])

      for asset in [source, target, photo, smb] {
        XCTAssertNotNil(asset.adjustmentTransferTarget, asset.displayName)
      }
      for asset in [missingID, video, audio, stub] {
        XCTAssertNil(asset.adjustmentTransferTarget, asset.displayName)
      }

      vm.selectedID = source.id
      vm.selectedIDs = [source.id]
      XCTAssertFalse(vm.selectedAssets.contains { $0.id != vm.selectedID })
      vm.select(target.id)
      XCTAssertTrue(vm.selectedAssets.allSatisfy { $0.adjustmentTransferTarget != nil })
      XCTAssertTrue(vm.selectedAssets.contains { $0.id != vm.selectedID })
      vm.select(video.id)
      XCTAssertFalse(vm.selectedAssets.allSatisfy { $0.adjustmentTransferTarget != nil })
      vm.deselect(video.id)
      vm.selectedID = missingID.id
      XCTAssertNil(vm.selectedAsset?.adjustmentTransferTarget)
    }

    func testClipboardScopeMustMatchConnectedLibraryForPaste() {
      let clipboard = AdjustmentClipboard()
      let asset = local("target.dng")
      let vm = selection([asset])
      vm.select(asset.id)

      XCTAssertNil(clipboard.contents)
      clipboard.copy(model: .default, sourceName: "source", scopeID: "library-a")
      XCTAssertEqual(clipboard.contents?.scopeID, "library-a")
      XCTAssertNotNil(vm.selectedAssets.first?.adjustmentTransferTarget)
      XCTAssertNotEqual(clipboard.contents?.scopeID, "library-b")
      clipboard.clear()
      XCTAssertNil(clipboard.contents)
    }

    private func selection(_ assets: [AssetRef]) -> BrowseViewModel {
      let vm = BrowseViewModel()
      vm.assets = assets
      vm.enterSelectMode()
      return vm
    }

    private func local(_ name: String) -> AssetRef {
      AssetRef(url: localRoot.appendingPathComponent(name))
    }

    private func sourceless(
      _ name: String, id: String?, provenance: AssetRef.ThumbnailProvenance?
    ) -> AssetRef {
      AssetRef(
        displayName: name, hintExtension: "dng", stableID: id,
        thumbnailProvenance: provenance, bytesProvider: { Data() })
    }

    private func cloud(_ name: String, server: URL, folderID: String) -> AssetRef {
      AssetRef(
        displayName: name, hintExtension: "dng", stableID: "fs:/shares/a/\(name)",
        catalog: CatalogRef(
          serverID: server, folderID: folderID, absPath: "/shares/a/\(name)", address: nil),
        bytesProvider: { Data() })
    }

    private func cloudMoveSource() -> PhoneAssetMoveSource {
      .cloud(
        server: cloudServer, libraryFolderID: "library-a", libraryRootPath: "/shares/a")
    }
  }
#endif
