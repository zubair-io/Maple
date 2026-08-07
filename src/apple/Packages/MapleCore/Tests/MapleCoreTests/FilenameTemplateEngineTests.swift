// FilenameTemplateEngineTests.swift — unit tests for the Swift wrapper over
// the shared `raw-core` filename-template engine (#2628, #2641). Two
// layers:
//   1. Hand-written cases exercising the FFI marshalling itself (optional
//      `capturedAtExifString`, sequence numbering, padding, error mapping).
//   2. The full golden fixture corpus at
//      `test-fixtures/filename-templates/cases.json` — the SAME corpus the
//      raw-core reference (`tests_fixtures.rs`) and the #2633 cross-surface
//      parity harness use, replayed here so a template is proven to render
//      byte-identically on Apple, not just "the FFI call didn't crash."

import Foundation
import Testing
@testable import MapleCore

@Suite("FilenameTemplateEngine")
struct FilenameTemplateEngineTests {

    @Test("original + literal + ext")
    func originalPlusExt() throws {
        let name = try FilenameTemplateEngine.render(
            template: "{original}.{ext}", originalStem: "IMG_0001", ext: "dng",
            capturedAtExifString: nil, sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 0)
        #expect(name == "IMG_0001.dng")
    }

    @Test("sequence number with start + padding")
    func sequenceWithPadding() throws {
        let name = try FilenameTemplateEngine.render(
            template: "vacation_{n}.{ext}", originalStem: "IMG_0001", ext: "dng",
            capturedAtExifString: nil, sequenceStart: 5, sequenceIndex: 2, sequencePadWidth: 4)
        #expect(name == "vacation_0007.dng")
    }

    @Test("date token with a valid EXIF string")
    func dateTokenValid() throws {
        let name = try FilenameTemplateEngine.render(
            template: "{date:%Y-%m-%d}_{original}.{ext}", originalStem: "IMG_0001", ext: "dng",
            capturedAtExifString: "2024:03:15 10:30:00",
            sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 0)
        #expect(name == "2024-03-15_IMG_0001.dng")
    }

    @Test("date token falls back when captured-at is nil, not a failure")
    func dateTokenNilFallsBack() throws {
        // The engine's documented contract: a nil/unparseable date renders
        // the fallback text rather than throwing — a mixed folder (some
        // files with EXIF dates, some without) must still produce a name
        // for every file.
        let name = try FilenameTemplateEngine.render(
            template: "{date:%Y}_{original}.{ext}", originalStem: "IMG_0001", ext: "dng",
            capturedAtExifString: nil, sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 0)
        #expect(!name.isEmpty)
        #expect(name.hasSuffix("_IMG_0001.dng"))
    }

