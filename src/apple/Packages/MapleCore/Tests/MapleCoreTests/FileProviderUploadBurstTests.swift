// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderUploadBurstTests.swift
import FileProvider
import XCTest

@testable import MapleFileProviderCore

/// #5456: iOS kills the File Provider extension at 20 MB, and a Files-app
/// drop of ~1,000 photos and videos used to start one upload per
/// `createItem` at once. These tests drive real `createItem` bursts over
/// real temp files and assert the transfers stay bounded, queued items
/// hold no request, and only a `.mayAlreadyExist` redelivery reuses the
/// stored file instead of uploading.
final class FileProviderUploadBurstTests: XCTestCase {
  override func setUp() {
    super.setUp()
    GatedUploadURLProtocol.reset()
  }

  override func tearDown() {
    GatedUploadURLProtocol.reset()
    super.tearDown()
  }

  private let roots = [LibraryRoot(id: "folder-1", path: "/lib", label: "Lib", fileCount: 0)]
  private let parent = NSFileProviderItemIdentifier(
    FileProviderIdentifier.folder(folderID: "folder-1", relativePath: "").rawValue)

  private func makeCore() -> FileProviderExtensionCore {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [GatedUploadURLProtocol.self]
    cfg.timeoutIntervalForRequest = 10
    cfg.timeoutIntervalForResource = 10
    let session = URLSession(configuration: cfg)
    let http = AuthenticatedHTTPClient(
      server: FPCoreTestSupport.server,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(
      http: http, server: FPCoreTestSupport.server, downloadURLSession: session,
      etagCacheByteBudget: RemoteCatalog.extensionETagCacheByteBudget)
    return FPCoreTestSupport.makeCore(catalog: catalog, roots: roots, test: self)
  }

  private func makeLocalFile(named name: String, bytes: Int) throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("FPBurst-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent(name)
    try Data(repeating: 0xA5, count: bytes).write(to: url)
    return url
  }

  private func create(
    _ core: FileProviderExtensionCore, filename: String, contents: URL,
    mtime: Date? = nil, options: NSFileProviderCreateItemOptions = [],
    done: @escaping (NSFileProviderItem?, Error?) -> Void
  ) -> Progress {
    let template = FakeFileProviderItem(
      itemIdentifier: NSFileProviderItemIdentifier("pending-\(filename)"),
      parentItemIdentifier: parent,
      filename: filename,
      contentModificationDate: mtime
    )
    return core.createItem(
      basedOn: template, fields: [], contents: contents, options: options,
      request: NSFileProviderRequest(),
      completionHandler: { item, _, _, error in done(item, error) })
  }

  func testBurstOfCreatesNeverExceedsTheUploadBound() throws {
    let burst = 40
    let finished = expectation(description: "every create completed")
    finished.expectedFulfillmentCount = burst
    let lock = NSLock()
    var failures: [Error] = []
    let core = makeCore()
    for index in 0..<burst {
      let name = "IMG_\(index).MP4"
      let file = try makeLocalFile(named: name, bytes: 64 * 1024)
      _ = create(core, filename: name, contents: file) { item, error in
        lock.lock()
        if let error { failures.append(error) }
        if item == nil, error == nil { failures.append(URLError(.unknown)) }
        lock.unlock()
        finished.fulfill()
      }
    }
    wait(for: [finished], timeout: 30)

    XCTAssertTrue(failures.isEmpty, "every upload must succeed: \(failures)")
    XCTAssertEqual(
      GatedUploadURLProtocol.uploadsStarted, burst, "one upload per create, none repeated")
    XCTAssertLessThanOrEqual(
      GatedUploadURLProtocol.peakConcurrentUploads, FileProviderExtensionCore.writeConcurrency,
      "queued creates must not open a request until a permit frees")
    XCTAssertEqual(
      GatedUploadURLProtocol.peakConcurrentUploads, FileProviderExtensionCore.writeConcurrency,
      "the bound should still let uploads run in parallel")
  }

  func testCancelledQueuedCreateNeverUploads() throws {
    GatedUploadURLProtocol.holdUploads = true
    let core = makeCore()
    let holders = (0..<FileProviderExtensionCore.writeConcurrency).map { "HOLD_\($0).MP4" }
    let holdersDone = expectation(description: "held uploads complete")
    holdersDone.expectedFulfillmentCount = holders.count
    for name in holders {
      _ = create(core, filename: name, contents: try makeLocalFile(named: name, bytes: 1024)) {
        _, _ in
        holdersDone.fulfill()
      }
    }
    XCTAssertTrue(GatedUploadURLProtocol.waitForUploads(count: holders.count, timeout: 5))

    let cancelled = expectation(description: "queued create reports cancellation")
    var cancelError: NSError?
    let progress = create(
      core, filename: "QUEUED.MP4", contents: try makeLocalFile(named: "QUEUED.MP4", bytes: 1024)
    ) { _, error in
      cancelError = error as NSError?
      cancelled.fulfill()
    }
    progress.cancel()
    wait(for: [cancelled], timeout: 5)
    GatedUploadURLProtocol.releaseUploads()
    wait(for: [holdersDone], timeout: 10)

    XCTAssertEqual(cancelError?.domain, NSCocoaErrorDomain)
    XCTAssertEqual(cancelError?.code, NSUserCancelledError)
    XCTAssertEqual(
      GatedUploadURLProtocol.uploadsStarted, holders.count,
      "the cancelled create never sent its bytes")
  }

  /// The extension was killed after the server stored the file but before
  /// the OS heard back, so the OS redelivers the same `createItem` without
  /// `.mayAlreadyExist`. Same name, size and modification time is not proof
  /// of the same bytes (the server keeps no content hash), so it uploads
  /// again; the server moves the replaced copy to the Maple trash.
  func testUnflaggedCreateOverSameNameSizeAndTimeStillUploads() throws {
    let mtime = Date(timeIntervalSince1970: 1_790_000_000)
    let name = "DJI_0001.MP4"
    let file = try makeLocalFile(named: name, bytes: 2048)
    GatedUploadURLProtocol.existingFile = (name: name, size: 2048, mtime: mtime)
    let core = makeCore()
    let done = expectation(description: "create completed")
    var failure: Error?
    _ = create(core, filename: name, contents: file, mtime: mtime) { _, error in
      failure = error
      done.fulfill()
    }
    wait(for: [done], timeout: 5)

    XCTAssertNil(failure)
    XCTAssertEqual(GatedUploadURLProtocol.uploadsStarted, 1)
  }

  /// With `.mayAlreadyExist` the OS says the item may already be synced:
  /// a stored file with the same name and size is it, so no upload.
  func testMayAlreadyExistCreateReusesTheStoredFile() throws {
    let mtime = Date(timeIntervalSince1970: 1_790_000_000)
    let name = "DJI_0003.MP4"
    let file = try makeLocalFile(named: name, bytes: 2048)
    GatedUploadURLProtocol.existingFile = (name: name, size: 2048, mtime: mtime)
    let core = makeCore()
    let done = expectation(description: "create completed")
    var result: (NSFileProviderItem?, Error?)
    _ = create(core, filename: name, contents: file, mtime: mtime, options: [.mayAlreadyExist]) {
      item, error in
      result = (item, error)
      done.fulfill()
    }
    wait(for: [done], timeout: 5)

    XCTAssertNil(result.1)
    XCTAssertEqual(result.0?.filename, name)
    XCTAssertEqual(
      result.0?.itemIdentifier.rawValue,
      FileProviderIdentifier.file(folderID: "folder-1", relativePath: name).rawValue)
    XCTAssertEqual(GatedUploadURLProtocol.uploadsStarted, 0)
  }

  /// Same name and size but a different modification time is a different
  /// file the user dropped, so it must upload.
  func testCreateWithDifferentModificationTimeStillUploads() throws {
    let name = "DJI_0002.MP4"
    let file = try makeLocalFile(named: name, bytes: 2048)
    GatedUploadURLProtocol.existingFile = (
      name: name, size: 2048, mtime: Date(timeIntervalSince1970: 1_790_000_000)
    )
    let core = makeCore()
    let done = expectation(description: "create completed")
    var failure: Error?
    _ = create(
      core, filename: name, contents: file, mtime: Date(timeIntervalSince1970: 1_790_000_500)
    ) { _, error in
      failure = error
      done.fulfill()
    }
    wait(for: [done], timeout: 5)

    XCTAssertNil(failure)
    XCTAssertEqual(GatedUploadURLProtocol.uploadsStarted, 1)
  }
}

/// Answers the catalog routes a create touches. Upload responses arrive
/// asynchronously after a short delay (or once released), so several
/// uploads can be in flight together and the peak is observable.
final class GatedUploadURLProtocol: URLProtocol {
  private static let lock = NSLock()
  private static var inFlight = 0
  private static var peak = 0
  private static var started = 0
  private static var held: [GatedUploadURLProtocol] = []
  static var holdUploads = false
  static var existingFile: (name: String, size: Int64, mtime: Date)?

