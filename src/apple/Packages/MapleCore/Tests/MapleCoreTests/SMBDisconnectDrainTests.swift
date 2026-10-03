import Foundation
import XCTest

@testable import AMSMB2
@testable import MapleCore

@MainActor
final class SMBDisconnectDrainTests: EditorTestCase {
  func testDisconnectedStreamFailsAndAHealthyReconnectStillReadsOriginal() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let connected = await fixture.source.client
    let client = try XCTUnwrap(connected)
    await fixture.source.disconnect()
    let finished = DispatchGroup()
    finished.enter()
    let read = Task.detached {
      defer { finished.leave() }
      do {
        for try await _ in client.contents(atPath: "photo.dng") {}
        return Optional<Error>.none
      } catch { return Optional<Error>.some(error) }
    }
    let completed = await Task.detached { finished.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(
      completed, .success, "Disconnected stream did not finish with a recoverable error")
    guard completed == .success else { return }
    let result = await read.value
    let error = try XCTUnwrap(result) as NSError
    XCTAssertEqual(error.domain, NSPOSIXErrorDomain)
    XCTAssertEqual(error.code, Int(ENOTCONN))
    try await fixture.source.connect(credentials: fixture.credentials)
    let ref = try await fixture.image()
    let bytes = try await fixture.source.rawBytes(for: ref)
    XCTAssertEqual(bytes, fixture.original)
    await fixture.close()
  }

