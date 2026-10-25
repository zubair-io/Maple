import Foundation
import Testing

@testable import MapleCore

@MainActor
struct GridFilterTests {
  @Test("Real XMP sidecars filter an offscreen pick and keep missing sidecars unedited")
  func realSidecarRoundTrip() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "grid-filter-xmp")
    defer { try? FileManager.default.removeItem(at: directory) }
    let assets = (0..<20).map { index in
      AssetRef(url: directory.appendingPathComponent("sample-\(index).jpg"))
    }
    for asset in assets {
      try Data([0xFF, 0xD8, 0xFF, 0xD9]).write(to: asset.primaryURL!)
    }
    try await XMPSidecarStore(rawURL: assets[19].primaryURL!).writeConfirmed(
      model: .default, culling: CullingState(stars: 5, flag: .pick))

    let vm = BrowseViewModel()
    vm.assets = assets
    vm.selectGridFilter(.picks)
    await vm.loadGridFilterMetadata { asset in
      try await GridFilterMetadata.read(from: XMPSidecarStore(rawURL: asset.primaryURL!))
    }
    #expect(vm.gridFilterError == nil)
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [assets[19].id])
    vm.gridFilter = .edited
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [assets[19].id])
    #expect(vm.gridFilterMetadata[assets[0].id]?.hasEdits == false)
  }

  @Test("Select-all and navigation stay inside visible filter results")
  func selectionUsesVisibleAssets() async {
    let vm = BrowseViewModel()
    vm.assets = (0..<3).map { AssetRef.preview(displayName: "sample-\($0).jpg") }
    vm.selectGridFilter(.picks)
    await vm.loadGridFilterMetadata { asset in
      GridFilterMetadata(
        culling: CullingState(flag: asset.id == vm.assets[2].id ? .pick : .none),
        hasEdits: false)
    }
    let visible = vm.gridAssets(sessions: [:])
    vm.enterSelectMode()
    vm.selectedIDs = Set(visible.map(\.id))
    #expect(vm.selectedAssets(sessions: [:]).map(\.id) == [vm.assets[2].id])
    vm.selectedID = vm.assets[0].id
    vm.selectNext(in: visible)
    #expect(vm.selectedID == vm.assets[2].id)
    vm.selectGridFilter(.all)
    #expect(vm.selectedIDs.isEmpty)
    #expect(vm.selectedID == nil)
  }

  @Test("A renamed asset reloads metadata under its new identity")
  func renamedAssetReloadsMetadata() async {
    let vm = BrowseViewModel()
    let original = AssetRef.preview(displayName: "before.jpg")
    let renamed = AssetRef.preview(displayName: "after.jpg")
    vm.assets = [original]
    vm.selectGridFilter(.picks)
    await vm.loadGridFilterMetadata { _ in
      GridFilterMetadata(culling: CullingState(flag: .pick), hasEdits: false)
    }
    vm.assets = [renamed]
    vm.invalidateGridFilterForAssetIdentityChange()
    #expect(vm.gridAssets(sessions: [:]).isEmpty)
    await vm.loadGridFilterMetadata { _ in
      GridFilterMetadata(culling: CullingState(flag: .pick), hasEdits: false)
    }
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [renamed.id])
  }

  @Test("Bulk targets follow the same live culling state as visible tiles")
  func selectedAssetsUseLiveCulling() async {
    let vm = BrowseViewModel()
    let assets = (0..<2).map { AssetRef.preview(displayName: "sample-\($0).jpg") }
    vm.assets = assets
    vm.selectGridFilter(.picks)
    await vm.loadGridFilterMetadata { _ in
      GridFilterMetadata(culling: CullingState(flag: .pick), hasEdits: false)
    }
    vm.enterSelectMode()
    vm.selectedIDs = Set(assets.map(\.id))
    let changedSession = EditSession(asset: assets[0])
    changedSession.culling.flag = .none
    changedSession.hasLoadedSidecar = true
    let sessions = [assets[0].id: changedSession]
    let visible = vm.gridAssets(sessions: sessions)
    #expect(visible.map(\.id) == [assets[1].id])
    #expect(vm.selectedAssets(sessions: sessions).map(\.id) == [assets[1].id])
    #expect(vm.selectedAssets(in: visible).map(\.id) == [assets[1].id])
  }

  @Test("Tapping the active filter keeps its loaded results")
  func activeFilterKeepsResults() async {
    let vm = BrowseViewModel()
    let asset = AssetRef.preview(displayName: "pick.jpg")
    vm.assets = [asset]
    vm.gridFilter = .all
    vm.selectGridFilter(.picks)
    await vm.loadGridFilterMetadata { _ in
      GridFilterMetadata(culling: CullingState(flag: .pick), hasEdits: false)
    }
    vm.selectGridFilter(.picks)
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [asset.id])
  }

  @Test("Pick and star filters include offscreen assets after a full-list metadata read")
  func filtersFullListing() async {
    let vm = BrowseViewModel()
    vm.assets = (0..<20).map { AssetRef.preview(displayName: "sample-\($0).jpg") }
    let last = vm.assets[19]
    vm.gridFilter = .picks
    await vm.loadGridFilterMetadata { asset in
      GridFilterMetadata(
        culling: CullingState(
          stars: asset.id == last.id ? 5 : 0,
          flag: asset.id == last.id ? .pick : .none),
        hasEdits: asset.id == last.id)
    }
    #expect(vm.gridFilterError == nil)
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [last.id])

    vm.gridFilter = .fourStars
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [last.id])
    vm.gridFilter = .edited
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [last.id])
    vm.gridFilter = .all
    #expect(vm.gridAssets(sessions: [:]).count == 20)
  }

  @Test("A failed metadata read never displays a partial result")
  func errorDoesNotPublishPartialMatches() async {
    let vm = BrowseViewModel()
    vm.assets = (0..<3).map { AssetRef.preview(displayName: "sample-\($0).jpg") }
    vm.gridFilter = .picks
    await vm.loadGridFilterMetadata { asset in
      if asset.displayName == "sample-2.jpg" {
        throw ImageSourceError.notFound("sidecar")
      }
      return GridFilterMetadata(culling: CullingState(flag: .pick), hasEdits: false)
    }
    #expect(vm.gridFilterError != nil)
    #expect(vm.gridFilterMetadata.isEmpty)
    #expect(vm.gridAssets(sessions: [:]).isEmpty)
  }

  @Test("An in-memory model alone does not mark a photo Edited")
  func unsavedModelIsNotEdited() async {
    let vm = BrowseViewModel()
    let asset = AssetRef.preview(displayName: "as-shot.jpg")
    vm.assets = [asset]
    vm.gridFilter = .edited
    await vm.loadGridFilterMetadata { _ in
      GridFilterMetadata(culling: CullingState(), hasEdits: false)
    }
    let session = EditSession(asset: asset)
    session.isHydratingInitialState = true
    session.model.exposure = 1
    session.isHydratingInitialState = false
    session.hasLoadedSidecar = true
    #expect(vm.gridAssets(sessions: [asset.id: session]).isEmpty)
  }
}
