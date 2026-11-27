import Foundation
import MapleBackup
import Testing

@testable import MapleCore

@MainActor
struct GridFilterTests {
  @Test("Changing filters enters loading state before the metadata task starts")
  func selectionSetsLoadingSynchronously() {
    let vm = BrowseViewModel()
    vm.gridFilter = .all
    vm.selectGridFilter(.picks)
    #expect(vm.gridFilterLoading)
    vm.selectGridFilter(.all)
    #expect(!vm.gridFilterLoading)
  }

  @Test("A new PhotoKit filter waits for the prior page drain to release its slot")
  func filterWaitsForActivePhotoKitDrain() async throws {
    let vm = BrowseViewModel()
    vm.isLoadingPhotoKitPage = true
    let waiter = Task {
      try await vm.waitForActivePhotoKitPage()
      return vm.isLoadingPhotoKitPage
    }
    try await Task.sleep(for: .milliseconds(50))
    vm.finishPhotoKitPageLoad()
    #expect(try await waiter.value == false)
  }

  @Test("Cancelling a replacement filter stops its wait for the old drain")
  func cancelledFilterStopsWaitingForPhotoKitDrain() async throws {
    let vm = BrowseViewModel()
    vm.isLoadingPhotoKitPage = true
    let waiter = Task { try await vm.waitForActivePhotoKitPage() }
    for _ in 0..<100 where vm.photoKitPageWaiters.isEmpty {
      await Task.yield()
    }
    #expect(vm.photoKitPageWaiters.count == 1)
    waiter.cancel()
    await #expect(throws: CancellationError.self) { try await waiter.value }
    #expect(vm.photoKitPageWaiters.isEmpty)
  }