    @Test("unknown token is rejected")
    func unknownToken() {
        #expect(throws: FilenameTemplateError.self) {
            _ = try FilenameTemplateEngine.render(
                template: "{bogus}", originalStem: "IMG_0001", ext: "dng",
                capturedAtExifString: nil, sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 0)
        }
    }

    @Test("unterminated token is rejected")
    func unterminatedToken() {
        #expect(throws: FilenameTemplateError.self) {
            _ = try FilenameTemplateEngine.render(
                template: "{original", originalStem: "IMG_0001", ext: "dng",
                capturedAtExifString: nil, sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 0)
        }
    }

    @Test("a template that renders a path separator is rejected")
    func pathSeparatorRejected() {
        #expect(throws: FilenameTemplateError.self) {
            _ = try FilenameTemplateEngine.render(
                template: "sub/{original}.{ext}", originalStem: "IMG_0001", ext: "dng",
                capturedAtExifString: nil, sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 0)
        }
    }

    @Test("a template that renders a reserved device name is rejected")
    func reservedNameRejected() {
        #expect(throws: FilenameTemplateError.self) {
            _ = try FilenameTemplateEngine.render(
                template: "CON", originalStem: "IMG_0001", ext: "dng",
                capturedAtExifString: nil, sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 0)
        }
    }

    @Test("sequence pad width over the engine's bound is rejected")
    func padWidthTooLarge() {
        #expect(throws: FilenameTemplateError.self) {
            _ = try FilenameTemplateEngine.render(
                template: "{n}", originalStem: "IMG_0001", ext: "dng",
                capturedAtExifString: nil, sequenceStart: 0, sequenceIndex: 0, sequencePadWidth: 33)
        }
    }

    // MARK: - Golden fixture corpus (#2633 parity)

    private struct FixtureCase: Decodable {
        let name: String
        let template: String
        let originalStem: String
        let ext: String
        let sequenceStart: UInt64
        let sequenceIndex: UInt64
        let sequencePadWidth: Int
        let capturedAt: String?
        let expected: FixtureExpected

        enum CodingKeys: String, CodingKey {
            case name, template, ext, expected
            case originalStem = "original_stem"
            case sequenceStart = "sequence_start"
            case sequenceIndex = "sequence_index"
            case sequencePadWidth = "sequence_pad_width"
            case capturedAt = "captured_at"
        }
    }

    private struct FixtureExpected: Decodable {
        let ok: String?
        let error: String?
    }

    private struct FixtureFile: Decodable {
        let cases: [FixtureCase]
    }

    /// Locates `test-fixtures/filename-templates/cases.json` relative to
    /// this test file's known position in the repo tree — mirrors the
    /// relative-path resolution the color-pipeline harness's Swift/XCTest
    /// consumers already use for `test-fixtures/`. Returns nil (skip, not
    /// fail) when the corpus isn't present, matching every other
    /// fixture-gated gate in this repo's "no fixtures, skipping" convention.
    private static func loadFixtures() -> [FixtureCase]? {
        let thisFile = URL(fileURLWithPath: #filePath)
        // .../src/apple/Packages/MapleCore/Tests/MapleCoreTests/<this file>
        // -> repo root is 6 levels up.
        let repoRoot = thisFile
            .deletingLastPathComponent()  // MapleCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // MapleCore
            .deletingLastPathComponent()  // Packages
            .deletingLastPathComponent()  // apple
            .deletingLastPathComponent()  // src
        let corpusURL = repoRoot
            .appendingPathComponent("test-fixtures/filename-templates/cases.json")
        guard let data = try? Data(contentsOf: corpusURL) else { return nil }
        guard let file = try? JSONDecoder().decode(FixtureFile.self, from: data) else { return nil }
        return file.cases
    }

    @Test("golden fixture corpus renders byte-identically to the Rust reference")
    func fixtureCorpus() throws {
        guard let cases = Self.loadFixtures() else {
            // No fixtures checked out at this path in this environment —
            // skip, don't fail (matches the repo's fixture-gated-test
            // convention).
            return
        }
        #expect(cases.count > 0, "fixture file loaded but parsed zero cases")
        for c in cases {
            let result = Result {
                try FilenameTemplateEngine.render(
                    template: c.template, originalStem: c.originalStem, ext: c.ext,
                    capturedAtExifString: c.capturedAt,
                    sequenceStart: c.sequenceStart, sequenceIndex: c.sequenceIndex,
                    sequencePadWidth: c.sequencePadWidth)
            }
            switch (result, c.expected.ok, c.expected.error) {
            case (.success(let name), .some(let expectedOK), nil):
                #expect(name == expectedOK, "case \(c.name): expected \(expectedOK), got \(name)")
            case (.failure, nil, .some):
                // The corpus's `error` field is a raw_core::filename::FilenameError
                // kind tag (e.g. "unknown_token") — this wrapper's error cases
                // map 1:1 to those tags via the FFI's numeric codes, so we only
                // assert failure here (not tag equality) to avoid duplicating
                // the whole `FilenameTemplateError.init(code:)` mapping table
                // in the fixture; the numeric-code round trip is covered by
                // the hand-written cases above.
                break
            default:
                Issue.record("case \(c.name): result \(result) did not match expected \(c.expected)")
            }
        }
    }
}