  func testFailedAuthenticationAndMissingShareRemainErrorsBeforeHealthyReconnect() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let source = SMBSource()
    let valid = fixture.credentials
    for invalid in [
      SMBSource.Credentials(
        host: valid.host, share: valid.share, username: valid.username,
        password: "wrong-fixture-password"),
      SMBSource.Credentials(
        host: valid.host, share: "MISSING_FIXTURE_SHARE", username: valid.username,
        password: valid.password),
    ] {
      do {
        try await source.connect(credentials: invalid)
        XCTFail("A failed SMB authentication/share reply was reported as success")
      } catch {
        XCTAssertFalse(error.localizedDescription.isEmpty)
      }
      let client = await source.client
      XCTAssertNil(client)
    }
    try await source.connect(credentials: valid)
    let refs = try await source.images()
    let ref = try XCTUnwrap(refs.first)
    let bytes = try await source.rawBytes(for: ref)
    XCTAssertEqual(bytes, fixture.original)
    await source.disconnect()
    await fixture.close()
  }

  func testQueuedSDKReconnectDoesNotJoinTheFileOperationDrain() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let connected = await fixture.source.client
    let client = try XCTUnwrap(connected)
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let draining = DispatchSemaphore(value: 0)
    client.disconnectDrainObserver = { draining.signal() }
    let publication = Task.detached {
      try await client.publishSidecar(atPath: "photo.xmp") { original in
        entered.signal()
        guard release.wait(timeout: .now() + 15) == .success else {
          throw WorkflowSidecarError(message: "Reconnect publication fixture was not released")
        }
        return try XCTUnwrap(original)
      }
    }
    let began = await Task.detached { entered.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(began, .success)
    guard began == .success else {
      release.signal()
      return
    }
    let completed = DispatchGroup()
    completed.enter()
    let disconnect = Task {
      defer { completed.leave() }
      try await client.disconnectShare(gracefully: true)
    }
    let waiting = await Task.detached { draining.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(waiting, .success)
    guard waiting == .success else {
      release.signal()
      return
    }
    let result = AsyncStream<Error?>.makeStream(bufferingPolicy: .bufferingNewest(1))
    completed.enter()
    client.connectShare(
      name: fixture.credentials.share,
      completionHandler: { error in
        result.continuation.yield(error)
        result.continuation.finish()
        completed.leave()
      })
    // connectShare queues synchronously; only the held publication may count as file ownership.
    XCTAssertEqual(client.activeOperationCountForTesting, 1)
    release.signal()
    _ = try await publication.value
    let joined = await Task.detached { completed.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(joined, .success, "SDK reconnect and graceful drain wait on each other's locks")
    guard joined == .success else {
      // The failing control intentionally leaves SDK threads deadlocked. Detach only
      // the test source so its teardown can stop its owned server without freeing live C state.
      await fixture.source.detachClientAfterUnsafeTransportControl()
      await fixture.close()
      return
    }
    try await disconnect.value
    var iterator = result.stream.makeAsyncIterator()
    let reconnectError = await iterator.next()
    XCTAssertNil(reconnectError ?? nil)
    let ref = try await fixture.image()
    let bytes = try await fixture.source.rawBytes(for: ref)
    XCTAssertEqual(bytes, fixture.original)
    await fixture.close()
  }

  func testOldSourceDisconnectCannotEraseANewConnectionAndIdentityCache() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let connected = await fixture.source.client
    let client = try XCTUnwrap(connected)
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let draining = DispatchSemaphore(value: 0)
    client.disconnectDrainObserver = { draining.signal() }
    let publication = Task.detached {
      try await client.publishSidecar(atPath: "photo.xmp") { original in
        entered.signal()
        guard release.wait(timeout: .now() + 15) == .success else {
          throw WorkflowSidecarError(message: "Source reconnect publication was not released")
        }
        return try XCTUnwrap(original)
      }
    }
    let began = await Task.detached { entered.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(began, .success)
    guard began == .success else {
      release.signal()
      return
    }
    let disconnect = Task { await fixture.source.disconnect() }
    let waiting = await Task.detached { draining.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(waiting, .success)
    guard waiting == .success else {
      release.signal()
      return
    }
    try await fixture.source.connect(credentials: fixture.credentials)
    let newClient = await fixture.source.client
    XCTAssertNotNil(newClient)
    XCTAssertFalse(newClient === client)
    let ref = try await fixture.image()
    release.signal()
    _ = try await publication.value
    await disconnect.value
    let retained = await fixture.source.client
    XCTAssertTrue(retained === newClient, "Old disconnect erased a newer source connection")
    guard retained != nil else {
      try? await newClient?.disconnectShare(gracefully: true)
      await fixture.close()
      return
    }
    let bytes = try await fixture.source.rawBytes(for: ref)
    XCTAssertEqual(bytes, fixture.original)
    let sidecar = try await fixture.source.readWorkflowSidecar(
      for: ref, variantId: WorkflowContract.primaryVariantID)
    XCTAssertNotNil(sidecar)
    await fixture.close()
  }

  func testOperationsAfterFinalDrainCheckCannotAcquireRetiringHandles() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let connected = await fixture.source.client
    let client = try XCTUnwrap(connected)
    let before = try Data(contentsOf: fixture.share.appendingPathComponent("photo.xmp"))
    let drained = DispatchSemaphore(value: 0)
    let teardown = DispatchSemaphore(value: 0)
    let entered = DispatchSemaphore(value: 0)
    let releasePublication = DispatchSemaphore(value: 0)
    let finished = DispatchGroup()
    client.disconnectBeforeTeardownObserver = {
      drained.signal()
      _ = teardown.wait(timeout: .now() + 20)
    }
    let disconnect = Task { await fixture.source.disconnect() }
    let reached = await Task.detached { drained.wait(timeout: .now() + 5) }.value
    XCTAssertEqual(reached, .success)
    guard reached == .success else {
      teardown.signal()
      return
    }
    finished.enter()
    let publication = Task.detached {
      defer { finished.leave() }
      do {
        let value = try await client.publishSidecar(atPath: "photo.xmp") { _ in
          entered.signal()
          guard releasePublication.wait(timeout: .now() + 15) == .success else {
            throw WorkflowSidecarError(message: "Late publication fixture was not released")
          }
          return Data(NativeWorkflowControlFixture.input(tag: "late-admission").utf8)
        }
        return Result<Data, Error>.success(value)
      } catch { return Result<Data, Error>.failure(error) }
    }
    let admission = await Task.detached {
      let deadline = Date().addingTimeInterval(5)
      while Date() < deadline {
        if entered.wait(timeout: .now() + 0.01) == .success { return 1 }
        if finished.wait(timeout: .now()) == .success { return 0 }
      }
      return 2
    }.value
    XCTAssertNotEqual(
      admission, 2, "Late publication never reached an ownership or completion boundary")
    let ownsHandles = admission == 1
    XCTAssertFalse(ownsHandles, "New publication acquired handles after the final drain check")
    print("publication-owned-handles-after-final-drain-check: \(ownsHandles)")
    // Safely complete an unsafe control before allowing context teardown.
    releasePublication.signal()
    let result = await publication.value
    teardown.signal()
    await disconnect.value
    if case .success = result { XCTFail("A retiring connection accepted a new publication") }
    XCTAssertEqual(try Data(contentsOf: fixture.share.appendingPathComponent("photo.xmp")), before)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    try await fixture.source.connect(credentials: fixture.credentials)
    _ = try await fixture.image()
    await fixture.close()
  }

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

// Failure-only cleanup of deliberately deadlocked SDK controls; never used by production.
extension SMBSource {
  fileprivate func detachClientAfterUnsafeTransportControl() { client = nil }
}
