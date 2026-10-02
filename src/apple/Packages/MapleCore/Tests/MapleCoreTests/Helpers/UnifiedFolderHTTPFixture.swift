import Foundation
import XCTest

#if os(macOS)
  import Darwin

  /// Runs the production enriched folder route over real SQLite and files.
  /// CI's isolated package uses the same API-root override as change-feed tests.
  final class UnifiedFolderHTTPFixture {
    let url: URL
    let library: String
    let album: String
    let assetID: String
    private let process: Process
    private let log: FileHandle
    private let root: URL
    private let exited: DispatchSemaphore

    private init(
      process: Process, log: FileHandle, root: URL, exited: DispatchSemaphore,
      receipt: [String: String]
    ) throws {
      guard let address = receipt["url"], let url = URL(string: address),
        let library = receipt["library"], let album = receipt["album"],
        let assetID = receipt["assetId"]
      else { throw CocoaError(.fileReadCorruptFile) }
      self.url = url
      self.library = library
      self.album = album
      self.assetID = assetID
      self.process = process
      self.log = log
      self.root = root
      self.exited = exited
    }

    static func start() async throws -> UnifiedFolderHTTPFixture {
      let api = try apiDirectory()
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "maple-folder-http-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let receipt = root.appendingPathComponent("ready.json")
      let logURL = root.appendingPathComponent("server.log")
      _ = FileManager.default.createFile(atPath: logURL.path, contents: Data())
      let log = try FileHandle(forWritingTo: logURL)
      let process = Process()
      let exited = DispatchSemaphore(value: 0)
      process.terminationHandler = { _ in exited.signal() }
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = [
        "bun", "tests/fixtures/unified-folder-server.ts", root.path, receipt.path,
      ]
      process.currentDirectoryURL = api
      process.standardOutput = log
      process.standardError = log
      do {
        try process.run()
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while process.isRunning && ContinuousClock.now < deadline {
          if let data = try? Data(contentsOf: receipt),
            let fields = try? JSONDecoder().decode([String: String].self, from: data)
          {
            return try UnifiedFolderHTTPFixture(
              process: process, log: log, root: root, exited: exited, receipt: fields)
          }
          try await Task.sleep(for: .milliseconds(25))
        }
        let output = (try? String(contentsOf: logURL, encoding: .utf8)) ?? "No server log"
        throw NSError(
          domain: "UnifiedFolderFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: output])
      } catch {
        if process.isRunning { stop(process: process, exited: exited) }
        try? log.close()
        try? FileManager.default.removeItem(at: root)
        throw error
      }
    }

    func stop() {
      Self.stop(process: process, exited: exited)
      try? log.close()
      try? FileManager.default.removeItem(at: root)
    }

    private static func stop(process: Process, exited: DispatchSemaphore) {
      if process.isRunning { process.terminate() }
      // Process.waitUntilExit() can miss its run-loop notification when called
      // from a Swift executor after the child has exited. Observe termination
      // from before launch instead, and bound cleanup independently of XCTest.
      if exited.wait(timeout: .now() + 5) == .timedOut {
        XCTFail("folder fixture did not report process termination")
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      }
    }

    private static func apiDirectory() throws -> URL {
      if let path = ProcessInfo.processInfo.environment["MAPLE_FILEPROVIDER_TEST_API_ROOT"] {
        return URL(fileURLWithPath: path)
      }
      var candidate = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      while candidate.path != "/" {
        let api = candidate.appendingPathComponent("src/api")
        if FileManager.default.fileExists(
          atPath: api.appendingPathComponent("tests/fixtures/unified-folder-server.ts").path)
        {
          return api
        }
        candidate.deleteLastPathComponent()
      }
      throw CocoaError(.fileNoSuchFile)
    }
  }

#endif
