// LensProfileChoiceTests.swift — the Apple Lens Corrections panel's
// profile dropdown (#3567, bundled-Lensfun epic #3564 slice 3).
//
// Covers only the pure parts, per the ticket: JSON → `Evidence`/
// `CompatibleLens` decoding, `LensProfileChoice.build`'s option ordering
// and source-line text, and that `select(_:)` writes exactly the expected
// `model.lensProfile` value as one undoable edit without touching the
// master toggle. None of this touches raw-ffi or a RAW fixture — every
// input is a literal JSON string or an in-memory `EditSession.preview()`
// (bytes-backed, no on-disk path) — so this class needs no fixture and is
// listed in `.github/swift-regressions/run.txt`, not `excluded.txt`.

import XCTest
@testable import MapleCore

@MainActor
final class LensProfileChoiceTests: XCTestCase {

    // MARK: - Evidence / CompatibleLens decoding

    func testEvidenceDecodesLensfunMatch() throws {
        let json = """
            {"source":"lensfun","lens":"Sony FE 24-70mm f/4 ZA OSS","dbVersion":"12f5976 (2026-09-11)",
             "confidence":"in-range","hasDistortion":true,"hasCa":true,"hasVignetting":true,
             "approximations":[],"unsupported":[]}
            """
        let evidence = try LensProfileChoice.Evidence.decode(json)
        XCTAssertEqual(evidence.source, "lensfun")
        XCTAssertEqual(evidence.lens, "Sony FE 24-70mm f/4 ZA OSS")
        XCTAssertEqual(evidence.dbVersion, "12f5976 (2026-09-11)")
        XCTAssertEqual(evidence.confidence, "in-range")
        XCTAssertTrue(evidence.hasDistortion && evidence.hasCa && evidence.hasVignetting)
        XCTAssertEqual(evidence.approximations, [])
        XCTAssertEqual(evidence.unsupported, [])
    }

    /// The raw-ffi fallback branch (no external resolution) omits `lens`
    /// and `dbVersion` entirely rather than sending `null` — `Evidence`
    /// must decode that as `nil`, not throw.
    func testEvidenceDecodesEmbeddedFallbackWithAbsentLensAndDbVersion() throws {
        let json = """
            {"source":"embedded","confidence":"embedded","hasDistortion":true,"hasCa":false,
             "hasVignetting":true,"approximations":[],"unsupported":[]}
            """
        let evidence = try LensProfileChoice.Evidence.decode(json)
        XCTAssertEqual(evidence.source, "embedded")
        XCTAssertNil(evidence.lens)
        XCTAssertNil(evidence.dbVersion)
        XCTAssertTrue(evidence.hasDistortion)
        XCTAssertFalse(evidence.hasCa)
        XCTAssertTrue(evidence.hasVignetting)
    }

    func testCompatibleLensDecodesList() throws {
        let json = """
            [{"slug":"sony/fe-24-70mm-f4-za-oss@sony-e","maker":"Sony","model":"FE 24-70mm f/4 ZA OSS"},
             {"slug":"sony/fe-16-35mm-f2.8-gm@sony-e","maker":"Sony","model":"FE 16-35mm F2.8 GM"}]
            """
        let lenses = try LensProfileChoice.CompatibleLens.decodeList(json)
        XCTAssertEqual(lenses.count, 2)
        XCTAssertEqual(lenses[0].maker, "Sony")
        XCTAssertEqual(lenses[0].model, "FE 24-70mm f/4 ZA OSS")
        XCTAssertEqual(lenses[1].slug, "sony/fe-16-35mm-f2.8-gm@sony-e")
    }

    // MARK: - build: option ordering

