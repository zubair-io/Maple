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

        let outcome = try await SMBFileOperations.relocate("/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

        let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
        XCTAssertFalse(sourceStillThere)
        let destContents = await t.fileContents(at: outcome.primaryPath)
        XCTAssertEqual(destContents, "pixels")
    }

    func testCopyLeavesSourceIntact() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")

        let outcome = try await SMBFileOperations.relocate("/Source/IMG_1.dng", to: "/Album", mode: .copy, transport: t)

        let sourceStillThere = await t.fileExists(at: "/Source/IMG_1.dng")
        XCTAssertTrue(sourceStillThere)
        XCTAssertNotEqual(outcome.primaryPath, "/Source/IMG_1.dng")
    }

    func testSidecarFollowsThePrimary() async throws {
        let t = FakeSMBTransport()
        await t.seed("pixels", at: "/Source/IMG_1.dng")
        await t.seed("<xmp/>", at: "/Source/IMG_1.xmp")

        let outcome = try await SMBFileOperations.relocate("/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

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

        let outcome = try await SMBFileOperations.relocate("/Source/CLIP.mov", to: "/Album", mode: .move, transport: t)

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

        let plan = try await SMBFileOperations.planRelocate("/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)

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
            _ = try await SMBFileOperations.relocate("/Source/IMG_1.dng", to: "/Album", mode: .move, transport: t)
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
            _ = try await SMBFileOperations.relocate("/Source/ghost.dng", to: "/Album", mode: .move, transport: t)
            XCTFail("expected sourceMissing")
        } catch FileOperationError.sourceMissing {
            // expected
        }
    }
}
