import CoreImage
import Foundation
import XCTest

@testable import MapleCore

extension DisplayPreviewPersistTests {
  @MainActor
  func testReplacedIdleCaptureStillJoinsAlreadyEncodingWrite() async throws {
    let directory = try previewTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("preview.avif")
    let encoder = HeldPreviewEncoder()
    defer { encoder.release.signal() }
    let owner = DisplayPreviewPersistence(
      sink: LocalDisplayPreviewSink(previewURL: url), encode: { encoder.encode($0) })
    owner.schedule(previewImage(width: 8))
    let idle = Task { await owner.persistPending() }
    await fulfillment(of: [encoder.entered], timeout: 5)
    owner.schedule(previewImage(width: 16))
    let joining = expectation(description: "join entered")
    var joined = false
    let drain = Task {
      joining.fulfill()
      await owner.cancelAndJoin()
      joined = true
    }
    await fulfillment(of: [joining], timeout: 5)
    XCTAssertFalse(joined, "Replacing the timer must not lose the old encode's handle")
    encoder.release.signal()
    await idle.value
    await drain.value
    XCTAssertTrue(joined)
    XCTAssertEqual(try previewWidth(url), 8)
    XCTAssertTrue(owner.hasPendingImage)
    await owner.persistPending()
    XCTAssertEqual(try previewWidth(url), 16)
  }

  @MainActor
  func testFinalFrameWinsOverIdleEncodeAndNewPendingCapture() async throws {
    let directory = try previewTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("preview.avif")
    let encoder = HeldPreviewEncoder()
    defer { encoder.release.signal() }
    let owner = DisplayPreviewPersistence(
      sink: LocalDisplayPreviewSink(previewURL: url), encode: { encoder.encode($0) })
    owner.schedule(previewImage(width: 8))
    let idle = Task { await owner.persistPending() }
    await fulfillment(of: [encoder.entered], timeout: 5)
    owner.schedule(previewImage(width: 16))
    let exiting = expectation(description: "final persist waiting")
    let exit = Task {
      exiting.fulfill()
      await owner.persistFinal(previewImage(width: 32), while: { true })
    }
    await fulfillment(of: [exiting], timeout: 5)
    encoder.release.signal()
    await idle.value
    await exit.value
    await owner.cancelAndJoin()
    XCTAssertFalse(owner.hasPendingImage)
    XCTAssertEqual(try previewWidth(url), 32, "An older CPU frame cannot overwrite final readback")
  }

  @MainActor
  func testBusyWriteCoalescesIntermediatePendingFrames() async throws {
    let directory = try previewTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("preview.avif")
    let encoder = HeldPreviewEncoder()
    defer { encoder.release.signal() }
    let sink = CountingFilePreviewSink(url: url)
    let owner = DisplayPreviewPersistence(sink: sink, encode: { encoder.encode($0) })
    owner.schedule(previewImage(width: 8))
    let first = Task { await owner.persistPending() }
    await fulfillment(of: [encoder.entered], timeout: 5)
    owner.schedule(previewImage(width: 16))
    let waiting = expectation(description: "intermediate persist waiting")
    let intermediate = Task {
      waiting.fulfill()
      await owner.persistPending()
    }
    await fulfillment(of: [waiting], timeout: 5)
    owner.schedule(previewImage(width: 32))
    encoder.release.signal()
    await first.value
    await intermediate.value
    await owner.cancelAndJoin()
    await owner.persistPending()
    let writes = await sink.count
    XCTAssertEqual(writes, 2, "Only the in-flight frame and newest pending frame should encode")
    XCTAssertEqual(try previewWidth(url), 32)
  }

