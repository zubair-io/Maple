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

  func testFilesystemRootContainmentReachesTheRealFilesystemWithoutWritingRoot() async throws {
    let root = URL(fileURLWithPath: "/", isDirectory: true)
    let unique = "restore-root-control-" + UUID().uuidString
    // These absent paths execute the public containment gates and actual directory
    // read. No fixture is created in the system root or any user library.
    for relative in ["\(unique).dng", "\(unique)/photo.dng"] {
      let source = root.appendingPathComponent(".maple/trash/" + relative)
      XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
      do {
        _ = try await LocalFileOperations.restoreFromMapleTrash(source, libraryRoot: root)
        XCTFail("An absent source cannot be restored")
      } catch let error as FileOperationError {
        XCTFail("A valid root-library path was rejected before the filesystem read: \(error)")
      } catch {
        let failure = error as NSError
        XCTAssertEqual(failure.domain, NSCocoaErrorDomain)
        XCTAssertEqual(failure.code, NSFileReadNoSuchFileError)
      }
      XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
    }
    do {
      _ = try await LocalFileOperations.restoreFromMapleTrash(
        root.appendingPathComponent(".maple-other/trash/" + unique + ".dng"), libraryRoot: root)
      XCTFail("A sibling of the trash namespace must be rejected")
    } catch let error as FileOperationError {
      guard case .invalidDestination = error else { return XCTFail("Unexpected error: \(error)") }
    }
  }

  private static func restoreCorpusURL(from source: URL) -> URL {
    var root = source.deletingLastPathComponent()
    while root.path != "/" {
      let candidate = root.appendingPathComponent(
        "test-fixtures/file-operations/restore-collisions.json")
      if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
      root.deleteLastPathComponent()
    }
    return root.appendingPathComponent("test-fixtures/file-operations/restore-collisions.json")
  }

  func testRestoreCorpusIsReadableFromTheActualIsolatedCIPackageLayout() throws {
    let stage = try SidecarContractIO.makeTempDirectory(prefix: "restore-ci-layout")
    defer { try? FileManager.default.removeItem(at: stage) }
    let source = stage.appendingPathComponent(
      "Packages/MapleCore/Tests/MapleCoreTests/FileOperations/RestoreSafetyTests.swift")
    let corpus = stage.appendingPathComponent(
      "test-fixtures/file-operations/restore-collisions.json")
    for file in [source, corpus] {
      try FileManager.default.createDirectory(
        at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    }
    try FileManager.default.copyItem(at: URL(fileURLWithPath: #filePath), to: source)
    let original = Self.restoreCorpusURL(from: URL(fileURLWithPath: #filePath))
    try FileManager.default.copyItem(at: original, to: corpus)
    let located = Self.restoreCorpusURL(from: source)
    XCTAssertEqual(located.standardizedFileURL, corpus.standardizedFileURL)
    XCTAssertEqual(try Data(contentsOf: located), try Data(contentsOf: original))
  }

  func testSharedRestoreNamingCorpusUsesActualLocalFiles() async throws {
    struct Corpus: Decodable {
      let schemaVersion: Int
      let cases: [Case]
    }
    struct Case: Decodable {
      let name: String
      let base: String
      let occupied: [String]
      let expected: String
      let incoming: [String]?
      let unpaired: [String]?
    }
    let corpus = try JSONDecoder().decode(
      Corpus.self,
      from: Data(contentsOf: Self.restoreCorpusURL(from: URL(fileURLWithPath: #filePath))))
    guard corpus.schemaVersion == 1 else {
      XCTFail("Unsupported restore corpus schemaVersion: \(corpus.schemaVersion)")
      return
    }
    for item in corpus.cases {
      let folder = try SidecarContractIO.makeTempDirectory(prefix: "restore-corpus")
      defer { try? FileManager.default.removeItem(at: folder) }
      let source = folder.appendingPathComponent(item.base)
      let bytes = Data(("original " + item.name).utf8)
      try bytes.write(to: source)
      let trashed = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: folder)
      let incoming = Data(NativeWorkflowControlFixture.input().utf8)
      let trashDirectory = URL(fileURLWithPath: trashed.primaryPath).deletingLastPathComponent()
      for name in (item.incoming ?? []) + (item.unpaired ?? []) {
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
      for name in item.unpaired ?? [] {
        XCTAssertEqual(
          try Data(contentsOf: trashDirectory.appendingPathComponent(name)), incoming, item.name)
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

  func testConfinedRestoreRejectsEscapingAncestorAtAnchorCapture() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "restore-anchor")
    let outside = try SidecarContractIO.makeTempDirectory(prefix: "restore-anchor-outside")
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
    // Direct call bypasses restoreFromMapleTrash's snapshot containment
    // gate, proving the O_NOFOLLOW anchor itself refuses the escape.
    do {
      _ = try await Task.detached {
        try LocalFileOperations.restoreFilePair(
          source, to: root.appendingPathComponent("sub"), confinedTo: root)
      }.value
      XCTFail("Restore published through an escaping ancestor")
    } catch let error as FileOperationError {
      guard case .invalidDestination = error else {
        return XCTFail("Unexpected error: \(error)")
      }
    }
    XCTAssertEqual(try Data(contentsOf: source), original)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: outside.appendingPathComponent("photo.dng").path))
  }

  func testAncestorSwapDuringPublicationFailsClosedAndRetainsTrashOriginals() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "restore-swap")
    let outside = try SidecarContractIO.makeTempDirectory(prefix: "restore-swap-outside")
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: outside)
    }
    let sub = root.appendingPathComponent("sub")
    try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
    let trash = root.appendingPathComponent(".maple/trash/sub")
    try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
    let source = trash.appendingPathComponent("photo.dng")
    let original = Data("owned source".utf8)
    try original.write(to: source)
    let mirror = outside.appendingPathComponent("mirror")
    try FileManager.default.createDirectory(at: mirror, withIntermediateDirectories: true)
    do {
      _ = try await Task.detached {
        try LocalFileOperations.restoreFilePair(
          source, to: sub, confinedTo: root,
          beforeClaim: { _, _ in
            let fm = FileManager.default
            let stage = try fm.contentsOfDirectory(at: sub, includingPropertiesForKeys: nil)
              .first { $0.lastPathComponent.hasPrefix(".maple-restore.tmp.") }
            if let stage {
              // Hardlink-preserving mirror: published files keep the
              // staged identity, so only the directory anchor can catch
              // the swap — every file-identity check still passes.
              let target = mirror.appendingPathComponent(stage.lastPathComponent)
              if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
              try fm.createDirectory(at: target, withIntermediateDirectories: true)
              for item in try fm.contentsOfDirectory(at: stage, includingPropertiesForKeys: nil) {
                try fm.linkItem(
                  at: item, to: target.appendingPathComponent(item.lastPathComponent))
              }
              try fm.removeItem(at: sub)
              try fm.createSymbolicLink(at: sub, withDestinationURL: mirror)
            }
          })
      }.value
      XCTFail("Restore published through a swapped ancestor")
    } catch let error as FileOperationError {
      guard case .verificationFailed = error else {
        return XCTFail("Unexpected error: \(error)")
      }
    }
    XCTAssertEqual(try Data(contentsOf: source), original)
  }
}
