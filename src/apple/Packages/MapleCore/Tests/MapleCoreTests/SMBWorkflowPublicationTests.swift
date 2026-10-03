import Foundation
import XCTest

@testable import MapleCore

final class SMBWorkflowPublicationTests: XCTestCase {
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
