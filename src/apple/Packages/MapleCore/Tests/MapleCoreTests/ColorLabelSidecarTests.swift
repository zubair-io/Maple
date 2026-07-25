// ColorLabelSidecarTests.swift — color-label parity for the Apple batch
// culling path (#1656). Two halves:
//
//   1. The XMP wire contract: `papp:ColorLabel` is written by the Swift
//      serializer and read back by the Swift parser, through a real `.xmp`
//      file on disk in a temp directory. CLAUDE.md forbids mocking the
//      sidecar layer — XMP is the contract.
//   2. `BatchMetadataViewModel`: touched-field application, explicit clear,
//      mixed-value detection, and the `commonColorLabel` accessor across a
//      multi-asset selection.
//
// Lives in its own file rather than in `BatchMetadataViewModelTests.swift`,
// which is already at 511 lines against CONTRIBUTING.md's 600-line budget.

import XCTest
@testable import MapleCore

@MainActor
final class ColorLabelSidecarTests: XCTestCase {

    // MARK: - Helpers

    /// Write a real sidecar next to a temp DNG URL and return the asset ref
    /// plus the store (whose `url` is the `.xmp` path). No mocks: every
    /// assertion below reads bytes that actually landed on disk.
    private func tempAsset(
        model: AdjustmentModel = .default,
        culling: CullingState = CullingState()
    ) async throws -> (AssetRef, XMPSidecarStore) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let store = XMPSidecarStore(rawURL: url)
        await store.update(model: model, culling: culling)
        await store.flush()
        return (AssetRef(url: url), store)
    }

    // MARK: - XMP wire contract

    /// The headline round trip: a color label set in memory reaches a real
    /// `.xmp` on disk as `papp:ColorLabel`, and parses back to the same case.
    func testColorLabelRoundTripsThroughSidecarOnDisk() async throws {
        let (_, store) = try await tempAsset(
            culling: CullingState(stars: 3, flag: .pick, colorLabel: .purple)
        )
        let sidecarURL = await store.url

        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(
            xml.contains("papp:ColorLabel=\"purple\""),
            "Sidecar must carry the lowercase papp:ColorLabel attribute the web/API path reads. Got:\n\(xml)"
        )

        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.colorLabel, .purple, "papp:ColorLabel must parse back to the same label")
        XCTAssertEqual(parsed.stars, 3, "Color label must not disturb the rating round trip")
        XCTAssertEqual(parsed.flag, .pick, "Color label must not disturb the flag round trip")
    }

    /// Every color in the #1657 six-color vocabulary survives a disk round
    /// trip — including `orange` (kept for existing data) and `purple` (made
    /// reachable by that ticket).
    func testEveryVocabularyColorRoundTrips() async throws {
        for label in ColorLabel.allCases {
            let (_, store) = try await tempAsset(culling: CullingState(colorLabel: label))
            let sidecarURL = await store.url
            let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
            XCTAssertTrue(
                xml.contains("papp:ColorLabel=\"\(label.rawValue)\""),
                "\(label.rawValue) must serialize as its lowercase wire value"
            )
            let (_, parsed) = try XMPParser.parse(xml)
            XCTAssertEqual(parsed.colorLabel, label, "\(label.rawValue) must survive the round trip")
        }
    }

    /// The wire vocabulary is byte-identical to the TypeScript single sources
    /// (`src/api/src/xmp/color-label.ts`,
    /// `src/web/projects/maple-common/src/lib/models/color-label.ts`). A
    /// rename or reorder on either side breaks cross-platform reads, so the
    /// list is pinned here rather than derived from the enum.
    func testWireVocabularyMatchesTypeScriptSingleSources() {
        XCTAssertEqual(
            ColorLabel.allCases.map(\.rawValue),
            ["red", "orange", "yellow", "green", "blue", "purple"],
            "Swift vocabulary must stay in lockstep with the API and web color-label modules"
        )
    }

    /// Absence means "no label" — the attribute is omitted entirely rather
    /// than written empty, matching the spec § 01 "only when set" emit rule.
    func testUnlabelledSidecarOmitsTheAttribute() async throws {
        let (_, store) = try await tempAsset(culling: CullingState())
        let sidecarURL = await store.url

        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertFalse(xml.contains("papp:ColorLabel"), "An unset label must emit no attribute at all")

        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertNil(parsed.colorLabel, "A sidecar with no papp:ColorLabel must parse to nil")
    }

    /// An out-of-vocabulary value leaves the label unset rather than storing
    /// a string the API parser would reject. Mirrors `VALID_COLOR_LABELS`.
    func testUnknownColorLabelValueIsIgnored() throws {
        let xml = """
        <?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:papp="http://ns.justmaple.app/1.0/" papp:ColorLabel="chartreuse"/>
          </rdf:RDF>
        </x:xmpmeta>
        """
        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertNil(parsed.colorLabel, "An unknown color must not be stored")
    }

    /// Apple overloads `xmp:Label` for the pick/reject flag, so it must NOT
    /// also be read as a color — otherwise every Apple-authored pick would
    /// silently acquire a red color label.
    func testXmpLabelStaysTheFlagAndDoesNotBecomeAColorLabel() throws {
        let xml = """
        <?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Label="Red"/>
          </rdf:RDF>
        </x:xmpmeta>
        """
        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.flag, .pick, "xmp:Label=\"Red\" is the pick flag on Apple")
        XCTAssertNil(parsed.colorLabel, "xmp:Label must not leak into the color label")
    }

    /// A `papp:ColorLabel` written alongside a flag round-trips without either
    /// field clobbering the other — the two share an `rdf:Description` but not
    /// an attribute.
    ///
    /// Uses `.reject`, which is the case that used to be lost: the serializer
    /// wrote `xmp:Label="Rejected"` while the parser matched only `"reject"`.
    /// #2221 moved the flag onto the canonical `papp:Flag` key that the API and
    /// web serializers already use, so both flags now round-trip and the
    /// stronger assertion is the honest one here.
    func testColorLabelAndFlagCoexistOnOneSidecar() async throws {
        let (_, store) = try await tempAsset(
            culling: CullingState(flag: .reject, colorLabel: .blue)
        )
        let sidecarURL = await store.url
        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(xml.contains("papp:Flag=\"reject\""), "Flag keeps its own attribute")
        XCTAssertTrue(xml.contains("papp:ColorLabel=\"blue\""), "Label keeps its own attribute")
        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.flag, .reject)
        XCTAssertEqual(parsed.colorLabel, .blue)
    }

    /// The metadata-carrying serializer overload shares `_buildAttrs`, so the
    /// label must survive a sidecar that also holds the IPTC/EXIF block.
    func testColorLabelSurvivesAMetadataCarryingWrite() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let store = XMPSidecarStore(rawURL: url)
        var meta = XmpMetadata()
        meta.city = "Paris"
        await store.update(model: .default,
                           culling: CullingState(colorLabel: .green),
                           metadata: meta)
        await store.flush()

        let sidecarURL = await store.url
        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.colorLabel, .green, "Label must survive the metadata serializer overload")
        XCTAssertEqual(XMPParser.parseMetadata(xml).city, "Paris", "Metadata block must be intact too")
    }

    /// JSON `Codable` compatibility: a payload persisted before `colorLabel`
    /// existed must still decode (the synthesised init would throw).
    func testLegacyJSONWithoutColorLabelDecodes() throws {
        let json = Data(#"{"stars":2,"flag":"pick","keywords":["travel"]}"#.utf8)
        let decoded = try JSONDecoder().decode(CullingState.self, from: json)
        XCTAssertEqual(decoded.stars, 2)
        XCTAssertNil(decoded.colorLabel, "Legacy payloads decode with no label")
    }

    // MARK: - BatchMetadataViewModel

    func testTouchedColorLabelAppliedAcrossSelection() async throws {
        let (a1, s1) = try await tempAsset(culling: CullingState())
        let (a2, s2) = try await tempAsset(culling: CullingState(colorLabel: .red))
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()

        vm.touchedMetadata.colorLabel = .some(.yellow)
        try await vm.apply()

        for store in [s1, s2] {
            let sidecarURL = await store.url
            let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
            let (_, parsed) = try XMPParser.parse(xml)
            XCTAssertEqual(parsed.colorLabel, .yellow,
                           "Touched color label must be written to every selected asset")
        }
    }

    func testTouchedColorLabelExplicitClear() async throws {
        let (asset, store) = try await tempAsset(culling: CullingState(colorLabel: .orange))
        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // `.some(nil)` — the field is touched, and the value applied is "no label".
        vm.touchedMetadata.colorLabel = .some(nil)
        XCTAssertTrue(vm.touchedMetadata.hasTouched, "An explicit clear must count as touched")
        try await vm.apply()

        let sidecarURL = await store.url
        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertFalse(xml.contains("papp:ColorLabel"), "Clearing must remove the attribute from disk")
        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertNil(parsed.colorLabel)
    }

    func testUntouchedColorLabelIsPreserved() async throws {
        let (asset, store) = try await tempAsset(culling: CullingState(colorLabel: .blue))
        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // Touch an unrelated field only.
        vm.touchedMetadata.city = "Lisbon"
        try await vm.apply()

        let sidecarURL = await store.url
        let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
        let (_, parsed) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.colorLabel, .blue, "An untouched color label must not be dropped")
        XCTAssertEqual(XMPParser.parseMetadata(xml).city, "Lisbon")
    }

    func testColorLabelMixedDetected() async throws {
        let (a1, _) = try await tempAsset(culling: CullingState(colorLabel: .red))
        let (a2, _) = try await tempAsset(culling: CullingState(colorLabel: .green))
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()

        XCTAssertTrue(vm.mixedFields.contains(.colorLabel),
                      "Differing color labels must report as mixed")
        XCTAssertNil(vm.commonColorLabel, "commonColorLabel must be nil when mixed")
    }

    /// Labelled vs. unlabelled is also a mixed selection — the optional-to-
    /// optional comparison must not coerce nil into a match.
    func testLabelledAndUnlabelledIsMixed() async throws {
        let (a1, _) = try await tempAsset(culling: CullingState(colorLabel: .red))
        let (a2, _) = try await tempAsset(culling: CullingState())
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()

        XCTAssertTrue(vm.mixedFields.contains(.colorLabel),
                      "A labelled asset alongside an unlabelled one is mixed")
        XCTAssertNil(vm.commonColorLabel)
    }

    func testColorLabelAgreedCommon() async throws {
        let (a1, _) = try await tempAsset(culling: CullingState(colorLabel: .green))
        let (a2, _) = try await tempAsset(culling: CullingState(colorLabel: .green))
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()

        XCTAssertFalse(vm.mixedFields.contains(.colorLabel),
                       "Agreeing color labels must not report as mixed")
        XCTAssertEqual(vm.commonColorLabel, .green)
    }

    /// An all-unlabelled selection agrees on "no label": not mixed, and
    /// `commonColorLabel` is nil because nil IS the shared value.
    func testAllUnlabelledIsNotMixed() async throws {
        let (a1, _) = try await tempAsset(culling: CullingState())
        let (a2, _) = try await tempAsset(culling: CullingState())
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()

        XCTAssertFalse(vm.mixedFields.contains(.colorLabel),
                       "An all-unlabelled selection agrees and must not be mixed")
        XCTAssertNil(vm.commonColorLabel)
    }

    /// Untouched means untouched: `hasTouched` stays false so the sheet's
    /// Apply button remains disabled until the user actually picks something.
    func testColorLabelUntouchedDoesNotMarkTouched() {
        let touched = TouchedMetadata()
        XCTAssertNil(touched.colorLabel)
        XCTAssertFalse(touched.hasTouched)
    }
}
