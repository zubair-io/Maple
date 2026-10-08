// XMPRatingLabelPreservationTests.swift — foreign `xmp:Rating` / `xmp:Label`
// spellings survive saves that never touch them (#4403).
//
// A Lightroom reject (`xmp:Rating="-1"`) and a Lightroom colour word
// (`xmp:Label="Blue"`) used to vanish on the first Apple save: both names
// sat in the owned culling set, so they were excluded from passthrough and
// only rewritten in Maple's canonical spelling — which an unrated /
// unflagged model never emits. The contract from #4403 (mirroring the Linux
// shell's `keep_rating` rule) is: a value the user did not change is kept
// exactly as authored, and rewritten only when the user edits that field.
// Reads are unchanged — `xmp:Label` still parses as the legacy flag alias,
// so a kept `Red` still reads as a pick and now also emits the canonical
// `papp:Flag` next to the preserved raw.

import XCTest

@testable import MapleCore

final class XMPRatingLabelPreservationTests: XCTestCase {

    // MARK: - Helpers

    /// Minimal hand-authored sidecar carrying exactly `attrs` on the
    /// `rdf:Description`, mirroring `XMPCullFlagTests.sidecar`.
    private func sidecar(_ attrs: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
         <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:papp="http://ns.justmaple.app/1.0/"
            \(attrs)>
          </rdf:Description>
         </rdf:RDF>
        </x:xmpmeta>
        """
    }

    private func occurrences(of needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    /// Parse → apply `edit` → serialize, threading the passthrough bucket
    /// the way `XMPSidecarStore` does on a real save.
    private func resave(
        _ xml: String,
        edit: (inout AdjustmentModel, inout CullingState) -> Void = { _, _ in }
    ) throws -> String {
        var (model, culling) = try XMPParser.parse(xml)
        edit(&model, &culling)
        return XMPSerializer.serialize(
            model: model, culling: culling,
            passthrough: XMPParser.parsePassthrough(xml))
    }

    private func makeTempRawURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
    }

    // MARK: - Rating preservation

    func testRejectRatingSurvivesUnrelatedEdit() throws {
        let out = try resave(sidecar(#"xmp:Rating="-1""#)) { model, _ in
            model.exposure = 0.5
        }
        XCTAssertTrue(out.contains(#"xmp:Rating="-1""#),
                      "a Lightroom reject must survive an edit that never touches rating")
        XCTAssertEqual(occurrences(of: "xmp:Rating", in: out), 1,
                       "the kept raw must not also emit a canonical twin")
    }

    func testNonIntegerRatingSpellingSurvivesUnedited() throws {
        let out = try resave(sidecar(#"xmp:Rating="3.0""#))
        XCTAssertTrue(out.contains(#"xmp:Rating="3.0""#),
                      "an unparseable-on-Apple spelling must be kept verbatim, not deleted")
        XCTAssertEqual(occurrences(of: "xmp:Rating", in: out), 1)
    }

    func testNonCanonicalSpellingOfASetRatingKeepsAuthoredBytes() throws {
        let out = try resave(sidecar(#"xmp:Rating="03""#))
        XCTAssertTrue(out.contains(#"xmp:Rating="03""#),
                      "an unchanged 3 spelled \"03\" keeps its bytes; it is not normalized to \"3\"")
        XCTAssertEqual(occurrences(of: "xmp:Rating", in: out), 1)
    }

    func testEditedRatingReplacesTheAuthoredSpelling() throws {
        let out = try resave(sidecar(#"xmp:Rating="-1""#)) { _, culling in
            culling.stars = 4
        }
        XCTAssertTrue(out.contains(#"xmp:Rating="4""#))
        XCTAssertFalse(out.contains(#"xmp:Rating="-1""#),
                       "editing the rating rewrites it canonically and drops the raw")
        XCTAssertEqual(occurrences(of: "xmp:Rating", in: out), 1)
    }

    func testClearedRatingDropsTheAuthoredSpelling() throws {
        let out = try resave(sidecar(#"xmp:Rating="3""#)) { _, culling in
            culling.stars = 0
        }
        XCTAssertFalse(out.contains("xmp:Rating"),
                       "clearing the rating removes it — absence means unrated")
    }

    func testCanonicalRatingStillEmitsExactlyOnce() throws {
        let out = try resave(sidecar(#"xmp:Rating="3""#))
        XCTAssertTrue(out.contains(#"xmp:Rating="3""#))
        XCTAssertEqual(occurrences(of: "xmp:Rating", in: out), 1,
                       "the owned value must not double-emit through passthrough")
    }

    /// End to end through a real `.xmp` file: no mocks for the sidecar layer.
    func testRejectRatingSurvivesAStoreSave() async throws {
        let rawURL = makeTempRawURL()
        defer { try? FileManager.default.removeItem(at: SidecarPath.sidecarURL(for: rawURL)) }
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
        try sidecar(#"xmp:Rating="-1""#).write(to: sidecarURL, atomically: true, encoding: .utf8)

        let store = XMPSidecarStore(rawURL: rawURL)
        var (model, culling) = try await store.load()
        model.exposure = 0.5
        await store.update(model: model, culling: culling)
        await store.flush()

        let rewritten = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(rewritten.contains(#"xmp:Rating="-1""#),
                      "a store save that never touches rating must keep the reject")
    }

    // MARK: - Label preservation

    func testFlagMeaningLabelSurvivesUneditedNextToTheCanonicalFlag() throws {
        let out = try resave(sidecar(#"xmp:Label="Red""#))
        XCTAssertTrue(out.contains(#"xmp:Label="Red""#),
                      "the authored label bytes must survive even though Apple reads them as a pick")
        XCTAssertTrue(out.contains(#"papp:Flag="pick""#),
                      "the read flag still canonicalizes onto papp:Flag")
    }

    func testNonFlagLabelWordSurvivesUnedited() throws {
        let out = try resave(sidecar(#"xmp:Label="Blue""#))
        XCTAssertTrue(out.contains(#"xmp:Label="Blue""#),
                      "a Lightroom colour word Apple cannot read as a flag must still survive")
        XCTAssertFalse(out.contains("papp:Flag="))
    }

    func testNonFlagLabelWordSurvivesAFlagEdit() throws {
        let out = try resave(sidecar(#"xmp:Label="Blue""#)) { _, culling in
            culling.flag = .pick
        }
        XCTAssertTrue(out.contains(#"xmp:Label="Blue""#),
                      "setting a flag must not destroy a label that never meant a flag")
        XCTAssertTrue(out.contains(#"papp:Flag="pick""#))
    }

    func testClearedFlagDropsTheFlagMeaningLabel() throws {
        let out = try resave(sidecar(#"xmp:Label="Red""#)) { _, culling in
            culling.flag = .none
        }
        XCTAssertFalse(out.contains("xmp:Label="),
                       "clearing the flag drops the raw it was read from, or the next load resurrects it")
        XCTAssertFalse(out.contains("papp:Flag="))
    }

    func testChangedFlagDropsTheFlagMeaningLabel() throws {
        let out = try resave(sidecar(#"xmp:Label="Red""#)) { _, culling in
            culling.flag = .reject
        }
        XCTAssertFalse(out.contains("xmp:Label="),
                       "changing the flag rewrites it canonically and drops the raw")
        XCTAssertTrue(out.contains(#"papp:Flag="reject""#))
    }
}
