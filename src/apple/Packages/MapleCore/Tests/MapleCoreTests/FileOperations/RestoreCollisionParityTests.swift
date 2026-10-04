import CryptoKit
import Foundation
import XCTest

@testable import MapleCore

final class RestoreCollisionParityTests: XCTestCase {
  private func physicalRAW() throws -> Data {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<8 { root.deleteLastPathComponent() }
    return try Data(contentsOf: root.appending(path: "test-fixtures/raws/test_0017.dng"))
  }

  func testLocalRestoreCollisionPreservesPhotoAndForeignXmp() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "restore-4139")
    defer { try? FileManager.default.removeItem(at: root) }
    let photo = root.appendingPathComponent("photo.dng")
    let original = try physicalRAW()
    let xml = NativeWorkflowControlFixture.input()
    try original.write(to: photo)
    try Data(xml.utf8).write(to: SidecarPath.sidecarURL(for: photo))
    let trashed = try await LocalFileOperations.trashToMapleFolder(photo, libraryRoot: root)
    try Data("occupied original".utf8).write(to: photo)
    let occupiedXmp = Data("<foreign>occupied</foreign>".utf8)
    try occupiedXmp.write(to: SidecarPath.sidecarURL(for: photo))
    let outcome = try await LocalFileOperations.restoreFromMapleTrash(
      URL(fileURLWithPath: trashed.primaryPath), libraryRoot: root)
    XCTAssertEqual(
      URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "photo.restored.dng")
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: outcome.primaryPath)), original)
    XCTAssertEqual(
      try Data(contentsOf: SidecarPath.sidecarURL(for: URL(fileURLWithPath: outcome.primaryPath))),
      Data(xml.utf8))
    XCTAssertEqual(try Data(contentsOf: photo), Data("occupied original".utf8))
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: photo)), occupiedXmp)
  }

  func testPhysicalLocalCaseFoldedWorkflowSidecarFollowsRestoreCollision() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "restore-casefold")
    defer { try? FileManager.default.removeItem(at: root) }
    let trash = root.appendingPathComponent(".maple/trash", isDirectory: true)
    try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
    let original = try physicalRAW()
    let xml = Data(NativeWorkflowControlFixture.input().utf8)
    let photo = trash.appendingPathComponent("PHOTO.DNG")
    let sidecar = try RestoreCaseFoldedWorkflowFixture.stage(in: trash, bytes: xml)
    let occupied = root.appendingPathComponent("PHOTO.DNG")
    let occupant = Data("occupied namespace".utf8)
    try original.write(to: photo)
    try occupant.write(to: occupied)
    do {
      let result = try await LocalFileOperations.restoreFromMapleTrash(photo, libraryRoot: root)
      let output = URL(fileURLWithPath: result.primaryPath)
      XCTAssertEqual(output.lastPathComponent, "PHOTO.restored.DNG")
      XCTAssertEqual(try Data(contentsOf: output), original)
      XCTAssertEqual(
        try Data(
          contentsOf: root.appendingPathComponent(RestoreCaseFoldedWorkflowFixture.restoredName)),
        xml)
    } catch {
      XCTAssertEqual(try Data(contentsOf: photo), original)
      XCTAssertEqual(try Data(contentsOf: sidecar), xml)
      throw error
    }
    try RestoreCaseFoldedWorkflowFixture.assertRejectedRetained(in: trash, bytes: xml)
    XCTAssertEqual(try Data(contentsOf: occupied), occupant)
  }

  func testAuthenticatedSMBCaseFoldedWorkflowSidecarFollowsRestoreCollision() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let original = try physicalRAW()
      let xml = Data(NativeWorkflowControlFixture.input().utf8)
      let trash = fixture.share.appendingPathComponent(".maple/trash", isDirectory: true)
      try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
      let photo = trash.appendingPathComponent("PHOTO.DNG")
      let sidecar = try RestoreCaseFoldedWorkflowFixture.stage(in: trash, bytes: xml)
      try original.write(to: photo)
      let occupant = try Data(contentsOf: fixture.raw)
      let connected = await fixture.source.client
      let client = try XCTUnwrap(connected)
      let transport = RestoreRealSMBTransport(client: client) { _, _ in }
      do {
        let result = try await SMBFileOperations.restoreFromMapleTrash(
          "/.maple/trash/PHOTO.DNG", transport: transport)
        XCTAssertEqual((result.primaryPath as NSString).lastPathComponent, "PHOTO.restored.DNG")
        XCTAssertEqual(
          try Data(contentsOf: fixture.share.appendingPathComponent("PHOTO.restored.DNG")), original
        )
        XCTAssertEqual(
          try Data(
            contentsOf: fixture.share.appendingPathComponent(
              RestoreCaseFoldedWorkflowFixture.restoredName)), xml)
      } catch {
        XCTAssertEqual(try Data(contentsOf: photo), original)
        XCTAssertEqual(try Data(contentsOf: sidecar), xml)
        throw error
      }
      try RestoreCaseFoldedWorkflowFixture.assertRejectedRetained(in: trash, bytes: xml)
      XCTAssertEqual(try Data(contentsOf: fixture.raw), occupant)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testPhysicalLocalCleanupReplacementRetainsUnrelatedFile() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "local-cleanup-substitution")
    let foreign = try NativeWorkflowControlFixture.files()
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: foreign.directory)
    }
    let selected = root.appendingPathComponent("photo.dng")
    let original = try physicalRAW()
    let xml = Data(NativeWorkflowControlFixture.input().utf8)
    try original.write(to: selected)
    try xml.write(to: SidecarPath.sidecarURL(for: selected))
    let trash = try await LocalFileOperations.trashToMapleFolder(selected, libraryRoot: root)
    let trashed = URL(fileURLWithPath: trash.primaryPath)
    let foreignPath = foreign.raw
    do {
      _ = try await Task.detached {
        try LocalFileOperations.restoreFilePair(
          trashed, to: root, confinedTo: root, beforeClaim: nil,
          beforeRemoval: { url in
            if url.pathExtension == "dng" {
              try FileManager.default.removeItem(at: url)
              try FileManager.default.copyItem(at: foreignPath, to: url)
            }
          })
      }.value
    } catch {}
    XCTAssertEqual(try Data(contentsOf: selected), original)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: selected)), xml)
    XCTAssertEqual(try Data(contentsOf: trashed), foreign.original)
  }

  func testAuthenticatedSMBCleanupReplacementRetainsUnrelatedFile() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let foreign = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: foreign.directory) }
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let ref = try await fixture.image()
      let trash = try await fixture.source.trashAsset(ref)
      let connected = await fixture.source.client
      let client = try XCTUnwrap(connected)
      let share = fixture.share
      let foreignPath = foreign.raw
      let transport = RestoreRealSMBTransport(
        client: client,
        removalMutation: { path in
          let selected = share.appendingPathComponent(String(path.dropFirst()))
          try FileManager.default.removeItem(at: selected)
          try FileManager.default.copyItem(at: foreignPath, to: selected)
        })
      do {
        _ = try await SMBFileOperations.restoreFromMapleTrash(
          trash.primaryPath, transport: transport)
      } catch {}
      XCTAssertEqual(try Data(contentsOf: fixture.raw), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw)), xml)
      let retained = share.appendingPathComponent(String(trash.primaryPath.dropFirst()))
      XCTAssertEqual(try Data(contentsOf: retained), foreign.original)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testAuthenticatedSMBRestoreVerificationDeliversBoundedPhysicalRAWChunks() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let connected = await fixture.source.client
      let client = try XCTUnwrap(connected)
      let attributes = try await client.attributesOfItem(atPath: "photo.dng")
      let inode = try XCTUnwrap(attributes[.documentIdentifierKey] as? NSNumber).uint64Value
      let probe = RestoreChunkProbe()
      try await client.readRestoreFile(
        atPath: "photo.dng", expectedIdentity: inode, consume: probe.update)
      XCTAssertGreaterThan(probe.calls, 1)
      XCTAssertEqual(probe.count, UInt64(original.count))
      XCTAssertEqual(probe.digest(), SHA256.hash(data: original))
      XCTAssertLessThanOrEqual(probe.maximum, 1024 * 1024)
      do {
        try await client.removeRestoreFile(
          atPath: "photo.dng", expectedIdentity: inode,
          consume: { XCTAssertLessThanOrEqual($0.count, 1024 * 1024) },
          validate: { _ in false })
        XCTFail("Rejected verification removed the physical original")
      } catch let error as POSIXError { XCTAssertEqual(error.code, .ESTALE) }
      XCTAssertEqual(try Data(contentsOf: fixture.raw), original)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testAuthenticatedSMBPhysicalCopyNegotiatesLimitsAndRetainsOriginal() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let connected = await fixture.source.client
      let client = try XCTUnwrap(connected)
      try await client.copyItem(
        atPath: "photo.dng", toPath: "copied.dng", recursive: false, progress: nil)
      try await client.copyItem(
        atPath: "photo.xmp", toPath: "copied.xmp", recursive: false, progress: nil)
      let copy = fixture.share.appendingPathComponent("copied.dng")
      XCTAssertEqual(try Data(contentsOf: copy), original)
      XCTAssertEqual(try Data(contentsOf: fixture.share.appendingPathComponent("copied.xmp")), xml)
      do {
        try await client.copyItem(
          atPath: "photo.dng", toPath: "copied.dng", recursive: false, progress: nil)
        XCTFail("COPYCHUNK replaced an occupied exclusive destination")
      } catch {}
      XCTAssertEqual(try Data(contentsOf: copy), original)
      try await client.copyItem(
        atPath: "photo.dng", toPath: "cancelled.dng", recursive: false, progress: { _, _ in false })
      let cancelled = try Data(contentsOf: fixture.share.appendingPathComponent("cancelled.dng"))
      XCTAssertGreaterThan(cancelled.count, 0)
      XCTAssertLessThan(cancelled.count, original.count)
      XCTAssertEqual(cancelled, original.prefix(cancelled.count))
      XCTAssertEqual(try Data(contentsOf: fixture.raw), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw)), xml)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testPhysicalLocalStageReplacementFailsClosedAndRetainsOriginalPair() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "local-substitution")
    let foreign = try NativeWorkflowControlFixture.files()
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: foreign.directory)
    }
    let selected = root.appendingPathComponent("photo.dng")
    let original = try physicalRAW()
    let xml = Data(NativeWorkflowControlFixture.input().utf8)
    try original.write(to: selected)
    try xml.write(to: SidecarPath.sidecarURL(for: selected))
    let result = try await LocalFileOperations.trashToMapleFolder(selected, libraryRoot: root)
    let trashed = URL(fileURLWithPath: result.primaryPath)
    let foreignPath = foreign.raw
    do {
      _ = try await Task.detached {
        try LocalFileOperations.restoreFilePair(
          trashed, to: root, confinedTo: root,
          beforeClaim: { stage, target in
            if target.pathExtension == "dng" {
              try FileManager.default.removeItem(at: stage)
              try FileManager.default.copyItem(at: foreignPath, to: stage)
            }
          })
      }.value
      XCTFail("An unverified replacement was published and the original removed")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: trashed), original)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: trashed)), xml)
    XCTAssertEqual(try Data(contentsOf: selected), foreign.original)
  }

  func testAuthenticatedSMBStageReplacementFailsClosedAndRetainsOriginalPair() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let foreign = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: foreign.directory) }
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let ref = try await fixture.image()
      let trash = try await fixture.source.trashAsset(ref)
      let connected = await fixture.source.client
      let client = try XCTUnwrap(connected)
      let share = fixture.share
      let foreignPath = foreign.raw
      let transport = RestoreRealSMBTransport(client: client) { stage, _ in
        let path = share.appendingPathComponent(String(stage.dropFirst()))
        try FileManager.default.removeItem(at: path)
        try FileManager.default.copyItem(at: foreignPath, to: path)
      }
      do {
        _ = try await SMBFileOperations.restoreFromMapleTrash(
          trash.primaryPath, transport: transport)
        XCTFail("An unverified replacement was published and the original removed")
      } catch {}
      let trashedPath = share.appendingPathComponent(String(trash.primaryPath.dropFirst()))
      XCTAssertEqual(try Data(contentsOf: trashedPath), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: trashedPath)), xml)
      // Handle custody rejects the replacement before publication. The
      // unowned stage is retained, while the original pair remains in trash.
      XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.raw.path))
      let stages = try FileManager.default.contentsOfDirectory(
        at: share, includingPropertiesForKeys: nil
      )
      .filter { $0.lastPathComponent.contains(".tmp.") }
      XCTAssertEqual(try stages.filter { try Data(contentsOf: $0) == foreign.original }.count, 1)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testPhysicalLocalPublishedSidecarReplacementFailsClosedAndRetainsOriginalPair() async throws
  {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "local-sidecar-substitution")
    let foreign = try NativeWorkflowControlFixture.files()
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: foreign.directory)
    }
    let selected = root.appendingPathComponent("photo.dng")
    let original = try physicalRAW()
    let xml = Data(NativeWorkflowControlFixture.input().utf8)
    try original.write(to: selected)
    try xml.write(to: SidecarPath.sidecarURL(for: selected))
    let result = try await LocalFileOperations.trashToMapleFolder(selected, libraryRoot: root)
    let trashed = URL(fileURLWithPath: result.primaryPath)
    let foreignPath = foreign.raw
    do {
      _ = try await Task.detached {
        try LocalFileOperations.restoreFilePair(
          trashed, to: root, confinedTo: root,
          beforeClaim: { stage, target in
            if target.pathExtension == "dng" {
              let sidecar = SidecarPath.sidecarURL(for: target)
              try FileManager.default.removeItem(at: sidecar)
              try FileManager.default.copyItem(at: foreignPath, to: sidecar)
            }
          })
      }.value
      XCTFail("An unverified replacement was published and the original removed")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: trashed), original)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: trashed)), xml)
    XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: selected)), foreign.original)
  }

  func testAuthenticatedSMBPublishedSidecarReplacementFailsClosedAndRetainsOriginalPair()
    async throws
  {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let foreign = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: foreign.directory) }
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let ref = try await fixture.image()
      let trash = try await fixture.source.trashAsset(ref)
      let connected = await fixture.source.client
      let client = try XCTUnwrap(connected)
      let share = fixture.share
      let foreignPath = foreign.raw
      let transport = RestoreRealSMBTransport(client: client) { _, target in
        let path = SidecarPath.sidecarURL(
          for: share.appendingPathComponent(String(target.dropFirst())))
        try FileManager.default.removeItem(at: path)
        try FileManager.default.copyItem(at: foreignPath, to: path)
      }
      do {
        _ = try await SMBFileOperations.restoreFromMapleTrash(
          trash.primaryPath, transport: transport)
        XCTFail("An unverified replacement was published and the original removed")
      } catch {}
      let trashedPath = share.appendingPathComponent(String(trash.primaryPath.dropFirst()))
      XCTAssertEqual(try Data(contentsOf: trashedPath), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: trashedPath)), xml)
      // A changed destination is retained for recovery, never blindly deleted.
      XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.raw.path))
      XCTAssertEqual(
        try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw)), foreign.original)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testAuthenticatedSMBRestoreCollisionPreservesPhotoAndForeignXmp() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let ref = try await fixture.image()
      _ = try await fixture.source.trashAsset(ref)
      try Data("occupied original".utf8).write(to: fixture.raw)
      let occupiedXmp = Data("<foreign>occupied</foreign>".utf8)
      try occupiedXmp.write(to: SidecarPath.sidecarURL(for: fixture.raw))
      let trash = try await fixture.source.listTrash()
      let item = try XCTUnwrap(trash.first { $0.displayName == "photo.dng" })
      let outcome = try await fixture.source.restoreFromTrash(item)
      XCTAssertEqual(outcome.primaryPath, "/photo.restored.dng")
      let result = fixture.share.appendingPathComponent(String(outcome.primaryPath.dropFirst()))
      XCTAssertEqual(try Data(contentsOf: result), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: result)), xml)
      XCTAssertEqual(try Data(contentsOf: fixture.raw), Data("occupied original".utf8))
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw)), occupiedXmp)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }
  func testAuthenticatedSMBRepeatedOrphansAndAllPairedXmlFollowPhysicalRaw() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let ref = try await fixture.image()
      let trash = try await fixture.source.trashAsset(ref)
      let trashed = fixture.share.appendingPathComponent(String(trash.primaryPath.dropFirst()))
      let incoming = [
        "photo (conflict from Camera) (2).xmp",
        "photo.v01234567-89ab-cdef-0123-456789abcdef.xmp",
      ]
      for name in incoming {
        try xml.write(to: trashed.deletingLastPathComponent().appendingPathComponent(name))
      }
      let occupants = [
        "photo (conflict from NAS).xmp", "photo.restored.xmp",
        "photo.restored.1.v01234567-89ab-cdef-0123-456789abcdef.xmp",
      ]
      let occupied = Data("<foreign>existing orphan</foreign>".utf8)
      for name in occupants { try occupied.write(to: fixture.share.appendingPathComponent(name)) }
      let connected = await fixture.source.client
      let transport = RestoreRealSMBTransport(client: try XCTUnwrap(connected)) { _, _ in }
      let outcome = try await SMBFileOperations.restoreFromMapleTrash(
        trash.primaryPath, transport: transport)
      XCTAssertEqual(outcome.primaryPath, "/photo.restored.2.dng")
      let restored = fixture.share.appendingPathComponent("photo.restored.2.dng")
      XCTAssertEqual(try Data(contentsOf: restored), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: restored)), xml)
      for name in incoming {
        let renamed = "photo.restored.2" + String(name.dropFirst("photo".count))
        XCTAssertEqual(try Data(contentsOf: fixture.share.appendingPathComponent(renamed)), xml)
        XCTAssertFalse(
          FileManager.default.fileExists(
            atPath: trashed.deletingLastPathComponent().appendingPathComponent(name).path))
      }
      for name in occupants {
        XCTAssertEqual(try Data(contentsOf: fixture.share.appendingPathComponent(name)), occupied)
      }
      XCTAssertFalse(FileManager.default.fileExists(atPath: trashed.path))
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testAuthenticatedSMBExclusivePublicationRaceRetainsOccupantAndRetriesPair() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let ref = try await fixture.image()
      let trash = try await fixture.source.trashAsset(ref)
      let connected = await fixture.source.client
      let occupied = Data("owned concurrent writer".utf8)
      let share = fixture.share
      let transport = RestoreRealSMBTransport(client: try XCTUnwrap(connected)) { _, target in
        try occupied.write(
          to: share.appendingPathComponent(String(target.dropFirst())), options: .withoutOverwriting
        )
      }
      let result = try await SMBFileOperations.restoreFromMapleTrash(
        trash.primaryPath, transport: transport)
      XCTAssertEqual(result.primaryPath, "/photo.restored.dng")
      let restored = share.appendingPathComponent("photo.restored.dng")
      XCTAssertEqual(try Data(contentsOf: restored), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: restored)), xml)
      XCTAssertEqual(try Data(contentsOf: fixture.raw), occupied)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: fixture.raw).path))
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

  func testAuthenticatedSMBBlockedDestinationRetainsPhysicalRawAndXml() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    do {
      let original = try physicalRAW()
      try original.write(to: fixture.raw)
      let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.raw))
      let ref = try await fixture.image()
      let trash = try await fixture.source.trashAsset(ref)
      let blocker = fixture.share.appendingPathComponent("blocked")
      let occupied = Data("existing directory-name file".utf8)
      try occupied.write(to: blocker)
      let connected = await fixture.source.client
      let transport = RestoreRealSMBTransport(client: try XCTUnwrap(connected)) { _, _ in }
      do {
        _ = try await SMBFileOperations.restoreFilePair(
          trash.primaryPath, to: "/blocked", transport: transport)
        XCTFail("Restore accepted a file as a destination directory")
      } catch {}
      let trashed = fixture.share.appendingPathComponent(String(trash.primaryPath.dropFirst()))
      XCTAssertEqual(try Data(contentsOf: trashed), original)
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: trashed)), xml)
      XCTAssertEqual(try Data(contentsOf: blocker), occupied)
      await fixture.close()
    } catch {
      await fixture.close(error: error)
      throw error
    }
  }

}

private final class RestoreChunkProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var hash = SHA256()
  private var total: UInt64 = 0
  private var reads = 0
  private var largest = 0
  var count: UInt64 { lock.withLock { total } }
  var calls: Int { lock.withLock { reads } }
  var maximum: Int { lock.withLock { largest } }
  func update(_ chunk: Data) {
    lock.withLock {
      hash.update(data: chunk)
      total += UInt64(chunk.count)
      reads += 1
      largest = max(largest, chunk.count)
    }
  }
  func digest() -> SHA256.Digest { lock.withLock { hash.finalize() } }
}
