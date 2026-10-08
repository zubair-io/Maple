import Foundation
import XCTest

@testable import MapleCore

final class SMBCopyOnlyRestoreControlTests: XCTestCase {
  /// The witnessed #4173 custody failure: a local/NFS actor moves the trashed
  /// pair aside and puts unrelated files at the same names at the moment the
  /// former restore deleted the originals. Copy-only restore never touches them.
  func testAuthenticatedSMBBackingReplacementAtRestoreMarkSurvivesCopyOnlyRestore() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let foreign = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: foreign.directory) }
    do {
      let original = try RestorePhysicalRAW.data()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let foreignXML = Data("<foreign>unrelated replacement</foreign>".utf8)
      let ref = try await fixture.image()
      let trash = try await fixture.source.trashAsset(ref)
      let connected = await fixture.source.client
      let client = try XCTUnwrap(connected)
      let share = fixture.share
      let foreignPath = foreign.raw
      let transport = RestoreRealSMBTransport(
        client: client,
        markMutation: { path in
          let photo = share.appendingPathComponent(String(path.dropFirst()))
          for (selected, replacement) in [
            (photo, try Data(contentsOf: foreignPath)),
            (SidecarPath.sidecarURL(for: photo), foreignXML),
          ] {
            try FileManager.default.moveItem(
              at: selected, to: selected.appendingPathExtension("aside"))
            try replacement.write(to: selected, options: .withoutOverwriting)
          }
        })
      let outcome = try await SMBFileOperations.restoreFromMapleTrash(
        trash.primaryPath, transport: transport)
      XCTAssertEqual(outcome.primaryPath, "/photo.dng")
      XCTAssertEqual(try Data(contentsOf: fixture.raw), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw)), xml)
      let trashed = share.appendingPathComponent(String(trash.primaryPath.dropFirst()))
      XCTAssertEqual(try Data(contentsOf: trashed), foreign.original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: trashed)), foreignXML)
      XCTAssertEqual(try Data(contentsOf: trashed.appendingPathExtension("aside")), original)
      XCTAssertEqual(
        try Data(contentsOf: SidecarPath.sidecarURL(for: trashed).appendingPathExtension("aside")),
        xml)
      let touched = await transport.trashedSourcesTouched
      XCTAssertEqual(touched, [])
      let listed = await SMBFileOperations.listMapleTrash(transport: transport)
      XCTAssertFalse(listed.contains { $0.primaryPath == trash.primaryPath })
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }
}
