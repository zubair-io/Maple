// XMPCullFlagTests.swift — cull-flag wire format + round-trip coverage (#2221).
//
// The serializer used to write the flag as `xmp:Label="Red"` / `"Rejected"`
// while the parser matched only `"red"`/`"pick"`/`"reject"`, so `"Rejected"`
// fell through to the default arm and every reject silently decayed to
// `.none` on the next load. `xmp:Label` was also the wrong key entirely: the
// TypeScript and API sides both write and read `papp:Flag` with the bare
// lowercase `pick` / `reject` vocabulary, and the web parser reads
// `xmp:Label` as an Adobe *colour* word — so an Apple pick arrived on the
// web as a red colour label rather than a flag.
//
// This file pins the canonical wire value on the Apple side, the read-only
// legacy aliases that keep sidecars already on disk parseable, and the
// write → read → write round trip through a real `.xmp` file in a temp
// directory (CLAUDE.md § "No mocks for the sidecar layer").

import XCTest
@testable import MapleCore

final class XMPCullFlagTests: XCTestCase {

    // MARK: - Helpers

    /// Minimal hand-authored sidecar carrying exactly `attrs` on the
    /// `rdf:Description`. Used for the legacy-alias cases, which by
    /// definition can no longer be produced by `XMPSerializer`.
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

