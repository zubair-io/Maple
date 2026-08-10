// ExternalRenameMatcherTests.swift — hard unit tests for the pure
// same-folder external-rename matcher (issue #2656). No disk I/O: every
// candidate is a hand-built `ExternalRenameFingerprint`, so these tests run
// the mandatory false-positive guard directly and deterministically.

import XCTest
@testable import MapleCore

final class ExternalRenameMatcherTests: XCTestCase {

    private func fp(size: Int64, dto: String, serial: String? = nil) -> ExternalRenameFingerprint {
        ExternalRenameFingerprint(size: size, dateTimeOriginal: dto, cameraSerial: serial)
    }

    private func candidate(_ path: String, _ fingerprint: ExternalRenameFingerprint) -> ExternalRenameMatcher.Candidate {
        ExternalRenameMatcher.Candidate(path: path, fingerprint: fingerprint)
    }

    // MARK: - Exactly-one-candidate match

    func testExactlyOneCandidateOnEachSideMatches() {
        let shared = fp(size: 1000, dto: "2026:01:01 12:00:00", serial: "SN1")
        let missing = [candidate("/A/IMG_1.dng", shared)]
        let new = [candidate("/A/IMG_2.dng", shared)]

        let matches = ExternalRenameMatcher.match(missing: missing, new: new)

        XCTAssertEqual(matches, [ExternalRenameMatcher.Match(oldPath: "/A/IMG_1.dng", newPath: "/A/IMG_2.dng")])
    }

    func testCameraSerialIsNotRequiredToMatch() {
        // Many cameras never write a body serial number — a fingerprint
        // with `cameraSerial == nil` on both sides must still match on
        // size + DateTimeOriginal alone.
        let shared = fp(size: 500, dto: "2026:02:02 08:30:00")
        let matches = ExternalRenameMatcher.match(
            missing: [candidate("/A/old.cr2", shared)],
            new: [candidate("/A/new.cr2", shared)])

        XCTAssertEqual(matches, [ExternalRenameMatcher.Match(oldPath: "/A/old.cr2", newPath: "/A/new.cr2")])
    }

    // MARK: - MANDATORY false-positive guard

    func testTwoDifferentPhotosSharingOnlySizeNeverMerge() {
        // Same size, DIFFERENT capture timestamps — the exact false-positive
        // shape the fingerprint's DateTimeOriginal component exists to
        // catch. Must decline, not guess.
        let missing = [candidate("/A/beach.dng", fp(size: 2_000_000, dto: "2026:03:01 09:00:00"))]
        let new = [candidate("/A/mountain.dng", fp(size: 2_000_000, dto: "2026:03:15 14:00:00"))]

        XCTAssertTrue(ExternalRenameMatcher.match(missing: missing, new: new).isEmpty)
    }

    func testTwoMissingCandidatesWithTheSameFingerprintDeclineForThatFingerprint() {
        // Two different photos happened to disappear with an identical
        // (size, DateTimeOriginal, serial) fingerprint — ambiguous which
        // one the single new file actually is. Must decline rather than
        // guess and silently attach the wrong edits.
        let shared = fp(size: 1234, dto: "2026:04:04 10:00:00", serial: "SN9")
        let missing = [
            candidate("/A/one.dng", shared),
            candidate("/A/two.dng", shared),
        ]
        let new = [candidate("/A/renamed.dng", shared)]

        XCTAssertTrue(ExternalRenameMatcher.match(missing: missing, new: new).isEmpty)
    }

    func testTwoNewCandidatesWithTheSameFingerprintDeclineForThatFingerprint() {
        // Symmetric case: one file vanished, but TWO new files share its
        // fingerprint — ambiguous which one it became.
        let shared = fp(size: 4321, dto: "2026:05:05 11:00:00")
        let missing = [candidate("/A/original.dng", shared)]
        let new = [
            candidate("/A/candidateA.dng", shared),
            candidate("/A/candidateB.dng", shared),
        ]

        XCTAssertTrue(ExternalRenameMatcher.match(missing: missing, new: new).isEmpty)
    }

    func testAmbiguousFingerprintDoesNotBlockAnUnrelatedUnambiguousMatchInTheSameCall() {
        let ambiguous = fp(size: 100, dto: "2026:06:06 06:00:00")
        let clean = fp(size: 200, dto: "2026:06:06 07:00:00")

        let missing = [
            candidate("/A/dupe1.dng", ambiguous),
            candidate("/A/dupe2.dng", ambiguous),
            candidate("/A/clean-old.dng", clean),
        ]
        let new = [
            candidate("/A/dupe-new.dng", ambiguous),
            candidate("/A/clean-new.dng", clean),
        ]

        let matches = ExternalRenameMatcher.match(missing: missing, new: new)

        XCTAssertEqual(matches, [ExternalRenameMatcher.Match(oldPath: "/A/clean-old.dng", newPath: "/A/clean-new.dng")])
    }

    // MARK: - No candidates on one side

    func testNoNewCandidatesProducesNoMatches() {
        let missing = [candidate("/A/gone.dng", fp(size: 10, dto: "2026:07:07 00:00:00"))]
        XCTAssertTrue(ExternalRenameMatcher.match(missing: missing, new: []).isEmpty)
    }

    func testNoMissingCandidatesProducesNoMatches() {
        let new = [candidate("/A/appeared.dng", fp(size: 10, dto: "2026:07:07 00:00:00"))]
        XCTAssertTrue(ExternalRenameMatcher.match(missing: [], new: new).isEmpty)
    }

    func testEmptyInputsProduceNoMatches() {
        XCTAssertTrue(ExternalRenameMatcher.match(missing: [], new: []).isEmpty)
    }

    // MARK: - Deterministic ordering

    func testMultipleUnambiguousMatchesAreSortedByOldPath() {
        let fpB = fp(size: 1, dto: "2026:08:08 01:00:00")
        let fpA = fp(size: 2, dto: "2026:08:08 02:00:00")
        let missing = [
            candidate("/A/z-old.dng", fpB),
            candidate("/A/a-old.dng", fpA),
        ]
        let new = [
            candidate("/A/z-new.dng", fpB),
            candidate("/A/a-new.dng", fpA),
        ]

        let matches = ExternalRenameMatcher.match(missing: missing, new: new)

        XCTAssertEqual(matches.map(\.oldPath), ["/A/a-old.dng", "/A/z-old.dng"])
    }
}
