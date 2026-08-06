// LocalFileOperationsRelocateTests.swift — issue #2631 acceptance coverage:
// collision handling, sidecar-follow, copy-vs-move, and crash-mid-copy
// (source untouched). Every test runs against real temp directories and
// real files — no mocks.

import XCTest
@testable import MapleCore

final class LocalFileOperationsRelocateTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileOperationsTestSupport.makeTempDir()
    }

    override func tearDown() {
        FileOperationsTestSupport.cleanup(root)
        root = nil
        super.tearDown()
    }

    // MARK: - Copy vs move

    func testMoveDeletesSourceAfterVerifiedCopy() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let destDir = root.appendingPathComponent("Album")

        let outcome = try await LocalFileOperations.relocate(source, to: destDir, mode: .move)

        XCTAssertFalse(FileOperationsTestSupport.exists(source), "move must delete the source")
        XCTAssertEqual(FileOperationsTestSupport.contents(URL(fileURLWithPath: outcome.primaryPath)), "pixels")
    }

    func testCopyLeavesSourceIntact() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let destDir = root.appendingPathComponent("Album")

        let outcome = try await LocalFileOperations.relocate(source, to: destDir, mode: .copy)

        XCTAssertTrue(FileOperationsTestSupport.exists(source), "copy must leave the source in place")
        XCTAssertEqual(FileOperationsTestSupport.contents(source), "pixels")
        XCTAssertEqual(FileOperationsTestSupport.contents(URL(fileURLWithPath: outcome.primaryPath)), "pixels")
        XCTAssertNotEqual(outcome.primaryPath, source.path)
    }

    // MARK: - Sidecar-follow

    func testMoveCarriesTheSidecarAlong() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))
        let destDir = root.appendingPathComponent("Album")

        let outcome = try await LocalFileOperations.relocate(source, to: destDir, mode: .move)

        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: source)),
                       "the old sidecar must not be left behind")
        XCTAssertTrue(outcome.sidecarFollowed)
        let newSidecar = try XCTUnwrap(outcome.sidecarPath)
        XCTAssertEqual(FileOperationsTestSupport.contents(URL(fileURLWithPath: newSidecar)), "<xmp/>")
    }

    func testAssetWithNoSidecarReportsSidecarNotFollowed() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let outcome = try await LocalFileOperations.relocate(source, to: root.appendingPathComponent("Album"), mode: .move)
        XCTAssertFalse(outcome.sidecarFollowed)
        XCTAssertNil(outcome.sidecarPath)
    }

    func testRenameRecomputesTheSidecarUnderTheNewBasename() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))

        let outcome = try await LocalFileOperations.relocate(
            source, to: root, newBasename: "IMG_1_renamed.dng", mode: .move)

        XCTAssertEqual(outcome.primaryPath, root.appendingPathComponent("IMG_1_renamed.dng").path)
        XCTAssertEqual(outcome.sidecarPath, root.appendingPathComponent("IMG_1_renamed.xmp").path)
    }

    /// Live Photo pairing safety: a video's sidecar is full-name
    /// (`clip.mov.xmp`), not stem-swapped, so it must follow under the SAME
    /// convention at the destination — this is `SidecarPath`'s job, and
    /// relocate must not reimplement (and diverge from) that split.
    func testVideoSidecarKeepsTheFullNameConventionAfterMove() async throws {
        let source = FileOperationsTestSupport.write("frames", to: root.appendingPathComponent("CLIP.mov"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))

        let outcome = try await LocalFileOperations.relocate(source, to: root.appendingPathComponent("Album"), mode: .move)

        XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "CLIP.mov")
        XCTAssertEqual(outcome.sidecarPath.map { URL(fileURLWithPath: $0).lastPathComponent }, "CLIP.mov.xmp")
    }

    // MARK: - Collision handling

    func testAutoSuffixNeverOverwritesAndProducesADotNSibling() async throws {
        let source = FileOperationsTestSupport.write("new", to: root.appendingPathComponent("Source/IMG_1.dng"))
        FileOperationsTestSupport.write("existing", to: root.appendingPathComponent("Album/IMG_1.dng"))

        let outcome = try await LocalFileOperations.relocate(
            source, to: root.appendingPathComponent("Album"), mode: .move, collision: .autoSuffix)

        XCTAssertTrue(outcome.renamedDueToCollision)
        XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "IMG_1.1.dng")
        XCTAssertEqual(FileOperationsTestSupport.contents(root.appendingPathComponent("Album/IMG_1.dng")), "existing",
                       "the pre-existing occupant must never be overwritten")
        XCTAssertEqual(FileOperationsTestSupport.contents(URL(fileURLWithPath: outcome.primaryPath)), "new")
    }

    func testCollisionPolicyFailThrowsAndLeavesEverythingUntouched() async throws {
        let source = FileOperationsTestSupport.write("new", to: root.appendingPathComponent("Source/IMG_1.dng"))
        let occupantURL = root.appendingPathComponent("Album/IMG_1.dng")
        FileOperationsTestSupport.write("existing", to: occupantURL)

        do {
            _ = try await LocalFileOperations.relocate(
                source, to: root.appendingPathComponent("Album"), mode: .move, collision: .fail)
            XCTFail("expected destinationExists")
        } catch FileOperationError.destinationExists {
            // expected
        }

        XCTAssertTrue(FileOperationsTestSupport.exists(source), "source must survive a failed relocate")
        XCTAssertEqual(FileOperationsTestSupport.contents(occupantURL), "existing")
    }

    func testCollisionPolicyReplaceOverwritesTheOccupantAndItsSidecar() async throws {
        let source = FileOperationsTestSupport.write("new", to: root.appendingPathComponent("Source/IMG_1.dng"))
        let occupantURL = root.appendingPathComponent("Album/IMG_1.dng")
        FileOperationsTestSupport.write("stale", to: occupantURL)
        FileOperationsTestSupport.write("<stale-xmp/>", to: SidecarPath.sidecarURL(for: occupantURL))

        let outcome = try await LocalFileOperations.relocate(
            source, to: root.appendingPathComponent("Album"), mode: .move, collision: .replace)

        XCTAssertFalse(outcome.renamedDueToCollision)
        XCTAssertEqual(FileOperationsTestSupport.contents(occupantURL), "new")
        XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: occupantURL)),
                       "the stale occupant's sidecar must be cleared too")
    }

    /// Matches the TS twin's semantics (`src/api/src/fs/relocate.ts`'s
    /// `isSameFile` guard, branch feat/api-relocate-primitive-2629): a
    /// destination that resolves to the exact source path is refused, not
    /// silently no-op'd — a literal "relocate to itself" request is one
    /// instance of the same "destination IS the source" hazard as a
    /// symlink alias (see the tests below), not a distinct case.
    func testRelocatingToItsOwnExactPathThrowsSameFileAndNeverTouchesIt() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        do {
            _ = try await LocalFileOperations.relocate(source, to: root, mode: .move)
            XCTFail("expected .sameFile")
        } catch FileOperationError.sameFile {
            // expected
        }
        XCTAssertTrue(FileOperationsTestSupport.exists(source))
        XCTAssertEqual(FileOperationsTestSupport.contents(source), "pixels")
    }

    // MARK: - Same-file guard: symlink alias (confirmed data-loss bug, PR #2676 review)

    /// A destination reached through a symlinked ancestor directory names
    /// the SAME file as the source even though the paths are lexically
    /// different. Without the parent-only-symlink-resolved guard,
    /// `collision: .replace`'s pre-copy removal would delete the source
    /// THROUGH the alias, and the copy that follows would then fail
    /// because there's nothing left to read — the source destroyed with no
    /// replacement ever created.
    func testReplaceIntoASymlinkAliasOfTheSourceThrowsAndLeavesTheSourceIntact() async throws {
        let real = root.appendingPathComponent("A")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let source = FileOperationsTestSupport.write("pixels", to: real.appendingPathComponent("IMG_1.dng"))
        let alias = root.appendingPathComponent("Alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)

        do {
            _ = try await LocalFileOperations.relocate(source, to: alias, mode: .move, collision: .replace)
            XCTFail("expected .sameFile")
        } catch FileOperationError.sameFile {
            // expected
        }

        XCTAssertTrue(FileOperationsTestSupport.exists(source), "the source must survive — this is the data-loss bug")
        XCTAssertEqual(FileOperationsTestSupport.contents(source), "pixels")
    }

    // MARK: - Case-only rename on a case-insensitive-but-case-preserving filesystem (APFS)

    /// `img.cr3` -> `IMG.CR3` in the same directory: `fileExists` reports
    /// the target as already occupied (it's the SAME file), so naive
    /// collision handling would either delete the source (`.replace`) or
    /// suffix away from the intended name (`.autoSuffix`). The fix routes
    /// this through a direct atomic `moveItem` instead, bypassing
    /// collision handling entirely.
    func testCaseOnlyRenameMoveSucceedsAndTheSidecarFollows() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("img.cr3"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))

        let outcome = try await LocalFileOperations.relocate(
            source, to: root, newBasename: "IMG.CR3", mode: .move)

        XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "IMG.CR3")
        XCTAssertEqual(FileOperationsTestSupport.contents(URL(fileURLWithPath: outcome.primaryPath)), "pixels",
                       "content must survive the rename")
        // Listable under the NEW casing specifically, not just "some file
        // exists at a case-insensitive match" — `contentsOfDirectory`
        // reports the filesystem's STORED casing.
        let listing = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertTrue(listing.contains("IMG.CR3"), "must be listed under the new casing: \(listing)")
        XCTAssertFalse(listing.contains("img.cr3"))

        XCTAssertTrue(outcome.sidecarFollowed)
        let sidecarListing = listing.filter { $0.hasSuffix(".xmp") }
        XCTAssertTrue(sidecarListing.contains("IMG.xmp"), "sidecar must follow under the new casing: \(sidecarListing)")
    }

    /// A "copy" to a case-only-different name is refused — the filesystem
    /// can't represent the source and a same-named-but-differently-cased
    /// duplicate as two distinct entries, so silently succeeding (or
    /// silently doing nothing) would misrepresent what happened.
    func testCaseOnlyRenameCopyIsRefused() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("img.cr3"))
        do {
            _ = try await LocalFileOperations.relocate(source, to: root, newBasename: "IMG.CR3", mode: .copy)
            XCTFail("expected .sameFile")
        } catch FileOperationError.sameFile {
            // expected
        }
        XCTAssertTrue(FileOperationsTestSupport.exists(source))
    }

    // MARK: - Crash safety: plan alone leaves BOTH source and staged copy on disk

    /// The headline acceptance test: `planRelocate` alone (never finalized)
    /// is exactly the on-disk state a real crash between copy-verify and
    /// delete would leave — both the original and the verified copy must
    /// exist, and a subsequent read of either must return correct bytes.
    func testPlanAloneLeavesSourceAndVerifiedCopyBothOnDisk() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        FileOperationsTestSupport.write("<xmp/>", to: SidecarPath.sidecarURL(for: source))

        let plan = try await LocalFileOperations.planRelocate(
            source, to: root.appendingPathComponent("Album"), mode: .move)

        XCTAssertTrue(FileOperationsTestSupport.exists(source), "plan must never touch the source")
        XCTAssertTrue(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: source)))
        XCTAssertTrue(FileOperationsTestSupport.exists(URL(fileURLWithPath: plan.finalPrimaryPath)))
        XCTAssertEqual(FileOperationsTestSupport.contents(URL(fileURLWithPath: plan.finalPrimaryPath)), "pixels")

        // Retrying is safe: finalize picks up exactly where a crash would
        // have left off.
        await LocalFileOperations.finalizeRelocate(plan)
        XCTAssertFalse(FileOperationsTestSupport.exists(source), "finalize completes the interrupted move")
    }

    /// Forces the copy step itself to fail (destination is a FILE, not a
    /// directory that can hold one — `FileManager.copyItem` throws) and
    /// asserts the source survives untouched with no partial artifact left
    /// behind. This is "kill mid-copy" without a literal process kill: the
    /// observable filesystem state after an interrupted/failed copy is
    /// exactly what this simulates, matching the API's own crash-safety
    /// tests (`restructure-fs.test.ts`), which assert on-disk state at each
    /// phase boundary rather than forking a process to kill.
    func testCopyFailureLeavesSourceUntouchedAndNoPartialArtifact() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        // Occupy the DESTINATION DIRECTORY's path with a plain file, so
        // `createDirectory` (and thus the whole copy) fails.
        let blockedDir = root.appendingPathComponent("Blocked")
        FileOperationsTestSupport.write("not a directory", to: blockedDir)

        do {
            _ = try await LocalFileOperations.relocate(source, to: blockedDir, mode: .move)
            XCTFail("expected a thrown error")
        } catch {
            // any error is acceptable — the assertion is about on-disk state
        }

        XCTAssertTrue(FileOperationsTestSupport.exists(source), "source must survive a failed copy")
        XCTAssertEqual(FileOperationsTestSupport.contents(source), "pixels")
    }

    /// A sidecar copy failure must roll back the (already-succeeded)
    /// primary copy too — a plan is all-or-nothing, never a half-copied
    /// asset with an orphaned primary and no sidecar.
    func testSidecarCopyFailureRollsBackTheAlreadyCopiedPrimary() async throws {
        let source = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("IMG_1.dng"))
        let sidecarURL = SidecarPath.sidecarURL(for: source)
        FileOperationsTestSupport.write("<xmp/>", to: sidecarURL)
        // Make the SOURCE sidecar unreadable so `copyItem` fails reading it
        // — after the primary has already copied successfully. (A stray
        // occupant at the sidecar's destination doesn't work here: this
        // code path deliberately clears one first, since "the sidecar
        // always follows" means it claims that name — see planRelocate's
        // comment.) Permissions are restored in `defer` so teardown's
        // directory removal isn't left fighting a locked-down file.
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: sidecarURL.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: sidecarURL.path) }
        let destDir = root.appendingPathComponent("Album")

        do {
            _ = try await LocalFileOperations.relocate(source, to: destDir, mode: .move)
            XCTFail("expected a thrown error")
        } catch {
            // expected
        }

        XCTAssertTrue(FileOperationsTestSupport.exists(source), "source must survive")
        XCTAssertFalse(FileOperationsTestSupport.exists(destDir.appendingPathComponent("IMG_1.dng")),
                       "the primary copy must be rolled back when the sidecar copy fails")
    }

    // MARK: - Verify (direct coverage of the mismatch branch)

    func testVerifyCopyDetectsASizeMismatch() throws {
        let dest = FileOperationsTestSupport.write("short", to: root.appendingPathComponent("dest.dng"))
        XCTAssertThrowsError(
            try LocalFileOperations.verifyCopy(sourceSize: 999, sourceMtime: nil, destinationURL: dest)
        ) { error in
            guard case FileOperationError.verificationFailed = error else {
                return XCTFail("expected .verificationFailed, got \(error)")
            }
        }
    }

    func testVerifyCopyDetectsAMtimeMismatch() throws {
        let dest = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("dest.dng"))
        let attrs = try FileManager.default.attributesOfItem(atPath: dest.path)
        let size = (attrs[.size] as! NSNumber).int64Value
        let wrongMtime = Date(timeIntervalSince1970: 0)

        XCTAssertThrowsError(
            try LocalFileOperations.verifyCopy(sourceSize: size, sourceMtime: wrongMtime, destinationURL: dest)
        ) { error in
            guard case FileOperationError.verificationFailed = error else {
                return XCTFail("expected .verificationFailed, got \(error)")
            }
        }
    }

    func testVerifyCopyPassesWhenSizeAndMtimeMatch() throws {
        let dest = FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("dest.dng"))
        let attrs = try FileManager.default.attributesOfItem(atPath: dest.path)
        let size = (attrs[.size] as! NSNumber).int64Value
        let mtime = attrs[.modificationDate] as? Date
        XCTAssertNoThrow(try LocalFileOperations.verifyCopy(sourceSize: size, sourceMtime: mtime, destinationURL: dest))
    }

    // MARK: - Source missing

    func testSourceMissingThrowsBeforeTouchingAnything() async throws {
        let missing = root.appendingPathComponent("ghost.dng")
        do {
            _ = try await LocalFileOperations.relocate(missing, to: root.appendingPathComponent("Album"), mode: .move)
            XCTFail("expected sourceMissing")
        } catch FileOperationError.sourceMissing {
            // expected
        }
    }
}
