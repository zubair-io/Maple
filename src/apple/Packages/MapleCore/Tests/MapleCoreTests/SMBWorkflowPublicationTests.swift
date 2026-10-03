import Foundation
import XCTest

@testable import MapleCore

final class SMBWorkflowPublicationTests: XCTestCase {
  func testConcurrentHandleAdoptionReadCloseAndPublicationPreservesOriginalAndXmp() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open()
    do {
      let ref = try await fixture.image()
      let store = SMBSidecarStore(source: fixture.source, ref: ref)
      let loaded = try await store.load()
      let original = fixture.original
      let source = fixture.source
      let completed = try await withThrowingTaskGroup(of: Int.self) { group in
        for _ in 0..<2 {
          group.addTask {
            for _ in 0..<100 {
              let bytes = try await source.rawBytes(for: ref)
              XCTAssertEqual(bytes, original)
            }
            return 100
          }
        }
        group.addTask {
          for cycle in 0..<100 {
            var model = loaded.0
            model.exposure = cycle.isMultiple(of: 2) ? -0.75 : 0.75
            try await store.writeConfirmed(model: model, culling: loaded.1)
            let xml = try await store.readWorkflowXML()
            let confirmed = try XCTUnwrap(xml)
            XCTAssertEqual(try XMPParser.parse(confirmed).0.exposure, model.exposure)
            XCTAssertEqual(XMPParser.parseMetadata(confirmed).caption, "Caption A")
            XCTAssertTrue(confirmed.contains("<foreign:Audit"))
          }
          return 100
        }
        var count = 0
        for try await operations in group { count += operations }
        return count
      }
      XCTAssertEqual(completed, 300)
      let final = try await store.load()
      XCTAssertEqual(final.0.exposure, 0.75)
      XCTAssertEqual(final.1, loaded.1)
      XCTAssertEqual(try Data(contentsOf: fixture.raw), original)
      await fixture.close()
    } catch {
      await fixture.close()
      throw error
    }
  }

  func testSemanticConflictFailsWithoutNetworkBackoff() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open()
    let ref = try await fixture.image()
    let store = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await store.load()
    var model = loaded.0
    model.exposure = 1
    try await store.commitSemantic(
      model: model, culling: loaded.1, action: "adjustment", label: "First")
    let staleXML = try await store.readWorkflowXML()
    let stale = try XCTUnwrap(staleXML)
    model.exposure = 2
    try await store.commitSemantic(
      model: model, culling: loaded.1, action: "adjustment", label: "Second")
    let expected = try await store.readWorkflowXML()
    let start = ContinuousClock.now
    do {
      try await fixture.source.writeSidecar(
        Data(stale.utf8), for: SMBSource.SMBAsset(path: "/photo.dng"))
      XCTFail("A conflicting workflow must require refresh")
    } catch let error as WorkflowSidecarError {
      XCTAssertTrue(error.localizedDescription.contains("Refresh"))
    } catch {
      await fixture.close()
      throw error
    }
    // The old network retry loop slept one + two seconds for this conflict.
    XCTAssertLessThan(start.duration(to: .now), .seconds(2))
    let actual = try await store.readWorkflowXML()
    XCTAssertEqual(actual, expected)
    let original = try await fixture.source.rawBytes(for: ref)
    XCTAssertEqual(original, fixture.original)
    await fixture.close()
  }

  func testConnectedClientPublicationCapabilities() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(initialXML: nil)
    let source = fixture.source
    let connected = await source.client
    let client = try XCTUnwrap(connected)
    let name = UUID().uuidString
    let asset = SMBSource.SMBAsset(path: "/\(name).dng")
    let first = Data(NativeWorkflowControlFixture.input().utf8)
    let changed = Data(NativeWorkflowControlFixture.input(exposure: 1.5).utf8)
    let path = "/\(name).xmp"
    let created = try await client.publishSidecar(atPath: path) { current in
      XCTAssertNil(current)
      return first
    }
    XCTAssertEqual(created, first)
    let saved = try await client.publishSidecar(atPath: path) { current in
      XCTAssertEqual(current, first)
      return changed
    }
    XCTAssertEqual(saved, changed)
    let retained = try await source.readSidecar(for: asset)
    XCTAssertEqual(retained, changed)
    let competing = SMBSource()
    try await competing.connect(credentials: fixture.credentials)
    let secondConnection = await competing.client
    let secondClient = try XCTUnwrap(secondConnection)
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let owned = Task.detached {
      try await client.publishSidecar(atPath: path) { current in
        entered.signal()
        guard release.wait(timeout: .now() + 10) == .success else { throw POSIXError(.ETIMEDOUT) }
        return try XCTUnwrap(current)
      }
    }
    XCTAssertEqual(entered.wait(timeout: .now() + 10), .success)
    do {
      _ = try await secondClient.publishSidecar(atPath: path) { _ in first }
      XCTFail("Server must reject another owner's publication")
    } catch let error as POSIXError {
      XCTAssertEqual(error.code, .ETXTBSY)
    }
    release.signal()
    _ = try await owned.value
    let afterRelease = try await secondClient.publishSidecar(atPath: path) { _ in first }
    XCTAssertEqual(afterRelease, first)
    await competing.disconnect()
    await fixture.close()
  }
}
