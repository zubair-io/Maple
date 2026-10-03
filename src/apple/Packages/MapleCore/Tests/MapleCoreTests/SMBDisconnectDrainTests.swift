import Foundation
import XCTest

@testable import AMSMB2
@testable import MapleCore

@MainActor
final class SMBDisconnectDrainTests: EditorTestCase {
  func testOwnedDiagnosticsRetainFailuresAndIgnoreAnotherTestCase() async throws {
    let successful = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let diagnostics = OwnedSMBDiagnostics(testCase: self)
    diagnostics.testCase(
      XCTestCase(), didFailWithDescription: "Unrelated test failure", inFile: #filePath,
      atLine: #line)
    XCTAssertFalse(diagnostics.preserve(successful.directory))
    await successful.close()
    XCTAssertFalse(FileManager.default.fileExists(atPath: successful.directory.path))

    let failed = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let root =
      ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"].map {
        URL(fileURLWithPath: $0, isDirectory: true)
      } ?? FileManager.default.temporaryDirectory
    let retained = root.appendingPathComponent("smb-diagnostics")
      .appendingPathComponent(failed.directory.lastPathComponent)
    defer { try? FileManager.default.removeItem(at: retained) }
    await failed.close(error: WorkflowSidecarError(message: "Synthetic owned failure"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: failed.directory.path))
    let failures = try String(
      contentsOf: retained.appendingPathComponent("failures.txt"), encoding: .utf8)
    XCTAssertTrue(failures.contains("Synthetic owned failure"))
    let trace = try Data(contentsOf: retained.appendingPathComponent("server.log"))
    XCTAssertFalse(trace.isEmpty)
  }

  func testDisconnectWaitsForOwnedSidecarPublicationToReleaseItsFileHandles() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let connected = await fixture.source.client
    let client = try XCTUnwrap(connected)
    let entered = DispatchSemaphore(value: 0)
    let resume = DispatchSemaphore(value: 0)
    let stopped = DispatchGroup()
    let draining = DispatchSemaphore(value: 0)
    client.disconnectDrainObserver = { draining.signal() }
    let document = Data(NativeWorkflowControlFixture.input(tag: "publication").utf8)
    let publication = Task.detached {
      try await client.publishSidecar(atPath: "photo.xmp") { _ in
        entered.signal()
        guard resume.wait(timeout: .now() + 15) == .success else {
          throw WorkflowSidecarError(message: "Owned publication fixture was not released.")
        }
        return document
      }
    }
    let began = await Task.detached { entered.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(began, .success)
    guard began == .success else {
      resume.signal()
      return
    }
    stopped.enter()
    let disconnection = Task {
      await fixture.source.disconnect()
      stopped.leave()
    }
    // Fence the actual condition wait with an owned SDK operation outstanding.
    // A non-graceful control instead completes disconnect and fails safely.
    let reachedBoundary = await Task.detached {
      let deadline = Date().addingTimeInterval(5)
      while Date() < deadline {
        if stopped.wait(timeout: .now()) == .success { return true }
        if draining.wait(timeout: .now() + 0.01) == .success { return true }
      }
      return false
    }.value
    XCTAssertTrue(reachedBoundary, "Disconnect never reached its connection drain boundary")
    guard reachedBoundary else {
      resume.signal()
      return
    }
    let early = stopped.wait(timeout: .now()) == .success
    XCTAssertFalse(early, "Disconnect freed file handles while publication still owns them")
    print("owned-publication-disconnect-completed-before-release: \(early)")
    // An unsafe-source control has already freed the publisher's C handle.
    // Do not resume it into use-after-free after the assertion proves the defect.
    guard !early else { return }
    resume.signal()
    let saved = try await publication.value
    await disconnection.value
    XCTAssertEqual(saved, document)
    XCTAssertEqual(
      try Data(contentsOf: fixture.share.appendingPathComponent("photo.xmp")), document)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    try await fixture.source.connect(credentials: fixture.credentials)
    let xml = try await fixture.source.readWorkflowSidecar(
      for: try await fixture.image(), variantId: WorkflowContract.primaryVariantID)
    XCTAssertEqual(xml, String(decoding: document, as: UTF8.self))
    await fixture.close()
    XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.directory.path))
  }
}
