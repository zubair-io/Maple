import Testing

@testable import MapleCore

@MainActor
struct GridFilterTests {
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
