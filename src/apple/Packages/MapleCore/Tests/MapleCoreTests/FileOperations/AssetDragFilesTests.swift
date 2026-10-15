import XCTest

@testable import MapleCore

final class AssetDragFilesTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

  func testLocalDragCopiesOriginalBytesAndLeavesOriginalAndSidecarUntouched() async throws {
    let source = root.appendingPathComponent("Original photo.dng")
    let sidecar = root.appendingPathComponent("Original photo.xmp")
    let originalBytes = Data([0x49, 0x49, 0x2A, 0, 0, 0xFF])
    let sidecarBytes = Data("<x:xmpmeta>original edits</x:xmpmeta>".utf8)
    try originalBytes.write(to: source)
    try sidecarBytes.write(to: sidecar)
    let destination = root.appendingPathComponent("copied.dng")

    try await AssetDragFiles.shared.writeOriginal(AssetRef(url: source), to: destination)

    XCTAssertEqual(try Data(contentsOf: destination), originalBytes)
    XCTAssertEqual(try Data(contentsOf: source), originalBytes)
    XCTAssertEqual(try Data(contentsOf: sidecar), sidecarBytes)
  }

  func testRemoteDragWritesFullOriginalWithItsFilename() async throws {
    let bytes = Data([0xFF, 0xD8, 0, 0xFF, 0xD9])
    let asset = remoteAsset(name: "Remote photo.jpg", bytes: bytes)
    let destination = root.appendingPathComponent(AssetDragFiles.fileName(for: asset))

    try await AssetDragFiles.shared.writeOriginal(asset, to: destination)

    XCTAssertEqual(destination.lastPathComponent, "Remote photo.jpg")
    XCTAssertEqual(try Data(contentsOf: destination), bytes)
  }

  func testExistingDestinationAndOriginalCannotBeOverwritten() async throws {
    let source = root.appendingPathComponent("original.dng")
    let destination = root.appendingPathComponent("existing.dng")
    let bytes = Data([1, 2, 3])
    let existing = Data([4, 5, 6])
    try bytes.write(to: source)
    try existing.write(to: destination)
    let remote = remoteAsset(name: "remote.dng", bytes: bytes)

    for (asset, target) in [
      (AssetRef(url: source), destination), (remote, destination),
      (AssetRef(url: source), source),
    ] {
      do {
        try await AssetDragFiles.shared.writeOriginal(asset, to: target)
        XCTFail("Drag must refuse an occupied destination")
      } catch {}
    }
    XCTAssertEqual(try Data(contentsOf: source), bytes)
    XCTAssertEqual(try Data(contentsOf: destination), existing)
  }

  func testRemoteFailureIsReportedWithoutCreatingAFile() async throws {
    let asset = AssetRef(
      displayName: "offline.dng", hintExtension: "dng",
      originalFileWriter: { destination in
        try Data([1, 2]).write(to: destination)
        throw ImageSourceError.notFound("offline")
      }, bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
    let destination = root.appendingPathComponent("offline.dng")
    do {
      try await AssetDragFiles.shared.writeOriginal(asset, to: destination)
      XCTFail("A failed fetch must fail the file promise")
    } catch {
      XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
      XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }
  }

  func testStreamingWriterDeliversChunksWithoutCallingBytesProvider() async throws {
    let chunk = Data(repeating: 42, count: 64 * 1024)
    let asset = AssetRef(
      displayName: "large.dng", hintExtension: "dng",
      originalFileWriter: { destination in
        XCTAssertTrue(FileManager.default.createFile(atPath: destination.path, contents: nil))
        let file = try FileHandle(forWritingTo: destination)
        defer { try? file.close() }
        for _ in 0..<32 { try file.write(contentsOf: chunk) }
      }, bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
    let destination = root.appendingPathComponent("large.dng")
    try await AssetDragFiles.shared.writeOriginal(asset, to: destination)
    XCTAssertEqual(try Data(contentsOf: destination), Data(repeating: 42, count: chunk.count * 32))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["large.dng"])
  }

  func testCancelledTransferRemovesPartialFileAndDoesNotPublishDestination() async throws {
    let asset = AssetRef(
      displayName: "cancelled.dng", hintExtension: "dng",
      originalFileWriter: { destination in
        try Data([1, 2]).write(to: destination)
        withUnsafeCurrentTask { $0?.cancel() }
      }, bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
    let destination = root.appendingPathComponent("cancelled.dng")
    let transfer = Task { try await AssetDragFiles.shared.writeOriginal(asset, to: destination) }
    do {
      try await transfer.value
      XCTFail("A cancelled transfer must fail the promise")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }

  @MainActor
  func testSMBGridDragStreamsOriginalAndPreservesSourceAndSidecar() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let sidecar = fixture.share.appendingPathComponent("photo.xmp")
    let edits = try Data(contentsOf: sidecar)
    let browse = BrowseViewModel()
    await browse.loadSource(fixture.source)
    XCTAssertNil(browse.loadError)
    let asset = try XCTUnwrap(browse.assets.first)
    XCTAssertNotNil(asset.originalFileWriter)
    let destination = root.appendingPathComponent("photo.dng")
    try await AssetDragFiles.shared.writeOriginal(asset, to: destination)
    XCTAssertEqual(try Data(contentsOf: destination), fixture.original)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    XCTAssertEqual(try Data(contentsOf: sidecar), edits)
    // The inline rename entry point supplies an ID-only reference.
    let ref = ImageRef(id: try XCTUnwrap(asset.stableID), displayName: asset.displayName)
    let path = try await fixture.source.renameAsset(ref, to: "renamed.dng")
    let renamed = try asset.renamedSMB(to: "renamed.dng", at: path, source: fixture.source)
    let renamedDestination = root.appendingPathComponent(AssetDragFiles.fileName(for: renamed))
    try await AssetDragFiles.shared.writeOriginal(renamed, to: renamedDestination)
    XCTAssertEqual(renamedDestination.lastPathComponent, "renamed.dng")
    XCTAssertEqual(try Data(contentsOf: renamedDestination), fixture.original)
    XCTAssertEqual(
      try Data(contentsOf: fixture.share.appendingPathComponent("renamed.dng")), fixture.original)
    XCTAssertEqual(try Data(contentsOf: fixture.share.appendingPathComponent("renamed.xmp")), edits)
    await fixture.close()
  }

  private func remoteAsset(name: String, bytes: Data) -> AssetRef {
    AssetRef(
      displayName: name, hintExtension: (name as NSString).pathExtension,
      originalFileWriter: { try bytes.write(to: $0) },
      bytesProvider: { throw ImageSourceError.notFound("must not buffer original") })
  }

  func testRemoteFilenameStaysInsideDropDestination() {
    let asset = AssetRef(displayName: "../../photo", hintExtension: "dng") { Data() }
    XCTAssertEqual(AssetDragFiles.fileName(for: asset), "photo.dng")
  }

  func testLocalAndRemotePromisesCoordinateWithDestinationPresenter() async throws {
    let source = root.appendingPathComponent("source.dng")
    let destination = root.appendingPathComponent("presented.dng")
    let original = Data([1, 2, 3])
    let existing = Data([4, 5, 6])
    try original.write(to: source)
    try existing.write(to: destination)
    for asset in [AssetRef(url: source), remoteAsset(name: "remote.dng", bytes: original)] {
      let relinquished = expectation(description: "Destination presenter relinquishes to writer")
      let presenter = DragDestinationPresenter(url: destination, relinquished: relinquished)
      NSFileCoordinator.addFilePresenter(presenter)
      defer { NSFileCoordinator.removeFilePresenter(presenter) }
      do {
        try await AssetDragFiles.shared.writeOriginal(asset, to: destination)
        XCTFail("Coordinating must still refuse an occupied destination")
      } catch {}
      await fulfillment(of: [relinquished], timeout: 2)
      XCTAssertEqual(try Data(contentsOf: destination), existing)
    }
    XCTAssertEqual(try Data(contentsOf: source), original)
  }
}

private final class DragDestinationPresenter: NSObject, NSFilePresenter {
  let presentedItemURL: URL?
  let presentedItemOperationQueue = OperationQueue()
  let relinquished: XCTestExpectation

  init(url: URL, relinquished: XCTestExpectation) {
    presentedItemURL = url
    self.relinquished = relinquished
    super.init()
    presentedItemOperationQueue.maxConcurrentOperationCount = 1
  }

  func relinquishPresentedItem(toWriter writer: @escaping ((() -> Void)?) -> Void) {
    relinquished.fulfill()
    writer(nil)
  }
}
