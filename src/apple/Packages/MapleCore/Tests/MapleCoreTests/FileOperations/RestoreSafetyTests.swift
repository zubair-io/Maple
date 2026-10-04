import Foundation
import XCTest

@testable import MapleCore

final class RestoreSafetyTests: XCTestCase {
  private func trashedPair() async throws -> (root: URL, source: URL, original: Data, xml: Data) {
    let files = try NativeWorkflowControlFixture.files()
    let xml = Data(NativeWorkflowControlFixture.input().utf8)
    try xml.write(to: SidecarPath.sidecarURL(for: files.raw))
    let result = try await LocalFileOperations.trashToMapleFolder(
      files.raw, libraryRoot: files.directory)
    return (files.directory, URL(fileURLWithPath: result.primaryPath), files.original, xml)
  }

  func testSharedRestoreNamingCorpusUsesActualLocalFiles() async throws {
    struct Corpus: Decodable { let cases: [Case] }
    struct Case: Decodable {
      let name: String
      let base: String
      let occupied: [String]
      let expected: String
      let incoming: [String]?
    }
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<8 { root.deleteLastPathComponent() }
    let corpus = try JSONDecoder().decode(
      Corpus.self,
      from: Data(
        contentsOf: root.appendingPathComponent(
          "test-fixtures/file-operations/restore-collisions.json")))
    for item in corpus.cases {
      let folder = try SidecarContractIO.makeTempDirectory(prefix: "restore-corpus")
      defer { try? FileManager.default.removeItem(at: folder) }
      let source = folder.appendingPathComponent(item.base)
      let bytes = Data(("original " + item.name).utf8)
      try bytes.write(to: source)
      let trashed = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: folder)
      let incoming = Data(NativeWorkflowControlFixture.input().utf8)
      let trashDirectory = URL(fileURLWithPath: trashed.primaryPath).deletingLastPathComponent()
      for name in item.incoming ?? [] {
        try incoming.write(to: trashDirectory.appendingPathComponent(name))
      }
      let occupied = Data("<foreign>occupied</foreign>".utf8)
      for name in item.occupied { try occupied.write(to: folder.appendingPathComponent(name)) }
      let result = try await LocalFileOperations.restoreFromMapleTrash(
        URL(fileURLWithPath: trashed.primaryPath), libraryRoot: folder)
      XCTAssertEqual(
        URL(fileURLWithPath: result.primaryPath).lastPathComponent, item.expected, item.name)
      XCTAssertEqual(
        try Data(contentsOf: URL(fileURLWithPath: result.primaryPath)), bytes, item.name)
      for name in item.incoming ?? [] {
        let oldBase = RestoreSidecarPairing.base(item.base)
        let newBase = RestoreSidecarPairing.base(item.expected)
        let renamed = newBase + String(name.dropFirst(oldBase.count))
        XCTAssertEqual(
          try Data(contentsOf: folder.appendingPathComponent(renamed)), incoming, item.name)
        XCTAssertFalse(
          FileManager.default.fileExists(atPath: trashDirectory.appendingPathComponent(name).path))
      }
      for name in item.occupied {
        XCTAssertEqual(
          try Data(contentsOf: folder.appendingPathComponent(name)), occupied, item.name)
      }
    }
  }

  func testIncomingCanonicalConflictAndWorkflowXmpAllFollowAndRetainForeignXML() async throws {
    let fixture = try await trashedPair()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let directory = fixture.source.deletingLastPathComponent()
    let names = [
      "photo (conflict from Mac) (2).xmp", "photo.v12345678-1234-1234-1234-123456789abc.xmp",
    ]
    for name in names { try fixture.xml.write(to: directory.appendingPathComponent(name)) }
    let foreign = directory.appendingPathComponent("photo.v2.xmp")
    try Data("unpaired".utf8).write(to: foreign)
    let occupied = fixture.root.appendingPathComponent("photo.dng")
    try Data("another original".utf8).write(to: occupied)
    let result = try await LocalFileOperations.restoreFromMapleTrash(
      fixture.source, libraryRoot: fixture.root)
    XCTAssertEqual(URL(fileURLWithPath: result.primaryPath).lastPathComponent, "photo.restored.dng")
    for name in ["photo.xmp"] + names {
      let restored = name.replacingOccurrences(
        of: "photo", with: "photo.restored", options: .anchored)
      XCTAssertEqual(
        try Data(contentsOf: fixture.root.appendingPathComponent(restored)), fixture.xml)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path))
    }
    XCTAssertEqual(try Data(contentsOf: foreign), Data("unpaired".utf8))
    XCTAssertEqual(try Data(contentsOf: occupied), Data("another original".utf8))
  }

  func testOrphanSidecarOccupiesOriginalAndRepeatedCandidates() async throws {
    let fixture = try await trashedPair()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let name = fixture.source.lastPathComponent
    let original = fixture.root.appendingPathComponent(name)
    let first = URL(fileURLWithPath: RestoreCollisionNaming.candidate(original.path, attempt: 0))
    let second = URL(fileURLWithPath: RestoreCollisionNaming.candidate(original.path, attempt: 1))
    let sentinel = Data("<foreign>other photograph</foreign>".utf8)
    for candidate in [original, first, second] {
      try sentinel.write(to: SidecarPath.sidecarURL(for: candidate))
    }
    let result = try await LocalFileOperations.restoreFromMapleTrash(
      fixture.source, libraryRoot: fixture.root)
    XCTAssertEqual(result.primaryPath, RestoreCollisionNaming.candidate(original.path, attempt: 2))
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: result.primaryPath)), fixture.original)
    XCTAssertEqual(
      try Data(contentsOf: URL(fileURLWithPath: try XCTUnwrap(result.sidecarPath))), fixture.xml)
    for candidate in [original, first, second] {
      XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: candidate)), sentinel)
    }
  }

  func testDanglingOriginalAndRestoredSymlinksAreOccupied() async throws {
    let fixture = try await trashedPair()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let original = fixture.root.appendingPathComponent(fixture.source.lastPathComponent)
    let first = URL(fileURLWithPath: RestoreCollisionNaming.candidate(original.path, attempt: 0))
    for path in [original, first] {
      try FileManager.default.createSymbolicLink(
        atPath: path.path, withDestinationPath: "absent-target")
    }
    let result = try await LocalFileOperations.restoreFromMapleTrash(
      fixture.source, libraryRoot: fixture.root)
    XCTAssertEqual(result.primaryPath, RestoreCollisionNaming.candidate(original.path, attempt: 1))
    for path in [original, first] {
      XCTAssertEqual(
        try FileManager.default.destinationOfSymbolicLink(atPath: path.path), "absent-target")
    }
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: result.primaryPath)), fixture.original)
  }

  func testCollisionExhaustionRetainsCompleteTrashPairAndOccupants() async throws {
    let fixture = try await trashedPair()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let original = fixture.root.appendingPathComponent(fixture.source.lastPathComponent)
    let sentinel = Data("occupied".utf8)
    for attempt in -1...CollisionResolver.maxAttempts {
      try sentinel.write(
        to: URL(fileURLWithPath: RestoreCollisionNaming.candidate(original.path, attempt: attempt)))
    }
    do {
      _ = try await LocalFileOperations.restoreFromMapleTrash(
        fixture.source, libraryRoot: fixture.root)
      XCTFail("An occupied candidate was reused after exhaustion")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: fixture.source), fixture.original)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.source)), fixture.xml)
    for attempt in -1...CollisionResolver.maxAttempts {
      XCTAssertEqual(
        try Data(
          contentsOf: URL(
            fileURLWithPath: RestoreCollisionNaming.candidate(original.path, attempt: attempt))),
        sentinel)
    }
  }

  func testSymlinkSourceIsRejectedWithoutTouchingTarget() async throws {
    let fixture = try await trashedPair()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let parked = fixture.source.appendingPathExtension("parked")
    try FileManager.default.moveItem(at: fixture.source, to: parked)
    try FileManager.default.createSymbolicLink(at: fixture.source, withDestinationURL: parked)
    do {
      _ = try await LocalFileOperations.restoreFromMapleTrash(
        fixture.source, libraryRoot: fixture.root)
      XCTFail("A symbolic-link source was restored as a photograph")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: parked), fixture.original)
    XCTAssertEqual(
      try FileManager.default.destinationOfSymbolicLink(atPath: fixture.source.path), parked.path)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: fixture.source)), fixture.xml)
  }

  func testEscapingDestinationAncestorIsRejected() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "restore-containment")
    let outside = try SidecarContractIO.makeTempDirectory(prefix: "restore-outside")
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: outside)
    }
    let trash = root.appendingPathComponent(".maple/trash/sub")
    try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
    let source = trash.appendingPathComponent("photo.dng")
    let original = Data("owned source".utf8)
    try original.write(to: source)
    try FileManager.default.createSymbolicLink(
      at: root.appendingPathComponent("sub"), withDestinationURL: outside)
    do {
      _ = try await LocalFileOperations.restoreFromMapleTrash(source, libraryRoot: root)
      XCTFail("Restore wrote through an escaping ancestor")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: source), original)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: outside.appendingPathComponent("photo.dng").path))
  }

  func testFailedDestinationRetainsForeignXmpAndOriginal() async throws {
    let fixture = try await trashedPair()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let directory = fixture.root.appendingPathComponent("sub")
    let trashDirectory = fixture.source.deletingLastPathComponent().appendingPathComponent("sub")
    try FileManager.default.createDirectory(at: trashDirectory, withIntermediateDirectories: true)
    let source = trashDirectory.appendingPathComponent(fixture.source.lastPathComponent)
    try FileManager.default.moveItem(at: fixture.source, to: source)
    try FileManager.default.moveItem(
      at: SidecarPath.sidecarURL(for: fixture.source), to: SidecarPath.sidecarURL(for: source))
    try Data("occupied directory path".utf8).write(to: directory)
    do {
      _ = try await LocalFileOperations.restoreFromMapleTrash(source, libraryRoot: fixture.root)
      XCTFail("A file was accepted as a destination directory")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: source), fixture.original)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: source)), fixture.xml)
    XCTAssertEqual(try Data(contentsOf: directory), Data("occupied directory path".utf8))
  }
}