  static var peakConcurrentUploads: Int { lock.withLock { peak } }
  static var uploadsStarted: Int { lock.withLock { started } }

  static func reset() {
    lock.withLock {
      inFlight = 0
      peak = 0
      started = 0
      held = []
    }
    holdUploads = false
    existingFile = nil
  }

  static func waitForUploads(count: Int, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if uploadsStarted >= count { return true }
      Thread.sleep(forTimeInterval: 0.01)
    }
    return false
  }

  static func releaseUploads() {
    let pending = lock.withLock { () -> [GatedUploadURLProtocol] in
      holdUploads = false
      defer { held = [] }
      return held
    }
    for request in pending { request.finishUpload() }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url?.path ?? ""
    if path.hasSuffix("/upload") {
      let hold = Self.lock.withLock { () -> Bool in
        Self.inFlight += 1
        Self.started += 1
        Self.peak = max(Self.peak, Self.inFlight)
        if Self.holdUploads { Self.held.append(self) }
        return Self.holdUploads
      }
      guard !hold else { return }
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { self.finishUpload() }
      return
    }
    if let roots = UnifiedFolderTestResponses.roots(for: request) {
      respond(status: roots.0, body: roots.1)
      return
    }
    if path.hasSuffix("/file-meta") {
      respondFileMeta()
      return
    }
    if path == "/api/folder/photos/lib" {
      respondListing()
      return
    }
    respond(status: 404, body: Data())
  }

