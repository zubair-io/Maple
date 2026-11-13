// SMBFileOperationsRelocateTests.swift — issue #2631 acceptance coverage
// for the SMB engine: collision handling, sidecar-follow, copy-vs-move, and
// crash-mid-copy (source untouched), against a real in-memory
// `SMBFileTransport` fake (no live SMB server is available in this
// environment — see `FakeSMBTransport.swift` for why this is the right
// substitute rather than a violation of "no mocks").

import XCTest

@testable import MapleCore

final class SMBFileOperationsRelocateTests: XCTestCase {

  func testMoveDeletesSourceAfterVerifiedCopy() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/IMG_1.dng")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

    let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
    XCTAssertFalse(sourceStillThere)
    let destContents = await t.fileContents(at: outcome.primaryPath)
    XCTAssertEqual(destContents, "pixels")
  }

  func testCopyLeavesSourceIntact() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/IMG_1.dng")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .copy, transport: t)

    let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
    XCTAssertTrue(sourceStillThere)
    XCTAssertNotEqual(outcome.primaryPath, "/Source/IMG_1.dng")
  }

  func testSidecarFollowsThePrimary() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/IMG_1.dng")
    await t.seed("<xmp/>", at: "/Source/IMG_1.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

    XCTAssertTrue(outcome.sidecarFollowed)
    let oldSidecarGone = await !t.fileExists(at: "/Source/IMG_1.xmp")
    XCTAssertTrue(oldSidecarGone)
    let newSidecar = try XCTUnwrap(outcome.sidecarPath)
    let newSidecarContents = await t.fileContents(at: newSidecar)
    XCTAssertEqual(newSidecarContents, "<xmp/>")
  }

  func testVideoSidecarKeepsTheFullNameConvention() async throws {
    let t = FakeSMBTransport()
    await t.seed("frames", at: "/Source/CLIP.mov")
    await t.seed("<xmp/>", at: "/Source/CLIP.mov.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/CLIP.mov", to: "/Album", mode: .move, transport: t)

    XCTAssertEqual(outcome.sidecarPath, "/Album/CLIP.mov.xmp")
  }

  func testAutoSuffixNeverOverwrites() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("existing", at: "/Album/IMG_1.dng")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .autoSuffix, transport: t)

    XCTAssertTrue(outcome.renamedDueToCollision)
    XCTAssertEqual(outcome.primaryPath, "/Album/IMG_1.1.dng")
    let occupantContents = await t.fileContents(at: "/Album/IMG_1.dng")
    XCTAssertEqual(occupantContents, "existing")
  }

  func testCollisionPolicyFailLeavesTheSourceUntouched() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("existing", at: "/Album/IMG_1.dng")

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .fail, transport: t)
      XCTFail("expected destinationExists")
    } catch FileOperationError.destinationExists {
      // expected
    }

    let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
    XCTAssertTrue(sourceStillThere)
  }

  func testCollisionPolicyReplaceOverwritesTheOccupant() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("stale", at: "/Album/IMG_1.dng")

    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .replace, transport: t)

    let occupantContents = await t.fileContents(at: "/Album/IMG_1.dng")
    XCTAssertEqual(occupantContents, "new")
  }

  // MARK: - Crash safety

  func testPlanAloneLeavesSourceAndVerifiedCopyBothPresent() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/IMG_1.dng")

    let plan = try await SMBFileOperations.planRelocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

    let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
    XCTAssertTrue(sourceStillThere, "plan must never touch the source")
    let stagedContents = await t.fileContents(at: plan.finalPrimaryPath)
    XCTAssertEqual(stagedContents, "pixels")

    await SMBFileOperations.finalizeRelocate(plan, transport: t)
    let sourceGoneAfterFinalize = await !t.fileExists(at: "/Source/IMG_1.dng")
    XCTAssertTrue(sourceGoneAfterFinalize)
  }

  /// The SMB counterpart of the local engine's "kill mid-copy" test:
  /// force the copy step itself to fail via the fake transport's fault
  /// injection and assert the source survives with no partial artifact.
  func testCopyFailureLeavesSourceUntouchedAndNoPartialArtifact() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/IMG_1.dng")
    await t.setFailCopyToPath("/Album/IMG_1.dng")

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)
      XCTFail("expected the injected failure to propagate")
    } catch {
      // expected
    }

    let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
    XCTAssertTrue(sourceStillThere)
    let partialArtifact = await t.fileExists(at: "/Album/IMG_1.dng")
    XCTAssertFalse(partialArtifact, "a failed copy must not leave a partial destination file")
  }

  func testSourceMissingThrows() async throws {
    let t = FakeSMBTransport()
    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/ghost.dng", to: "/Album", mode: .move, transport: t)
      XCTFail("expected sourceMissing")
    } catch FileOperationError.sourceMissing {
      // expected
    }
  }

  // MARK: - Same-file guard (PR #2676 review)

  func testRelocatingToItsOwnExactPathThrowsSameFile() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/IMG_1.dng")
    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Source", mode: .move, transport: t)
      XCTFail("expected .sameFile")
    } catch FileOperationError.sameFile {
      // expected
    }
    let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
    XCTAssertTrue(sourceStillThere)
  }

  /// A case-only rename (`img.cr3` -> `IMG.CR3`) is detected purely from
  /// the path strings (no share round-trip needed) and routed through a
  /// direct `moveItem` rather than collision handling.
  func testCaseOnlyRenameMoveSucceedsAndTheSidecarFollows() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/img.cr3")
    await t.seed("<xmp/>", at: "/Source/img.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/img.cr3", to: "/Source", newBasename: "IMG.CR3", mode: .move, transport: t)

    XCTAssertEqual(outcome.primaryPath, "/Source/IMG.CR3")
    let oldGone = await !t.fileExists(at: "/Source/img.cr3")
    XCTAssertTrue(oldGone)
    let newContents = await t.fileContents(at: "/Source/IMG.CR3")
    XCTAssertEqual(newContents, "pixels")
    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertEqual(outcome.sidecarPath, "/Source/IMG.xmp")
  }

  func testCaseOnlyRenameCopyIsRefused() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/img.cr3")
    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/img.cr3", to: "/Source", newBasename: "IMG.CR3", mode: .copy, transport: t)
      XCTFail("expected .sameFile")
    } catch FileOperationError.sameFile {
      // expected
    }
    let sourceStillThere = await t.fileExists(at: "/Source/img.cr3")
    XCTAssertTrue(sourceStillThere)
  }

  // MARK: - Safe replace publish & basename validation (#4703)

  func testReplacePreservesOccupantAndSidecarWhenCopyFails() async throws {
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
    } catch FakeSMBTransportError.injectedFailure, FileOperationError.underlying {
      // expected
    }

    let sourceContents = await t.fileContents(at: "/Source/IMG_1.dng")
    XCTAssertEqual(sourceContents, "new")
    let sourceSidecar = await t.fileContents(at: "/Source/IMG_1.xmp")
    XCTAssertEqual(sourceSidecar, "<new-xmp/>")
    let occupantContents = await t.fileContents(at: "/Album/IMG_1.dng")
    XCTAssertEqual(occupantContents, "existing", "occupant must survive a failed replace copy")
    let occupantSidecar = await t.fileContents(at: "/Album/IMG_1.xmp")
    XCTAssertEqual(
      occupantSidecar, "<existing-xmp/>", "occupant sidecar must survive a failed replace copy")
  }

  func testReplaceClearsStaleOccupantSidecarWhenSourceHasNone() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("stale", at: "/Album/IMG_1.dng")
    await t.seed("<stale-xmp/>", at: "/Album/IMG_1.xmp")

    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .replace, transport: t)

    let occupantContents = await t.fileContents(at: "/Album/IMG_1.dng")
    XCTAssertEqual(occupantContents, "new")
    let staleSidecarExists = await t.fileExists(at: "/Album/IMG_1.xmp")
    XCTAssertFalse(
      staleSidecarExists, "stale occupant sidecar must be removed after replace succeeds")
  }

  func testReplaceRefusesDirectoryOccupantWithoutDeletingContents() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("keep-me", at: "/Album/IMG_1.dng/nested.dng")

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .replace, transport: t)
      XCTFail("expected invalidDestination")
    } catch FileOperationError.invalidDestination {
      // expected
    }

    let dirStillThere = await t.directoryExists(at: "/Album/IMG_1.dng")
    XCTAssertTrue(dirStillThere, "directory occupant must not be removed")
    let nestedContents = await t.fileContents(at: "/Album/IMG_1.dng/nested.dng")
    XCTAssertEqual(nestedContents, "keep-me", "nested file inside directory occupant must survive")
    let sourceContents = await t.fileContents(at: "/Source/IMG_1.dng")
    XCTAssertEqual(sourceContents, "new")
  }

  func testPlanRelocateRefusesInvalidNewBasename() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/Source/IMG_1.dng")

    for badName in ["../escaped.dng", "sub/IMG_1.dng", ".", "..", ""] {
      do {
        _ = try await SMBFileOperations.relocate(
          "/Source/IMG_1.dng", to: "/Album", newBasename: badName, mode: .move, transport: t)
        XCTFail("expected invalidName for \(badName)")
      } catch FileOperationError.invalidName {
        // expected
      }
    }

    let sourceContents = await t.fileContents(at: "/Source/IMG_1.dng")
    XCTAssertEqual(sourceContents, "pixels")
  }

  func testReplacePreservesOccupantAndSidecarWhenSidecarCopyFails() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("<new-xmp/>", at: "/Source/IMG_1.xmp")
    await t.seed("existing", at: "/Album/IMG_1.dng")
    await t.seed("<existing-xmp/>", at: "/Album/IMG_1.xmp")
    await t.setFailCopyToPath("/Album/IMG_1.xmp")

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.dng", to: "/Album", mode: .move, collision: .replace, transport: t)
      XCTFail("expected sidecar copy failure to propagate")
    } catch FakeSMBTransportError.injectedFailure, FileOperationError.underlying {
      // expected
    }

    let occupantContents = await t.fileContents(at: "/Album/IMG_1.dng")
    XCTAssertEqual(occupantContents, "existing", "occupant must survive a failed sidecar copy")
    let occupantSidecar = await t.fileContents(at: "/Album/IMG_1.xmp")
    XCTAssertEqual(
      occupantSidecar, "<existing-xmp/>", "occupant sidecar must survive a failed sidecar copy")
    let sourceContents = await t.fileContents(at: "/Source/IMG_1.dng")
    XCTAssertEqual(sourceContents, "new")
  }

  func testCopyVerifiedWithoutAllowReplaceRefusesConcurrentOccupant() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.dng")
    await t.seed("concurrent", at: "/Album/IMG_1.dng")

    do {
      try await SMBFileOperations.copyVerified(
        from: "/Source/IMG_1.dng", to: "/Album/IMG_1.dng", transport: t)
      XCTFail("expected destinationExists when allowReplace is false")
    } catch FileOperationError.destinationExists {
      // expected
    }

    let occupantContents = await t.fileContents(at: "/Album/IMG_1.dng")
    XCTAssertEqual(occupantContents, "concurrent")
    let trashExists = await t.directoryExists(at: "/.maple/trash")
    XCTAssertFalse(trashExists, "replace/publish must never touch /.maple/trash")
  }

  func testReplaceWithMaxLengthBasenameUsesBoundedStagingNames() async throws {
    let t = FakeSMBTransport()
    let stem = String(repeating: "A", count: 251)
    let dng = "\(stem).dng"
    let xmp = "\(stem).xmp"
    await t.seed("new-max", at: "/Source/\(dng)")
    await t.seed("<new-max/>", at: "/Source/\(xmp)")
    await t.seed("old-max", at: "/Album/\(dng)")
    await t.seed("<old-max/>", at: "/Album/\(xmp)")

    _ = try await SMBFileOperations.relocate(
      "/Source/\(dng)", to: "/Album", mode: .move, collision: .replace, transport: t)

    let primary = await t.fileContents(at: "/Album/\(dng)")
    let sidecar = await t.fileContents(at: "/Album/\(xmp)")
    XCTAssertEqual(primary, "new-max")
    XCTAssertEqual(sidecar, "<new-max/>")
  }
}
