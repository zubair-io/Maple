#if os(macOS)
  import Foundation
  import XCTest
  @testable import MapleCore

  /// Live Bun sockets, persisted SQLite and the File Provider's production client (#3770).
  final class ChangeFeedClientRestartTests: XCTestCase {
    private actor Observation {
      var stale: [Int64] = []
      func recordStale(_ cursor: Int64) { stale.append(cursor) }
      func staleCursors() -> [Int64] { stale }
    }

    func testRestartWithRetainedJournalResumesNativeClient() async throws {
      try await verifyRestart(retention: "retained")
    }

    func testRestartAfterJournalPruningResumesNativeClient() async throws {
      try await verifyRestart(retention: "pruned")
    }

    private func verifyRestart(retention: String) async throws {
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-fp-restart-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let api = try apiDirectory()
      let database = directory.appendingPathComponent("catalog.sqlite")
      // First process commits three events (and optionally prunes them). Stop it
      // completely; the second process must recover its watermark from disk.
      let first = try await Server.start(api: api, database: database, retention: retention)
      first.stop()
      let restarted = try await Server.start(api: api, database: database, retention: retention)
      defer { restarted.stop() }

      let stale = expectation(description: "Native client requests working-set reconciliation")
      let received = expectation(description: "Native client receives the post-restart event")
      let observation = Observation()
      let cursorStore = ChangeCursorStore(directory: directory.appendingPathComponent("cursors"))
      let domain = "restart-verification"
      cursorStore.save(1, domain: domain)
      let http = AuthenticatedHTTPClient(
        server: restarted.url, urlSession: .shared,
        tokensProvider: { AuthTokens(access: "fixture-access", refresh: "fixture-refresh") },
        onTokensRefreshed: { _ in }, onSignOut: {})
      let client = ChangeFeedClient(
        server: restarted.url, http: http, cursorStore: cursorStore, domainID: domain,
        onEvent: { event in
          XCTAssertEqual(event.cursor, 4)
          XCTAssertEqual(event.absPath, "/photos/new.dng")
          received.fulfill()
        },
        onStaleCursor: { cursor in
          await observation.recordStale(cursor)
          stale.fulfill()
        })
      client.start()
      defer { client.stop() }
      await fulfillment(of: [stale], timeout: 12)
      let staleCursors = await observation.staleCursors()
      XCTAssertEqual(staleCursors, [3], "An empty process ring must not reset the client to zero")
      guard staleCursors == [3] else { return }
      XCTAssertEqual(cursorStore.load(domain: domain), 3)

      var append = URLRequest(url: restarted.url.appendingPathComponent("test/append"))
      append.httpMethod = "POST"
      let (data, response) = try await URLSession.shared.data(for: append)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      XCTAssertEqual(result?["cursor"] as? Int, 4)
      await fulfillment(of: [received], timeout: 12)
      // onEvent finishes before the client saves, so wait for the actual durable ack.
      let deadline = Date().addingTimeInterval(2)
      while cursorStore.load(domain: domain) != 4 && Date() < deadline {
        try await Task.sleep(for: .milliseconds(20))
      }
      XCTAssertEqual(cursorStore.load(domain: domain), 4)
      let (requestsData, _) = try await URLSession.shared.data(
        from: restarted.url.appendingPathComponent("test/requests"))
      let since = try JSONDecoder().decode([Int64].self, from: requestsData)
      XCTAssertEqual(since, [1, 3], "Reconnect must use the persisted allocator watermark")
      let finalStaleCursors = await observation.staleCursors()
      XCTAssertEqual(finalStaleCursors, [3])
    }

    private func apiDirectory() throws -> URL {
      if let path = ProcessInfo.processInfo.environment["MAPLE_FILEPROVIDER_TEST_API_ROOT"] {
        return URL(fileURLWithPath: path)
      }
      var candidate = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      while candidate.path != "/" {
        let api = candidate.appendingPathComponent("src/api")
        if FileManager.default.fileExists(
          atPath: api.appendingPathComponent("tests/fixtures/file-provider-restart.ts").path)
        {
          return api
        }
        candidate.deleteLastPathComponent()
      }
      throw CocoaError(.fileNoSuchFile)
    }

    private final class Server {
      let process: Process
      let url: URL
      private let log: FileHandle
      private init(process: Process, url: URL, log: FileHandle) {
        self.process = process
        self.url = url
        self.log = log
      }
      static func start(api: URL, database: URL, retention: String) async throws -> Server {
        let receipt = database.deletingLastPathComponent().appendingPathComponent(
          "ready-\(UUID().uuidString).json")
        let logURL = receipt.appendingPathExtension("log")
        _ = FileManager.default.createFile(atPath: logURL.path, contents: Data())
        let log = try FileHandle(forWritingTo: logURL)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
          "bun", "tests/fixtures/file-provider-restart.ts", database.path, receipt.path, retention,
        ]
        process.currentDirectoryURL = api
        process.standardOutput = log
        process.standardError = log
        try process.run()
        do {
          let deadline = Date().addingTimeInterval(12)
          while process.isRunning && Date() < deadline {
            if let data = try? Data(contentsOf: receipt),
              let object = try? JSONDecoder().decode([String: String].self, from: data),
              let address = object["url"], let url = URL(string: address)
            {
              return Server(process: process, url: url, log: log)
            }
            try await Task.sleep(for: .milliseconds(25))
          }
          let output = (try? String(contentsOf: logURL, encoding: .utf8)) ?? "No server log"
          throw NSError(
            domain: "FileProviderRestart", code: 1, userInfo: [NSLocalizedDescriptionKey: output])
        } catch {
          if process.isRunning {
            process.terminate()
            process.waitUntilExit()
          }
          try? log.close()
          throw error
        }
      }
      func stop() {
        if process.isRunning {
          process.terminate()
          process.waitUntilExit()
        }
        try? log.close()
      }
    }
  }
#endif