  override func stopLoading() {}

  private func finishUpload() {
    Self.lock.withLock { Self.inFlight -= 1 }
    let target = request.value(forHTTPHeaderField: "X-Maple-Target-Path") ?? "upload"
    let body =
      #"{"asset_id":null,"abs_path":"/lib/\#(target)","size":1024,"mtime":"2026-10-26T00:00:00.000Z"}"#
    respond(status: 201, body: Data(body.utf8))
  }

  private func respondFileMeta() {
    let wanted = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
      .queryItems?.first { $0.name == "path" }?.value
    guard let existing = Self.existingFile, existing.name == wanted else {
      respond(status: 404, body: Data())
      return
    }
    respond(status: 200, body: Data(Self.fileJSON(existing).utf8))
  }

  private func respondListing() {
    let files = Self.existingFile.map { "[\(Self.fileJSON($0))]" } ?? "[]"
    let body =
      #"{"path":"/lib","parentPath":null,"folders":[],"images":[],"sidecars":[],"files":\#(files)}"#
    respond(status: 200, body: Data(body.utf8))
  }

  private static func fileJSON(_ file: (name: String, size: Int64, mtime: Date)) -> String {
    let stamp = ISO8601DateFormatter().string(from: file.mtime)
    return
      #"{"name":"\#(file.name)","path":"/lib/\#(file.name)","mtime":"\#(stamp)","size":\#(file.size),"ext":"mp4"}"#
  }

  private func respond(status: Int, body: Data) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }
}
