import Foundation
import XCTest

@testable import MapleCore

/// Relay actual signed SMB packets, dropping one accepted publication's reply.
final class OwnedSMBPublicationProxy {
  private let directory: URL
  private let process = Process()
  private var termination: Task<Void, Never>?
  private let output: FileHandle
  private(set) var credentials: SMBSource.Credentials

  private init(_ fixture: OwnedSMBWorkflowFixture) throws {
    directory = fixture.directory.appendingPathComponent("relay")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    credentials = fixture.credentials
    let script = try XCTUnwrap(
      Bundle.module.url(forResource: "publication_proxy", withExtension: "py"))
    let server = try XCTUnwrap(URL(string: "smb://" + credentials.host)?.port)
    let log = directory.appendingPathComponent("proxy.log")
    _ = FileManager.default.createFile(atPath: log.path, contents: nil)
    output = try FileHandle(forWritingTo: log)
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [
      "python3", script.path, "--target-port", String(server), "--directory", directory.path,
    ]
    process.standardOutput = output
    process.standardError = output
  }
  static func open(_ fixture: OwnedSMBWorkflowFixture) async throws -> OwnedSMBPublicationProxy {
    let proxy = try OwnedSMBPublicationProxy(fixture)
    let exit = AsyncStream<Void>.makeStream()
    proxy.process.terminationHandler = { _ in exit.continuation.finish() }
    proxy.termination = Task { for await _ in exit.stream {} }
    do { try proxy.process.run() } catch {
      exit.continuation.finish()
      throw error
    }
    let receipt = proxy.directory.appendingPathComponent("proxy.json")
    let deadline = Date().addingTimeInterval(10)
    while !FileManager.default.fileExists(atPath: receipt.path) {
      guard proxy.process.isRunning, Date() < deadline else {
        throw WorkflowSidecarError(message: "The owned SMB acknowledgement relay did not start.")
      }
      try await Task.sleep(for: .milliseconds(50))
    }
    let data = try Data(contentsOf: receipt)
    let values = try JSONDecoder().decode([String: Int].self, from: data)
    let port = try XCTUnwrap(values["port"])
    let original = proxy.credentials
    proxy.credentials = .init(
      host: "127.0.0.1:\(port)", share: original.share,
      username: original.username, password: original.password)
    return proxy
  }
  func arm() throws {
    try Data().write(to: directory.appendingPathComponent("drop-next-rename"))
  }
  var droppedAcknowledgement: Bool {
    FileManager.default.fileExists(atPath: directory.appendingPathComponent("dropped-rename").path)
  }
  func close() async {
    if process.isRunning { process.terminate() }
    await termination?.value
    try? output.close()
  }
  deinit {
    if process.isRunning {
      process.terminate()
    }
    try? output.close()
  }
}
