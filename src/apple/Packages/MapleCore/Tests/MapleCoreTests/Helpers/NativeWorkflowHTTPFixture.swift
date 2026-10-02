import Foundation
import XCTest

@testable import MapleCore

#if os(macOS)
  import Darwin

  /// Owned real API process; no URLProtocol or sidecar transport replacements.
  final class NativeWorkflowHTTPFixture {
    struct Source: Decodable {
      let key: String
      let path: String
      let id: String
      let input: String?
    }
    let url: URL
    private let process: Process
    private let directory: URL
    private let log: FileHandle
    private let exited: DispatchSemaphore
    private let http = NativeWorkflowHTTPFixture.realNetworkSession()

    private static func realNetworkSession() -> URLSession {
      let configuration = URLSessionConfiguration.ephemeral
      // Auth tests register URLProtocol globally. This fixture always uses
      // actual sockets, both alone and in the full selected regression gate.
      configuration.protocolClasses = []
      return URLSession(configuration: configuration)
    }

    private init(
      url: URL, process: Process, directory: URL, log: FileHandle, exited: DispatchSemaphore
    ) {
      self.url = url
      self.process = process
      self.directory = directory
      self.log = log
      self.exited = exited
    }

    static func start() async throws -> NativeWorkflowHTTPFixture {
      let api = try apiDirectory()
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "native-workflow-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let receipt = directory.appendingPathComponent("ready.json")
      let logURL = directory.appendingPathComponent("server.log")
      _ = FileManager.default.createFile(atPath: logURL.path, contents: Data())
      let log = try FileHandle(forWritingTo: logURL)
      let process = Process()
      let exited = DispatchSemaphore(value: 0)
      process.terminationHandler = { _ in exited.signal() }
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["bun", "tests/browser/workflow-server.ts", receipt.path]
      process.currentDirectoryURL = api
      process.standardOutput = log
      process.standardError = log
      // CI stages its source-built host archive outside the checkout. Use
      // that same current shared library for the real API FFI worker.
      if let target = ProcessInfo.processInfo.environment["CARGO_TARGET_DIR"] {
        var environment = ProcessInfo.processInfo.environment
        environment["MAPLE_NATIVE_LIB"] = target + "/release/libraw_ffi.dylib"
        environment["MAPLE_NAPI"] = "0"
        process.environment = environment
      }
      do {
        try process.run()
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while process.isRunning && ContinuousClock.now < deadline {
          if let data = try? Data(contentsOf: receipt),
            let fields = try? JSONDecoder().decode([String: String].self, from: data),
            let value = fields["url"], let url = URL(string: value)
          {
            return NativeWorkflowHTTPFixture(
              url: url, process: process, directory: directory, log: log, exited: exited)
          }
          try await Task.sleep(for: .milliseconds(25))
        }
        throw NSError(
          domain: "NativeWorkflowFixture", code: 1,
          userInfo: [
            NSLocalizedDescriptionKey: (try? String(contentsOf: logURL, encoding: .utf8))
              ?? "API fixture failed to start"
          ])
      } catch {
        stop(process, exited: exited)
        try? log.close()
        try? FileManager.default.removeItem(at: directory)
        throw error
      }
    }

    func stop() {
      Self.stop(process, exited: exited)
      http.invalidateAndCancel()
      try? log.close()
      try? FileManager.default.removeItem(at: directory)
    }

    private static func stop(_ process: Process, exited: DispatchSemaphore) {
      if process.isRunning { process.terminate() }
      if exited.wait(timeout: .now() + 5) == .timedOut {
        XCTFail("native workflow API fixture did not exit")
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      }
    }

    private static func apiDirectory() throws -> URL {
      if let path = ProcessInfo.processInfo.environment["MAPLE_FILEPROVIDER_TEST_API_ROOT"] {
        return URL(fileURLWithPath: path)
      }
      var candidate = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      while candidate.path != "/" {
        let api = candidate.appending(path: "src/api")
        if FileManager.default.fileExists(
          atPath: api.appending(path: "tests/browser/workflow-server.ts").path)
        {
          return api
        }
        candidate.deleteLastPathComponent()
      }
      throw CocoaError(.fileNoSuchFile)
    }

    func control(_ path: String, body: [String: Any]? = nil) async throws -> Data {
      var request = URLRequest(url: url.appending(path: path))
      if let body {
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
      }
      let (data, response) = try await http.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw NSError(
          domain: "NativeWorkflowFixture", code: 2,
          userInfo: [NSLocalizedDescriptionKey: String(decoding: data, as: UTF8.self)])
      }
      return data
    }

    func stage(xml: String?, workflow: SidecarWorkflow? = nil, future: Bool = false) async throws
      -> Source
    {
      var body: [String: Any] = [
        "xml": xml as Any? ?? NSNull(), "synthetic": true, "futureSchema": future,
      ]
      if let workflow {
        body["workflow"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(workflow))
      }
      return try JSONDecoder().decode(
        Source.self, from: await control("/workflow-fixture", body: body))
    }

    func store(_ source: Source, catalog: Bool = false) -> CloudSidecarStore {
      let client = AuthenticatedHTTPClient(
        server: url, urlSession: Self.realNetworkSession(),
        tokensProvider: { AuthTokens(access: "workflow-token", refresh: "workflow-refresh") },
        onTokensRefreshed: { _ in }, onSignOut: {})
      return CloudSidecarStore(
        server: url, assetID: catalog ? source.id : "fs:\(source.path)", httpClient: client)
    }
  }
#endif