    func testBuildOrdersAutomaticFirstThenCompatibleSortedByMakerModel() {
        let auto = matchedEvidence(lens: "Sony FE 24-70mm f/4 ZA OSS")
        let compatible = [
            LensProfileChoice.CompatibleLens(slug: "sony/fe-70-200mm-f2.8-gm@sony-e", maker: "Sony", model: "FE 70-200mm F2.8 GM"),
            LensProfileChoice.CompatibleLens(slug: "sony/fe-16-35mm-f2.8-gm@sony-e", maker: "Sony", model: "FE 16-35mm F2.8 GM"),
            LensProfileChoice.CompatibleLens(slug: "canon/rf-24-70mm-f2.8@rf", maker: "Canon", model: "RF 24-70mm F2.8"),
        ]
        let built = LensProfileChoice.build(
            reference: "", autoEvidence: auto, currentEvidence: auto, compatible: compatible)

        XCTAssertEqual(built.options.map(\.label), [
            "Automatic — Sony FE 24-70mm f/4 ZA OSS",
            "Canon RF 24-70mm F2.8",
            "Sony FE 16-35mm F2.8 GM",
            "Sony FE 70-200mm F2.8 GM",
        ])
    }

    func testBuildAutomaticNoMatchLabel() {
        let auto = LensProfileChoice.Evidence.unavailable
        let built = LensProfileChoice.build(
            reference: "", autoEvidence: auto, currentEvidence: auto, compatible: [])
        XCTAssertEqual(built.options.first?.label, "Automatic — no match")
        XCTAssertEqual(built.selection, .automatic(matched: nil))
    }

    func testBuildAutomaticSelectionCarriesMatchedName() {
        let auto = matchedEvidence(lens: "Sony FE 24-70mm f/4 ZA OSS")
        let built = LensProfileChoice.build(
            reference: "", autoEvidence: auto, currentEvidence: auto, compatible: [])
        XCTAssertEqual(built.selection, .automatic(matched: "Sony FE 24-70mm f/4 ZA OSS"))
    }

    // MARK: - build: manual bundled pick

    func testBuildBundledSelectionUsesCurrentEvidenceNameAndCoverage() {
        let auto = LensProfileChoice.Evidence.unavailable
        let current = LensProfileChoice.Evidence(
            source: "lensfun", lens: "Sony FE 24-70mm f/4 ZA OSS", dbVersion: "12f5976 (2026-09-11)",
            confidence: "in-range", hasDistortion: true, hasCa: false, hasVignetting: true,
            approximations: [], unsupported: [])
        let compatible = [
            LensProfileChoice.CompatibleLens(
                slug: "sony/fe-24-70mm-f4-za-oss@sony-e", maker: "Sony", model: "FE 24-70mm f/4 ZA OSS")
        ]
        let built = LensProfileChoice.build(
            reference: "lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e", autoEvidence: auto,
            currentEvidence: current, compatible: compatible)

        XCTAssertEqual(
            built.selection,
            .bundled(slug: "sony/fe-24-70mm-f4-za-oss@sony-e", name: "Sony FE 24-70mm f/4 ZA OSS"))
        XCTAssertEqual(built.coverage, LensProfileChoice.Coverage(hasDistortion: true, hasCa: false, hasVignetting: true))
        XCTAssertEqual(built.sourceDescription, "Lensfun database 12f5976 (2026-09-11) · CC BY-SA 3.0")
        // The picked lens must not be duplicated: it's already one of `compatible`.
        XCTAssertEqual(built.options.count, 2)  // Automatic + the one bundled lens
    }

    func testBuildAppendsSelectedSlugDefensivelyWhenMissingFromCompatibleList() {
        let auto = LensProfileChoice.Evidence.unavailable
        let current = LensProfileChoice.Evidence(
            source: "lensfun", lens: "Sigma 24mm f/1.4 DG HSM", dbVersion: "12f5976 (2026-09-11)",
            confidence: "in-range", hasDistortion: true, hasCa: true, hasVignetting: true,
            approximations: [], unsupported: [])
        let built = LensProfileChoice.build(
            reference: "lensfun1:sigma/24mm-f1.4-dg-hsm@sony-e", autoEvidence: auto, currentEvidence: current,
            compatible: [])
        XCTAssertTrue(built.options.contains { $0.modelValue == "lensfun1:sigma/24mm-f1.4-dg-hsm@sony-e" })
        XCTAssertEqual(built.selection, .bundled(slug: "sigma/24mm-f1.4-dg-hsm@sony-e", name: "Sigma 24mm f/1.4 DG HSM"))
    }

