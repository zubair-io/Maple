import CoreImage
import MapleAgentWire
import XCTest

@testable import MapleCore

extension AgentBrowseTests {
  func testColdURLlessBrowseReadsActualActorSidecarsWithoutHydration() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-url-less-culling")
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let original = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: fixture, to: original)
    let originalBytes = try Data(contentsOf: original)
    var persisted = CullingState()
    persisted.stars = 5
    persisted.flag = .pick
    let xml = XMPSerializer.serialize(model: .default, culling: persisted)
    let sidecar = SidecarPath.sidecarURL(for: original)
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let reads = AgentBrowseOriginalReadCounter()
    let assets = (0..<2).map { index in
      AssetRef(displayName: "remote-\(index).png", hintExtension: "png") {
        await reads.record()
        throw CocoaError(.fileReadNoPermission)
      }
    }
    let browse = BrowseViewModel()
    browse.assets = assets
    var sessions: [AssetRef.ID: EditSession] = [:]
    let delegate = AppShellBrowseAdapter(
      browseVM: browse, getSessions: { sessions },
      ensureSessionHandler: { asset in
        let session = EditSession(
          asset: asset, remoteSidecarStore: XMPSidecarStore(rawURL: original))
        sessions[asset.id] = session
        return session
      })
    let result = try await AgentBrowseService.listPhotos(
      [:], delegate: delegate, activeSession: nil)
    let photos = try XCTUnwrap(result["photos"]?.arrayValue)
    XCTAssertEqual(photos.count, 2)
    for photo in photos {
      XCTAssertEqual(photo["rating"], 5)
      XCTAssertEqual(photo["flag"], "pick")
    }
    XCTAssertEqual(sessions.count, 2)
    for session in sessions.values {
      XCTAssertFalse(session.hasLoadedSidecar)
      XCTAssertNil(session.renderedPreview)
      XCTAssertNil(session.sidecarUpdateTask)
      XCTAssertEqual(session.culling, CullingState())
    }
    let count = await reads.count
    XCTAssertEqual(count, 0)
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xml)
  }

  func testThumbnailRasterizationAllowsMainActorProgress() async throws {
    let fixture = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-browse-raster")
    defer { try? FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: fixture, to: original)
    let originalBytes = try Data(contentsOf: original)
    let asset = AssetRef(url: original)
    let session = EditSession(asset: asset)
    session.previewSize = CGSize(width: 256, height: 256)
    await session.openAssetPipelineAsync()
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    let actual = try XCTUnwrap(session.renderedPreview)
    await session.renderActor.cancelAll()
    let provider = AgentBrowseRasterProvider(image: actual, context: session.pipeline.context)
    session.renderedPreview = CIImage(
      imageProvider: provider, size: provider.width, provider.height,
      format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB), options: nil)
    let browse = BrowseViewModel()
    browse.assets = [asset]
    let delegate = AppShellBrowseAdapter(browseVM: browse, getSessions: { [asset.id: session] })
    let payload = try await AgentBrowseService.getThumbnails(
      ["asset_ids": [.string(asset.id.uuidString)]], delegate: delegate, activeSession: session)
    XCTAssertTrue(provider.didRasterize)
    XCTAssertTrue(provider.mainActorProgressed, "The real rasterizer must not block MainActor")
    XCTAssertEqual(payload.images.count, 1)
    XCTAssertEqual(payload.images.first?.data.prefix(2), Data([0xFF, 0xD8]))
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
    await session.flushPendingSidecarWrite()
  }
}

/// Supplies bytes captured from the authentic settled PNG render. The first
/// raster callback fences real work until a MainActor task acknowledges it.
/// The timeout only bounds a deadlocked old-source control; it is not an FPS gate.
private final class AgentBrowseRasterProvider: NSObject, @unchecked Sendable {
  private let lock = NSLock()
  private var firstDraw = true
  private var progress = false
  private var drawn = false
  private let pixels: [UInt8]
  let width: Int
  let height: Int

  var didRasterize: Bool { lock.withLock { drawn } }
  var mainActorProgressed: Bool { lock.withLock { progress } }

  init(image: CIImage, context: CIContext) {
    width = Int(image.extent.width)
    height = Int(image.extent.height)
    var captured = [UInt8](repeating: 0, count: width * height * 4)
    context.render(
      image, toBitmap: &captured, rowBytes: width * 4, bounds: image.extent,
      format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
    pixels = captured
    super.init()
  }

  override func provideImageData(
    _ data: UnsafeMutableRawPointer, bytesPerRow: Int, origin x: Int, _ y: Int,
    size width: Int, _ height: Int, userInfo: Any?
  ) {
    let first = lock.withLock {
      drawn = true
      let first = firstDraw
      firstDraw = false
      return first
    }
    if first {
      let released = DispatchSemaphore(value: 0)
      Task { @MainActor in released.signal() }
      let progressed = released.wait(timeout: .now() + 10) == .success
      lock.withLock { progress = progressed }
    }
    data.initializeMemory(as: UInt8.self, repeating: 0, count: bytesPerRow * height)
    pixels.withUnsafeBytes { source in
      guard let base = source.baseAddress else { return }
      for row in 0..<height {
        let sourceY = y + row
        guard sourceY >= 0, sourceY < self.height else { continue }
        let startX = max(0, x)
        let endX = min(self.width, x + width)
        guard endX > startX else { continue }
        data.advanced(by: row * bytesPerRow + (startX - x) * 4).copyMemory(
          from: base.advanced(by: (sourceY * self.width + startX) * 4),
          byteCount: (endX - startX) * 4)
      }
    }
  }
}

private actor AgentBrowseOriginalReadCounter {
  private(set) var count = 0
  func record() { count += 1 }
}
