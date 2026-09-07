// ExportPanelVMTests.swift — regression coverage for the editor's Export
// panel view-model (#3403: the iPhone Export button did nothing — the
// share affordance was wired to a no-op and the iOS export discarded its
// bytes. #3450: the render and encode ran on the main actor, freezing the
// phone editor for the length of a full-quality bake). Both seams are
// injected so the staging contract runs without a RAW on disk.

import CoreImage
import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

/// Lets a test hold the encoder inside the panel's encode step and inspect
/// where it ran. `enterAndWait` is called from whatever thread the VM put
/// the encode on — if that were the main thread, `awaitEntry` below could
/// never resume, so these tests hang rather than pass on a regression.
private final class EncodeGate: @unchecked Sendable {
  private let entered = DispatchSemaphore(value: 0)
  private let released = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var _calls = 0
  private var _ranOnMainThread: Bool?

  /// Whether the FIRST encode ran on the main thread. `nil` until it runs.
  var ranOnMainThread: Bool? {
    lock.lock()
    defer { lock.unlock() }
    return _ranOnMainThread
  }

  /// Call from inside the injected encoder: records the thread, wakes
  /// `awaitEntry`, and blocks until `release()`. Only the first call parks;
  /// later attempts run straight through. Returns this call's 1-based
  /// index so a test can tell the attempts apart.
  @discardableResult
  func enterAndWait() -> Int {
    lock.lock()
    _calls += 1
    let index = _calls
    if index == 1 { _ranOnMainThread = Thread.isMainThread }
    lock.unlock()
    guard index == 1 else { return index }
    entered.signal()
    released.wait()
    return index
  }

  /// Suspends the caller (the test, on the main actor) until the encoder
  /// has been entered — never blocks the main thread.
  func awaitEntry() async {
    await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        self.entered.wait()
        continuation.resume()
      }
    }
  }

  func release() { released.signal() }
}

/// The encoder seam is `@Sendable`, so a captured `var` is not allowed —
/// this is the one-value inbox the options assertion reads back through.
private final class OptionsBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: ExportOptions?
  var value: ExportOptions? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return stored
    }
    set {
      lock.lock()
      stored = newValue
      lock.unlock()
    }
  }
}

@MainActor
final class ExportPanelVMTests: XCTestCase {

  private var directory: URL!

  /// A 4×4 solid graph — the export path never inspects the pixels, it only
  /// hands them to the encoder seam.
  private let stubImage = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("ExportPanelVMTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  // MARK: - Staging contract

  func testStageForSharingWritesTheEncodedFileAndPublishesIt() async throws {
    let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00])
    let received = OptionsBox()
    let image = stubImage
    let vm = ExportPanelVM(
      render: { _ in image },
      encode: { _, options in
        received.value = options
        return bytes
      })
    vm.format = .heicP3
    vm.quality = 0.8
    let session = EditSession.preview(displayName: "DSC_0100.dng")

    await vm.stageForSharing(session: session, in: directory)