    // MARK: - build: imported LCP reference

    func testBuildImportedSelectionAppendsImportedOptionAndSourceLine() {
        let digest = String(repeating: "a", count: 64)
        let reference = "lcp1:\(digest)"
        let auto = LensProfileChoice.Evidence.unavailable
        let current = LensProfileChoice.Evidence(
            source: "lcp", lens: nil, dbVersion: nil, confidence: "in-range",
            hasDistortion: true, hasCa: true, hasVignetting: false, approximations: [], unsupported: [])
        let built = LensProfileChoice.build(
            reference: reference, autoEvidence: auto, currentEvidence: current, compatible: [])

        XCTAssertEqual(built.selection, .imported(reference: reference))
        XCTAssertTrue(built.options.contains { $0.modelValue == reference && $0.label == "Imported profile" })
        XCTAssertEqual(built.sourceDescription, "Imported profile")
        XCTAssertEqual(built.coverage, LensProfileChoice.Coverage(hasDistortion: true, hasCa: true, hasVignetting: false))
    }

    // MARK: - build: source line per evidence source

    func testBuildSourceDescriptionPerSource() {
        let cases: [(String, String)] = [
            ("embedded", "Embedded corrections"),
            ("none", "No lens correction data"),
        ]
        for (source, expected) in cases {
            let evidence = LensProfileChoice.Evidence(
                source: source, lens: nil, dbVersion: nil, confidence: nil,
                hasDistortion: false, hasCa: false, hasVignetting: false, approximations: [], unsupported: [])
            let built = LensProfileChoice.build(
                reference: "", autoEvidence: evidence, currentEvidence: evidence, compatible: [])
            XCTAssertEqual(built.sourceDescription, expected, "source=\(source)")
        }
    }

    // MARK: - select(_:) — undoable edit, master toggle untouched

    func testSelectWritesExactLensProfileValueAsOneUndoableEdit() {
        let session = EditSession.preview()
        XCTAssertEqual(session.model.lensProfile, "")
        XCTAssertFalse(session.canUndo)

        let choice = LensProfileChoice(session: session)
        let option = LensProfileChoice.Option(
            id: "lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e", label: "Sony FE 24-70mm f/4 ZA OSS",
            modelValue: "lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e")
        choice.select(option)

        XCTAssertEqual(session.model.lensProfile, "lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e")
        XCTAssertTrue(session.canUndo)

        session.undo()
        XCTAssertEqual(session.model.lensProfile, "")
    }

    func testSelectDoesNotTouchTheMasterToggle() {
        let session = EditSession.preview()
        let before = session.model.lensProfileEnable

        let choice = LensProfileChoice(session: session)
        choice.select(
            LensProfileChoice.Option(id: "automatic", label: "Automatic", modelValue: ""))

        XCTAssertEqual(session.model.lensProfileEnable, before)
    }

    func testSelectAutomaticWritesEmptyString() {
        let session = EditSession.preview()
        session.model.lensProfile = "lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e"

        let choice = LensProfileChoice(session: session)
        choice.select(LensProfileChoice.Option(id: "automatic", label: "Automatic", modelValue: ""))

        XCTAssertEqual(session.model.lensProfile, "")
    }

    // MARK: - Helpers

    private func matchedEvidence(lens: String) -> LensProfileChoice.Evidence {
        LensProfileChoice.Evidence(
            source: "lensfun", lens: lens, dbVersion: "12f5976 (2026-09-11)", confidence: "in-range",
            hasDistortion: true, hasCa: true, hasVignetting: true, approximations: [], unsupported: [])
    }
}