  @Test("Opening a local folder releases PhotoKit paging before enumeration")
  func folderSwitchInvalidatesPhotoKitPaging() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "grid-filter-folder-switch")
    defer { try? FileManager.default.removeItem(at: directory) }
    let localPhoto = directory.appendingPathComponent("local.jpg")
    try Data([0xFF, 0xD8, 0xFF, 0xD9]).write(to: localPhoto)
    let source = PhotoKitSource(
      sidecarOverride: AppSupportSidecarStore(root: directory.appendingPathComponent("sidecars")))
    let vm = BrowseViewModel()
    vm.currentSource = source
    vm.pagedPhotoKitSource = source
    vm.photoKitNextOffset = 42
    vm.photoKitTotalCount = 100
    vm.isLoadingPhotoKitPage = true
    vm.assets = [AssetRef.preview(displayName: "old-photo.jpg")]
    vm.selectGridFilter(.picks)
    let previousGeneration = vm.loadGeneration
    let waiter = Task { try await vm.waitForActivePhotoKitPage() }
    for _ in 0..<100 where vm.photoKitPageWaiters.isEmpty { await Task.yield() }
    #expect(vm.photoKitPageWaiters.count == 1)

    vm.beginLoadingFilesystemFolder()
    try await waiter.value
    #expect(vm.loadGeneration > previousGeneration)
    #expect(vm.currentSource == nil)
    #expect(vm.pagedPhotoKitSource == nil)
    #expect(vm.photoKitNextOffset == 0)
    #expect(vm.photoKitTotalCount == 0)
    #expect(vm.assets.isEmpty)
    #expect(vm.gridFilterLoading)

    await vm.loadFolder(url: directory)
    try await vm.loadRemainingPhotoKitForFilter()
    #expect(vm.assets.map { $0.primaryURL?.lastPathComponent } == ["local.jpg"])
    #expect(vm.pagedPhotoKitSource == nil)
  }

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
    vm.selectedID = assets[0].id
    #expect(vm.selectedVisibleAsset(sessions: sessions) == nil)
    vm.selectedID = assets[1].id
    #expect(vm.selectedVisibleAsset(sessions: sessions)?.id == assets[1].id)
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

  @MainActor
  private final class ReadLog {
    private(set) var names: [String] = []
    func record(_ asset: AssetRef) { names.append(asset.displayName) }
    func drain() -> Set<String> {
      defer { names = [] }
      return Set(names)
    }
  }

  private func localListing(count: Int) throws -> (URL, [AssetRef]) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "grid-filter-facts")
    let assets = try (0..<count).map { index in
      let url = directory.appendingPathComponent("sample-\(index).dng")
      try Data([0x49, 0x49, 0x2A, 0x00]).write(to: url)
      return AssetRef(url: url)
    }
    return (directory, assets)
  }

  private func write(_ asset: AssetRef, stars: Int, modified: Date) async throws {
    try await XMPSidecarStore(rawURL: asset.primaryURL!).writeConfirmed(
      model: .default, culling: CullingState(stars: stars, flag: .none))
    let sidecarPath = SidecarPath.sidecarURL(for: asset.primaryURL!).path
    try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: sidecarPath)
  }

  private func switchFilter(
    _ vm: BrowseViewModel, to filter: GridFilter, log: ReadLog
  ) async -> Set<String> {
    vm.selectGridFilter(filter)
    await vm.loadGridFilterMetadata { asset in
      log.record(asset)
      guard let url = asset.primaryURL else {
        return GridFilterMetadata(culling: CullingState(), hasEdits: false)
      }
      return try await GridFilterMetadata.read(from: XMPSidecarStore(rawURL: url))
    }
    return log.drain()
  }

  @Test("A second filter switch with unchanged sidecars reads nothing and agrees with the first")
  func unchangedSidecarsAreNotReread() async throws {
    let (directory, assets) = try localListing(count: 6)
    defer { try? FileManager.default.removeItem(at: directory) }
    let epoch = Date(timeIntervalSince1970: 1_700_000_000)
    try await write(assets[4], stars: 5, modified: epoch)
    let vm = BrowseViewModel()
    vm.assets = assets
    let log = ReadLog()

    #expect(await switchFilter(vm, to: .fourStars, log: log).count == 6)
    let first = vm.gridAssets(sessions: [:]).map(\.id)
    #expect(await switchFilter(vm, to: .edited, log: log).isEmpty)
    #expect(await switchFilter(vm, to: .fourStars, log: log).isEmpty)
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == first)
    #expect(first == [assets[4].id])
  }

  @Test("A rewritten sidecar is read again and the others are not")
  func rewrittenSidecarIsReread() async throws {
    let (directory, assets) = try localListing(count: 4)
    defer { try? FileManager.default.removeItem(at: directory) }
    let epoch = Date(timeIntervalSince1970: 1_700_000_000)
    try await write(assets[1], stars: 1, modified: epoch)
    let vm = BrowseViewModel()
    vm.assets = assets
    let log = ReadLog()
    _ = await switchFilter(vm, to: .fourStars, log: log)
    #expect(vm.gridAssets(sessions: [:]).isEmpty)

    try await write(assets[1], stars: 5, modified: epoch.addingTimeInterval(60))
    let reread = await switchFilter(vm, to: .edited, log: log)
    #expect(reread == [assets[1].displayName])
    #expect(vm.gridFilterMetadata[assets[1].id]?.culling.stars == 5)
    #expect(await switchFilter(vm, to: .fourStars, log: log).isEmpty)
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [assets[1].id])
  }

  @Test("A sidecar that appears or disappears is read again")
  func createdAndDeletedSidecarsAreReread() async throws {
    let (directory, assets) = try localListing(count: 3)
    defer { try? FileManager.default.removeItem(at: directory) }
    let epoch = Date(timeIntervalSince1970: 1_700_000_000)
    try await write(assets[0], stars: 5, modified: epoch)
    let vm = BrowseViewModel()
    vm.assets = assets
    let log = ReadLog()
    _ = await switchFilter(vm, to: .fourStars, log: log)
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [assets[0].id])

    try await write(assets[2], stars: 4, modified: epoch)
    try FileManager.default.removeItem(at: SidecarPath.sidecarURL(for: assets[0].primaryURL!))
    let reread = await switchFilter(vm, to: .edited, log: log)
    #expect(reread == [assets[0].displayName, assets[2].displayName])
    #expect(vm.gridAssets(sessions: [:]).map(\.id) == [assets[2].id])
  }

  @Test("A sourceless asset is read on every switch")
  func sourcelessAssetIsAlwaysRead() async throws {
    let (directory, local) = try localListing(count: 2)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sourceless = AssetRef.preview(displayName: "cloud.jpg")
    let vm = BrowseViewModel()
    vm.assets = local + [sourceless]
    let log = ReadLog()
    #expect(await switchFilter(vm, to: .picks, log: log).count == 3)
    #expect(await switchFilter(vm, to: .edited, log: log) == [sourceless.displayName])
    #expect(await switchFilter(vm, to: .picks, log: log) == [sourceless.displayName])
  }

  @Test("A relisting drops the kept facts")
  func relistingDropsKeptFacts() async throws {
    let (directory, assets) = try localListing(count: 3)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vm = BrowseViewModel()
    vm.assets = assets
    let log = ReadLog()
    _ = await switchFilter(vm, to: .picks, log: log)
    #expect(await switchFilter(vm, to: .edited, log: log).isEmpty)

    await vm.loadFolder(url: directory)
    #expect(await switchFilter(vm, to: .picks, log: log).count == 3)
    #expect(await switchFilter(vm, to: .edited, log: log).isEmpty)

    vm.invalidateGridFilterForAssetIdentityChange()
    #expect(await switchFilter(vm, to: .picks, log: log).count == 3)
  }
}