    XCTAssertNil(vm.exportError)
    XCTAssertFalse(vm.isExporting)
    let url = try XCTUnwrap(vm.stagedFile?.url)
    XCTAssertEqual(url.lastPathComponent, "\(session.asset.displayName).heic")
    XCTAssertEqual(
      url.deletingLastPathComponent().standardizedFileURL, directory.standardizedFileURL)
    XCTAssertEqual(try Data(contentsOf: url), bytes)
    XCTAssertEqual(received.value?.format, .heicP3)
    XCTAssertEqual(received.value?.quality, 0.8)
    XCTAssertNil(received.value?.maxSidePixels, "share exports are full resolution")
  }

  func testStageForSharingSurfacesEncoderFailureWithoutAFile() async throws {
    struct Boom: LocalizedError {
      var errorDescription: String? { "render exploded" }
    }
    let image = stubImage
    let vm = ExportPanelVM(render: { _ in image }, encode: { _, _ in throw Boom() })

    await vm.stageForSharing(session: EditSession.preview(), in: directory)

    XCTAssertNil(vm.stagedFile)
    XCTAssertEqual(vm.exportError, "render exploded")
    XCTAssertFalse(vm.isExporting)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
  }

  func testBeginClearsAPriorErrorBeforeRetrying() async {
    struct Boom: Error {}
    let image = stubImage
    let vm = ExportPanelVM(render: { _ in image }, encode: { _, _ in throw Boom() })
    await vm.stageForSharing(session: EditSession.preview(), in: directory)
    XCTAssertNotNil(vm.exportError)

    await vm.begin {}.value

    XCTAssertNil(vm.exportError)
    XCTAssertFalse(vm.isExporting)
  }

  // MARK: - #3450: off the main actor, and stale results dropped

  /// The regression this file exists for. The encoder parks inside the
  /// encode step; the test — itself on the main actor — must still make
  /// progress and observe the panel's busy state while it is parked. If the
  /// encode were main-actor-bound this test would hang rather than fail,
  /// which is exactly what the phone UI did.
  func testEncodeRunsOffTheMainActorSoThePanelStaysResponsive() async throws {
    let gate = EncodeGate()
    let image = stubImage
    let vm = ExportPanelVM(
      render: { _ in image },
      encode: { _, _ in
        gate.enterAndWait()
        return Data([0x01])
      })

    let task = vm.beginStagingForSharing(session: EditSession.preview(), in: directory)
    await gate.awaitEntry()

    // The main actor reached here while the encode is still running.
    XCTAssertEqual(gate.ranOnMainThread, false, "the encode must not run on the main thread")
    XCTAssertTrue(vm.isExporting, "the panel reports the bake in progress")
    XCTAssertNil(vm.stagedFile)

    gate.release()
    await task.value

    XCTAssertFalse(vm.isExporting)
    XCTAssertEqual(try Data(contentsOf: try XCTUnwrap(vm.stagedFile?.url)), Data([0x01]))
  }

  func testCancelDiscardsAnEncodeThatFinishesAfterwards() async throws {
    let gate = EncodeGate()
    let image = stubImage
    let vm = ExportPanelVM(
      render: { _ in image },
      encode: { _, _ in
        gate.enterAndWait()
        return Data([0x01])
      })

    let task = vm.beginStagingForSharing(session: EditSession.preview(), in: directory)
    await gate.awaitEntry()
    vm.cancelExport()

    // Cancel clears the busy state immediately — the panel does not wait
    // out a bake that has no interruption point once it has started.
    XCTAssertFalse(vm.isExporting)

    gate.release()
    await task.value

    XCTAssertNil(vm.stagedFile, "a cancelled attempt must not publish its file")
    XCTAssertNil(vm.exportError, "cancelling is not an error the user should see")
    XCTAssertFalse(vm.isExporting)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path), [],
      "a cancelled attempt must not leave a staged file behind")
  }

  func testASecondExportSupersedesTheFirstsLateResult() async throws {
    let gate = EncodeGate()
    let image = stubImage
    let vm = ExportPanelVM(
      render: { _ in image },
      encode: { _, _ in
        gate.enterAndWait() == 1 ? Data([0x01]) : Data([0x02])
      })
    let session = EditSession.preview()

    let first = vm.beginStagingForSharing(session: session, in: directory)
    await gate.awaitEntry()
    let second = vm.beginStagingForSharing(session: session, in: directory)
    await second.value

    // The second attempt has published; now let the first one finish.
    XCTAssertEqual(try Data(contentsOf: try XCTUnwrap(vm.stagedFile?.url)), Data([0x02]))
    gate.release()
    await first.value

    XCTAssertEqual(
      try Data(contentsOf: try XCTUnwrap(vm.stagedFile?.url)), Data([0x02]),
      "the superseded attempt must not overwrite the newer one")
    XCTAssertNil(vm.exportError)
    XCTAssertFalse(vm.isExporting)
  }

  /// Jules review of PR #3455: the blocking encode must not sit on Swift's
  /// cooperative pool either. That pool is sized to the core count, so
  /// parking more encodes than it has threads would leave nothing to run
  /// unrelated async work on — the same starvation this PR fixed on the
  /// main actor, one layer down. `Task.detached` would fail this; the
  /// Dispatch-queue bridge (`BlockingWork.run`) passes.
  func testParkedEncodesDoNotStarveUnrelatedAsyncWork() async throws {
    let count = max(4, ProcessInfo.processInfo.activeProcessorCount * 2)
    let gates = (0..<count).map { _ in EncodeGate() }
    let image = stubImage
    // Held in a local: `beginStagingForSharing` captures the view-model
    // weakly (the panel owns it), so an inline `ExportPanelVM(...)` would
    // deallocate before its own task ran.
    let vms = gates.map { gate in
      ExportPanelVM(
        render: { _ in image },
        encode: { _, _ in
          gate.enterAndWait()
          return Data([0x01])
        })
    }
    let tasks = vms.enumerated().map { index, vm in
      vm.beginStagingForSharing(
        session: EditSession.preview(displayName: "IMG_\(index).dng"), in: directory)
    }
    for gate in gates { await gate.awaitEntry() }

    // Every encode is parked. A detached task runs on the cooperative pool,
    // so it can only complete if none of them took a thread from it.
    let unrelated = Task.detached { 42 }
    let value = await unrelated.value
    XCTAssertEqual(value, 42, "unrelated async work must still be schedulable")

    gates.forEach { $0.release() }
    for task in tasks { await task.value }
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, count)
    XCTAssertTrue(vms.allSatisfy { !$0.isExporting })
  }

  /// Jules review of PR #3455: a Cancel landing in the window between the
  /// write and the publish left the rendered file on disk with nothing
  /// holding a reference to it — up to a gigabyte for a 16-bit TIFF.
  func testCancelBetweenTheWriteAndThePublishRemovesTheOrphanedFile() async throws {
    let gate = EncodeGate()
    let image = stubImage
    let vm = ExportPanelVM(
      render: { _ in image },
      encode: { _, _ in Data([0x01]) },
      write: { data, url in
        try data.write(to: url, options: .atomic)
        gate.enterAndWait()
      })

    let task = vm.beginStagingForSharing(session: EditSession.preview(), in: directory)
    await gate.awaitEntry()
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1,
      "the bytes are on disk before the publish guard runs")

    vm.cancelExport()
    gate.release()
    await task.value

    XCTAssertNil(vm.stagedFile)
    XCTAssertNil(vm.exportError)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path), [],
      "a cancelled attempt must not leave its rendered file behind")
  }

  // MARK: - Formats

  func testOutputFileNameAndQualityControlFollowTheFormat() {
    let vm = ExportPanelVM()
    let asset = AssetRef.preview(displayName: "IMG_0042.dng")
    XCTAssertEqual(vm.outputFileName(for: asset), "\(asset.displayName).jpg")
    XCTAssertTrue(vm.showsQualityControl)

    vm.format = .tiff16
    XCTAssertEqual(vm.outputFileName(for: asset), "\(asset.displayName).tiff")
    XCTAssertFalse(vm.showsQualityControl)

    vm.format = .png
    XCTAssertFalse(vm.showsQualityControl)
  }
}