    /// A `.dng` URL in the temp directory whose sidecar is removed on teardown.
    /// Nothing is ever written at the `.dng` path itself — `XMPSidecarStore`
    /// only derives the sidecar name from it.
    private func makeTempRawURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
    }

    private func removeSidecar(for rawURL: URL) {
        try? FileManager.default.removeItem(at: SidecarPath.sidecarURL(for: rawURL))
    }

    // MARK: - Canonical wire value

    /// The emitted attribute and value are pinned as literals because they
    /// are a cross-platform contract, not an Apple implementation detail:
    /// `metadata-serializer.ts` writes `papp:Flag="<flag>"`, and both
    /// `metadata-parser.ts` (`flagStr === 'pick' || flagStr === 'reject'`)
    /// and `xmp-culling.ts` (`VALID_FLAGS` membership) gate on exactly these
    /// two lowercase words. Changing either literal here without changing
    /// them there re-opens the interop gap this ticket closed.
    func testSerializerEmitsCanonicalPappFlagWireValues() {
        let pick = XMPSerializer.serialize(model: .default, culling: CullingState(flag: .pick))
        XCTAssertTrue(pick.contains(#"papp:Flag="pick""#),
                      "pick must serialize as the canonical papp:Flag=\"pick\"")

        let reject = XMPSerializer.serialize(model: .default, culling: CullingState(flag: .reject))
        XCTAssertTrue(reject.contains(#"papp:Flag="reject""#),
                      "reject must serialize as the canonical papp:Flag=\"reject\"")
    }

    /// The `CullFlag` raw values ARE the wire values, so a rename would
    /// silently change the bytes on disk. Pin the vocabulary itself.
    func testCullFlagRawValuesAreTheWireVocabulary() {
        XCTAssertEqual(CullFlag.pick.rawValue, "pick")
        XCTAssertEqual(CullFlag.reject.rawValue, "reject")
    }

    /// The legacy `xmp:Label` overload is no longer written. It has to stop:
    /// the web parser reads `xmp:Label` as an Adobe colour word, so an Apple
    /// pick emitted as `xmp:Label="Red"` showed up there as a red colour
    /// label instead of a flag.
    func testSerializerNoLongerWritesTheLegacyXmpLabelOverload() {
        for flag in [CullFlag.pick, .reject] {
            let xml = XMPSerializer.serialize(model: .default, culling: CullingState(flag: flag))
            XCTAssertFalse(xml.contains("xmp:Label="),
                           "\(flag.rawValue) must not emit the legacy xmp:Label overload")
        }
    }

    /// Absence means unflagged on every side (`papp:Flag` is omit-when-default
    /// in the TS serializer too), so an untouched state must stay silent.
    func testUnflaggedEmitsNoFlagAttribute() {
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertFalse(xml.contains("papp:Flag="))
        XCTAssertFalse(xml.contains("xmp:Label="))
    }

    // MARK: - Canonical parse

    func testCanonicalPappFlagParses() throws {
        let (_, pick) = try XMPParser.parse(sidecar(#"papp:Flag="pick""#))
        XCTAssertEqual(pick.flag, .pick)

        let (_, reject) = try XMPParser.parse(sidecar(#"papp:Flag="reject""#))
        XCTAssertEqual(reject.flag, .reject)
    }

    /// The other two parsers match the flag vocabulary case-sensitively. A
    /// looser match here would let a sidecar resolve to a flag on Apple and
    /// to unflagged on web/API — divergence dressed up as leniency.
    func testCanonicalPappFlagIsMatchedCaseSensitively() throws {
        let (_, culling) = try XMPParser.parse(sidecar(#"papp:Flag="Reject""#))
        XCTAssertEqual(culling.flag, .none,
                       "papp:Flag is matched exactly, mirroring metadata-parser.ts")
    }

    func testUnknownFlagValueLeavesTheFlagUnset() throws {
        let (_, culling) = try XMPParser.parse(sidecar(#"papp:Flag="maybe""#))
        XCTAssertEqual(culling.flag, .none)
    }

    // MARK: - Legacy `xmp:Label` aliases (read-only)

    /// `"Rejected"` is the spelling every Apple-authored sidecar on disk
    /// carries today — the one that used to be unreadable. `"Red"` is the
    /// matching legacy pick spelling. Both must keep parsing forever, or the
    /// fix strands the very files it exists to rescue.
    func testLegacyXmpLabelSpellingsStillParse() throws {
        let cases: [(String, CullFlag)] = [
            ("Rejected", .reject),   // what the old Apple serializer wrote
            ("rejected", .reject),
            ("reject", .reject),     // what the old Apple parser accepted
            ("Red", .pick),          // what the old Apple serializer wrote
            ("red", .pick),
            ("pick", .pick),
        ]
        for (word, expected) in cases {
            let (_, culling) = try XMPParser.parse(sidecar(#"xmp:Label="\#(word)""#))
            XCTAssertEqual(culling.flag, expected,
                           "legacy xmp:Label=\"\(word)\" must parse to \(expected.rawValue)")
        }
    }

    /// A sidecar carrying both keys resolves to the canonical one regardless
    /// of attribute iteration order (Swift dictionaries are unordered), the
    /// same precedence shape as `papp:CaptureSharpeningSigma` over the legacy
    /// Radius alias.
    func testCanonicalFlagWinsOverTheLegacyLabelAlias() throws {
        let (_, a) = try XMPParser.parse(
            sidecar(#"papp:Flag="reject" xmp:Label="Red""#))
        XCTAssertEqual(a.flag, .reject)

        let (_, b) = try XMPParser.parse(
            sidecar(#"xmp:Label="Red" papp:Flag="reject""#))
        XCTAssertEqual(b.flag, .reject)
    }

    // MARK: - Round trip through a real sidecar on disk

    /// The ticket's headline case: a reject written through `XMPSidecarStore`
    /// and read back from the file it produced. Before #2221 this came back
    /// as `.none`.
    func testSidecarStoreRoundTripRejectFlag() async throws {
        let rawURL = makeTempRawURL()
        defer { removeSidecar(for: rawURL) }

        let store = XMPSidecarStore(rawURL: rawURL)
        await store.update(model: .default, culling: CullingState(stars: 2, flag: .reject))
        await store.flush()

        // A fresh store, so the read genuinely goes to disk rather than to
        // the writing store's in-memory cache.
        let fresh = XMPSidecarStore(rawURL: rawURL)
        let (_, culling) = try await fresh.load()
        XCTAssertEqual(culling.flag, .reject, "reject must survive a real sidecar round trip")
        XCTAssertEqual(culling.stars, 2)

        let onDisk = try String(contentsOf: SidecarPath.sidecarURL(for: rawURL), encoding: .utf8)
        XCTAssertTrue(onDisk.contains(#"papp:Flag="reject""#))
    }

    func testSidecarStoreRoundTripPickFlag() async throws {
        let rawURL = makeTempRawURL()
        defer { removeSidecar(for: rawURL) }

        let store = XMPSidecarStore(rawURL: rawURL)
        await store.update(model: .default, culling: CullingState(flag: .pick))
        await store.flush()

        let fresh = XMPSidecarStore(rawURL: rawURL)
        let (_, culling) = try await fresh.load()
        XCTAssertEqual(culling.flag, .pick, "pick must keep round-tripping (it always did)")
    }

    /// write → read → write: the second sidecar must still carry the flag,
    /// which is what "the flag is stable across sessions" actually means —
    /// a parser that drops it produces a second write that has silently lost
    /// the user's cull.
    func testWriteReadWriteKeepsTheRejectFlag() async throws {
        let rawURL = makeTempRawURL()
        defer { removeSidecar(for: rawURL) }
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)

        let first = XMPSidecarStore(rawURL: rawURL)
        await first.update(model: .default, culling: CullingState(flag: .reject))
        await first.flush()
        let firstXml = try String(contentsOf: sidecarURL, encoding: .utf8)

        let second = XMPSidecarStore(rawURL: rawURL)
        let (model, culling) = try await second.load()
        await second.update(model: model, culling: culling)
        await second.flush()
        let secondXml = try String(contentsOf: sidecarURL, encoding: .utf8)

        XCTAssertTrue(firstXml.contains(#"papp:Flag="reject""#))
        XCTAssertTrue(secondXml.contains(#"papp:Flag="reject""#),
                      "re-saving a loaded sidecar must not drop the reject flag")

        let (_, reloaded) = try XMPParser.parse(secondXml)
        XCTAssertEqual(reloaded.flag, .reject)
    }

    /// A sidecar already on disk in the legacy spelling upgrades to the
    /// canonical key on the next save without losing the flag — the
    /// migration path for existing users, driven entirely by normal saves
    /// (nothing rewrites files behind the user's back).
    func testLegacySidecarUpgradesToTheCanonicalKeyOnResave() async throws {
        let rawURL = makeTempRawURL()
        defer { removeSidecar(for: rawURL) }
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)

        try sidecar(#"xmp:Label="Rejected""#).write(to: sidecarURL, atomically: true, encoding: .utf8)

        let store = XMPSidecarStore(rawURL: rawURL)
        let (model, culling) = try await store.load()
        XCTAssertEqual(culling.flag, .reject, "the legacy spelling on disk must still read")

        await store.update(model: model, culling: culling)
        await store.flush()

        let rewritten = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(rewritten.contains(#"papp:Flag="reject""#))
        XCTAssertFalse(rewritten.contains("xmp:Label="))
    }
}