  @MainActor
  func testCapturedModelGuardIsRecheckedAfterEncoding() async throws {
    let directory = try previewTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("preview.avif")
    let encoder = HeldPreviewEncoder()
    defer { encoder.release.signal() }
    let owner = DisplayPreviewPersistence(
      sink: LocalDisplayPreviewSink(previewURL: url), encode: { encoder.encode($0) })
    var stillCurrent = true
    owner.schedule(previewImage(width: 8))
    let flush = Task { await owner.persistPending(while: { stillCurrent }) }
    await fulfillment(of: [encoder.entered], timeout: 5)
    stillCurrent = false
    encoder.release.signal()
    await flush.value
    await owner.cancelAndJoin()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  @MainActor
  func testSessionRejectsChangedModelAfterJoiningAnOldWrite() async throws {
    let directory = try previewTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("preview.avif")
    let sink = HeldFilePreviewSink(url: url)
    defer { sink.release.signal() }
    let asset = AssetRef(
      displayName: "local.png", hintExtension: "png",
      bytesProvider: { throw CancellationError() })
    let session = EditSession(asset: asset, remotePreviewSink: sink)
    session.gpuLiveDriver = nil
    session.scheduleDisplayPreviewPersist(previewImage(width: 8))
    let oldWrite = Task { await session.flushDisplayPreviewPersist() }
    await fulfillment(of: [sink.entered], timeout: 5)
    session.scheduleDisplayPreviewPersist(previewImage(width: 16))
    let capturedModel = session.model
    let joining = expectation(description: "session join entered")
    let exit = Task {
      joining.fulfill()
      return await session.cancelAndJoinDisplayPreviewPersist(expectedModel: capturedModel)
    }
    await fulfillment(of: [joining], timeout: 5)
    session.model.exposure = 1.25
    sink.release.signal()
    await oldWrite.value
    let accepted = await exit.value
    XCTAssertFalse(accepted)
    XCTAssertTrue(session.previewPersistence.hasPendingImage)
    XCTAssertEqual(try previewWidth(url), 8)
    await session.flushDisplayPreviewPersist()
    XCTAssertEqual(try previewWidth(url), 16)
  }

  @MainActor
  func testRequestedExitRetainsSessionThroughRealSidecarAndPreviewWrites() async throws {
    let directory = try previewTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let rawURL = directory.appendingPathComponent("original.png")
    let original = try SidecarContractIO.makeSyntheticOriginal(at: rawURL)
    var session: EditSession? = EditSession(asset: AssetRef(url: rawURL))
    session?.gpuLiveDriver = nil
    session?.beginEdit(description: "Final exposure")
    session?.model.exposure = 1.25
    session?.scheduleDisplayPreviewPersist(previewImage(width: 16))
    let store = try XCTUnwrap(session?.sidecarStore as? XMPSidecarStore)
    let entered = expectation(description: "real sidecar actor occupied")
    let release = DispatchSemaphore(value: 0)
    defer { release.signal() }
    let blocked = Task.detached { await store.holdPreviewExit(entered: entered, release: release) }
    await fulfillment(of: [entered], timeout: 5)
    weak var weakSession = session
    var exit: Task<Void, Never>? = Task { [captured = session!] in
      await captured.persistDisplayPreviewOnExit()
    }
    session = nil
    XCTAssertNotNil(weakSession, "Requested exit must own the session until persistence completes")
    release.signal()
    await blocked.value
    await exit?.value
    exit = nil
    XCTAssertEqual(try previewWidth(MapleSidecarPaths.previewURL(for: rawURL)), 16)
    let parsed = try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: rawURL)))
    XCTAssertEqual(parsed.0.exposure, 1.25)
    XCTAssertEqual(try Data(contentsOf: rawURL), original)
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while weakSession != nil, ContinuousClock.now < deadline { await Task.yield() }
    XCTAssertNil(weakSession, "Completed persistence must release its session")
  }
}

private func previewImage(width: Int) -> CIImage {
  CIImage(color: .green).cropped(to: CGRect(x: 0, y: 0, width: width, height: 8))
}

private func previewTestDirectory() throws -> URL {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  return directory
}

private func previewWidth(_ url: URL) throws -> Int {
  let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
  return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil)).width
}

/// A bounded barrier around the real AVIF encoder, never a sidecar replacement.
private final class HeldPreviewEncoder: @unchecked Sendable {
  let entered = XCTestExpectation(description: "encoding in progress")
  let release = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var first = true

  func encode(_ image: CIImage) -> Data? {
    lock.lock()
    let hold = first
    first = false
    lock.unlock()
    if hold {
      entered.fulfill()
      XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
    }
    return ThumbnailLoader.encodeDisplayPreview(from: image)
  }
}

private actor CountingFilePreviewSink: DisplayPreviewSink {
  private let sink: LocalDisplayPreviewSink
  private(set) var count = 0
  init(url: URL) { sink = LocalDisplayPreviewSink(previewURL: url) }
  func write(_ bytes: Data) async {
    count += 1
    await sink.write(bytes)
  }
}

private actor HeldFilePreviewSink: DisplayPreviewSink {
  nonisolated let entered = XCTestExpectation(description: "sink write in progress")
  private let sink: LocalDisplayPreviewSink
  nonisolated let release = DispatchSemaphore(value: 0)
  private var first = true

  init(url: URL) { sink = LocalDisplayPreviewSink(previewURL: url) }
  func write(_ bytes: Data) async {
    if first {
      first = false
      entered.fulfill()
      XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
    }
    await sink.write(bytes)
  }
}

extension XMPSidecarStore {
  fileprivate func holdPreviewExit(entered: XCTestExpectation, release: DispatchSemaphore) {
    entered.fulfill()
    XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
  }
}
