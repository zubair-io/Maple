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
    #expect(vm.selectedAssets.map(\.id) == [vm.assets[2].id])
    vm.selectedID = vm.assets[0].id
    vm.selectNext(in: visible)
    #expect(vm.selectedID == vm.assets[2].id)
    vm.selectGridFilter(.all)
    #expect(vm.selectedIDs.isEmpty)
    #expect(vm.selectedID == nil)
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
