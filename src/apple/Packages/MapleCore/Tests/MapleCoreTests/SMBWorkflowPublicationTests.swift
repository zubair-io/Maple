import Foundation
import XCTest

@testable import MapleCore

final class SMBWorkflowPublicationTests: XCTestCase {
  func testConcurrentHandleAdoptionReadCloseAndPublicationPreservesOriginalAndXmp() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
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
      await fixture.close(error: error)
      throw error
    }
  }

  func testSemanticConflictFailsWithoutNetworkBackoff() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
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
      await fixture.close(error: error)
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
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self, initialXML: nil)
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

  func testSMBReplacePreservesOccupantWhenCopyFailsAndRefusesDirectoryAndInvalidBasename()
    async throws
  {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("<new-xmp/>", at: "/Source/IMG_1.xmp")
    await t.seed("existing", at: "/Album/IMG_1.dng")
    await t.seed("<existing-xmp/>", at: "/Album/IMG_1.xmp")
    await t.setFailCopyToPath("/Album/IMG_1.dng")

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .replace, transport: t)
      XCTFail("expected the injected failure to propagate")
    } catch {}

    let occupantAfterFailedCopy = await t.fileContents(at: "/Album/IMG_1.dng")
    let occupantSidecarAfterFailedCopy = await t.fileContents(at: "/Album/IMG_1.xmp")
    let sourceAfterFailedCopy = await t.fileContents(at: "/Source/IMG_1.dng")
    XCTAssertEqual(occupantAfterFailedCopy, "existing")
    XCTAssertEqual(occupantSidecarAfterFailedCopy, "<existing-xmp/>")
    XCTAssertEqual(sourceAfterFailedCopy, "new")

    await t.seed("keep-me", at: "/DirTarget/IMG_1.dng/nested.dng")
    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/DirTarget", mode: .move, collision: .replace, transport: t)
      XCTFail("expected invalidDestination when replacing a directory")
    } catch FileOperationError.invalidDestination {}

    let nestedContents = await t.fileContents(at: "/DirTarget/IMG_1.dng/nested.dng")
    XCTAssertEqual(nestedContents, "keep-me")

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Album", newBasename: "../escaped.dng", mode: .move, transport: t)
      XCTFail("expected invalidName for traversal basename")
    } catch FileOperationError.invalidName {}

    await t.setFailCopyToPath("/Album/IMG_1.xmp")
    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .replace, transport: t)
      XCTFail("expected sidecar copy failure to propagate")
    } catch {}
    let occupantAfterSidecarFail = await t.fileContents(at: "/Album/IMG_1.dng")
    let sidecarAfterSidecarFail = await t.fileContents(at: "/Album/IMG_1.xmp")
    XCTAssertEqual(occupantAfterSidecarFail, "existing")
    XCTAssertEqual(sidecarAfterSidecarFail, "<existing-xmp/>")

    await t.setFailCopyToPath(nil)
    do {
      try await SMBFileOperations.copyVerified(
        from: "/Source/IMG_1.dng", to: "/Album/IMG_1.dng", transport: t)
      XCTFail("expected destinationExists when allowReplace is false")
    } catch FileOperationError.destinationExists {}

    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .replace, transport: t)
    let trashTouched = await t.directoryExists(at: "/.maple/trash")
    XCTAssertFalse(trashTouched)

    let longStem = String(repeating: "A", count: 251)
    let longDng = "\(longStem).dng"
    let longXmp = "\(longStem).xmp"
    await t.seed("long-new", at: "/Source/\(longDng)")
    await t.seed("<long-new/>", at: "/Source/\(longXmp)")
    await t.seed("long-old", at: "/Album/\(longDng)")
    await t.seed("<long-old/>", at: "/Album/\(longXmp)")
    _ = try await SMBFileOperations.relocate(
      "/Source/\(longDng)", to: "/Album", mode: .move, collision: .replace, transport: t)
    let longResult = await t.fileContents(at: "/Album/\(longDng)")
    let longSidecarResult = await t.fileContents(at: "/Album/\(longXmp)")
    XCTAssertEqual(longResult, "long-new")
    XCTAssertEqual(longSidecarResult, "<long-new/>")
  }
}
