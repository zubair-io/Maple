// FolderThumbnailThroughputTests.swift — wall time to list a folder and produce a
// decoded grid thumbnail for every photo in it, through the same BrowseViewModel,
// ThumbnailLoader and ThumbnailDecoder calls the grid cells make. Opt-in: set
// MAPLE_PERF_LOCAL_FOLDER for a local folder, MAPLE_PERF_CLOUD_LIBRARY (+
// MAPLE_PERF_CLOUD_FOLDER, a subfolder name) for the LAN route against the
// production folder and thumb routes (src/api/tests/fixtures/folder-thumb-throughput-server.ts).
// MAPLE_PERF_PASS=cold first removes this process's cached thumbnails for the folder.

import Foundation
import MapleCloudKit
import XCTest

@testable import MapleCore

#if os(macOS)

  @MainActor
  final class FolderThumbnailThroughputTests: XCTestCase {

    private var environment: [String: String] { ProcessInfo.processInfo.environment }
    private var isColdPass: Bool { environment["MAPLE_PERF_PASS"] == "cold" }

    func testLocalFolderIsFullyThumbnailed() async throws {
      guard let path = environment["MAPLE_PERF_LOCAL_FOLDER"] else {
        throw XCTSkip("MAPLE_PERF_LOCAL_FOLDER not set")
      }
      let folder = URL(fileURLWithPath: path, isDirectory: true)
      if isColdPass {
        try? FileManager.default.removeItem(
          at: folder.appendingPathComponent(".maple/thumbs", isDirectory: true))
      }
      let started = ContinuousClock.now
      await ThumbnailDiskCache.shared.configure(folderURL: folder)
      let browse = BrowseViewModel()
      await browse.loadFolder(url: folder)
      let listed = ContinuousClock.now
      let decoded = await Self.thumbnailAll(browse.assets, source: nil)
      report(
        route: "local", count: browse.assets.count, decoded: decoded,
        listing: listed - started, total: ContinuousClock.now - started)
    }

    func testCloudFolderIsFullyThumbnailedOverLAN() async throws {
      guard let library = environment["MAPLE_PERF_CLOUD_LIBRARY"],
        let folderName = environment["MAPLE_PERF_CLOUD_FOLDER"]
      else { throw XCTSkip("MAPLE_PERF_CLOUD_LIBRARY / MAPLE_PERF_CLOUD_FOLDER not set") }
      let server = try await ThroughputServer.start(library: library)
      defer { server.stop() }
      let folderPath = (library as NSString).appendingPathComponent(folderName)
      let configuration = URLSessionConfiguration.default
      configuration.httpMaximumConnectionsPerHost = ThumbnailLoader.maxConcurrentSourceFetches
      if isColdPass { URLCache.shared.removeAllCachedResponses() }
      let http = AuthenticatedHTTPClient(
        server: server.url, urlSession: URLSession(configuration: configuration),
        tokensProvider: { AuthTokens(access: "throughput-token", refresh: "refresh") },
        onTokensRefreshed: { _ in }, onSignOut: {})
      let source = CloudSource(
        server: server.url, folderID: server.libraryID, libraryPath: library, httpClient: http)

      let started = ContinuousClock.now
      let browse = BrowseViewModel()
      await browse.loadCloudDir(source, absPath: folderPath)
      let listed = ContinuousClock.now
      if isColdPass {
        for asset in browse.assets { Self.removeSourcelessThumb(forKey: asset.stableID) }
      }
      let thumbsStarted = ContinuousClock.now
      let decoded = await Self.thumbnailAll(browse.assets, source: source)
      let finished = ContinuousClock.now
      report(
        route: "cloud-lan", count: browse.assets.count, decoded: decoded,
        listing: listed - started, total: (listed - started) + (finished - thumbsStarted))
    }

    private static func thumbnailAll(_ assets: [AssetRef], source: (any ImageSource)?) async -> Int {
      await withTaskGroup(of: Bool.self) { group in
        for asset in assets {
          group.addTask {
            // A grid cell shows the camera seed of a cold RAW before its thumbnail.
            _ = await ThumbnailLoader.shared.loadCameraPreview(for: asset)
            let data = await ThumbnailLoader.shared.load(for: asset, from: source)
            return await ThumbnailDecoder.image(for: data, key: asset.id.description) != nil
          }
        }
        return await group.reduce(0) { $1 ? $0 + 1 : $0 }
      }
    }

    private static func removeSourcelessThumb(forKey key: String?) {
      guard let key else { return }
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      let file = caches.appendingPathComponent("app.justmaple.aperture/sourceless-thumbs")
        .appendingPathComponent(
          MapleThumbCacheKey.thumbFilename(forKey: MapleThumbCacheKey.sha256Prefix16(key)))
      try? FileManager.default.removeItem(at: file)
    }

    private func report(route: String, count: Int, decoded: Int, listing: Duration, total: Duration) {
      let pass = environment["MAPLE_PERF_PASS"] ?? "warm"
      print(
        "THROUGHPUT route=\(route) pass=\(pass) photos=\(count) decoded=\(decoded) "
          + "listing_ms=\(Self.milliseconds(listing)) total_ms=\(Self.milliseconds(total))")
      XCTAssertEqual(decoded, count)
    }

    private static func milliseconds(_ duration: Duration) -> Int {
      Int(duration / .milliseconds(1))
    }
  }

  private final class ThroughputServer {
    let url: URL
    let libraryID: String
    private let process: Process
    private let exited = DispatchSemaphore(value: 0)

    private init(url: URL, libraryID: String, process: Process) {
      self.url = url
      self.libraryID = libraryID
      self.process = process
    }

    static func start(library: String) async throws -> ThroughputServer {
      let receipt = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-throughput-\(UUID().uuidString).json")
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = [
        "bun", "tests/fixtures/folder-thumb-throughput-server.ts", library, receipt.path,
      ]
      process.currentDirectoryURL = try apiDirectory()
      process.standardOutput = FileHandle.nullDevice
      try process.run()
      let deadline = ContinuousClock.now.advanced(by: .seconds(20))
      while process.isRunning && ContinuousClock.now < deadline {
        if let data = try? Data(contentsOf: receipt),
          let fields = try? JSONDecoder().decode([String: String].self, from: data),
          let address = fields["url"], let url = URL(string: address),
          let libraryID = fields["libraryId"]
        {
          try? FileManager.default.removeItem(at: receipt)
          let server = ThroughputServer(url: url, libraryID: libraryID, process: process)
          process.terminationHandler = { [exited = server.exited] _ in exited.signal() }
          return server
        }
        try await Task.sleep(for: .milliseconds(25))
      }
      if process.isRunning { process.terminate() }
      throw CocoaError(.fileReadUnknown)
    }

    func stop() {
      guard process.isRunning else { return }
      process.terminate()
      _ = exited.wait(timeout: .now() + 5)
    }

    private static func apiDirectory() throws -> URL {
      var candidate = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      while candidate.path != "/" {
        let api = candidate.appendingPathComponent("src/api")
        if FileManager.default.fileExists(
          atPath: api.appendingPathComponent("tests/fixtures/folder-thumb-throughput-server.ts")
            .path)
        {
          return api
        }
        candidate.deleteLastPathComponent()
      }
      throw CocoaError(.fileNoSuchFile)
    }
  }

#endif
