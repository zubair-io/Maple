// LensProfileXMPTests.swift — XMP round-trip for `papp:LensProfile` (#2435,
// #3395): the versioned content-addressed reference to an imported LCP.
//
// Apple carries the field for sidecar fidelity only — the import UI is a
// Web / Windows surface — so what matters here is that a reference another
// host wrote survives a Swift load/save byte-for-byte, in both its plain
// (`lcp1:`) and acknowledged (`lcp1-ack:`) spelling, and that the empty
// default is omitted so untouched sidecars stay byte-identical. Mirrors
// `FilmLookXMPTests.swift`, the other free-form `papp:` string.

import XCTest
@testable import MapleCore

final class LensProfileXMPTests: XCTestCase {

    private let digest = String(repeating: "a", count: 64)

    func testParseLensProfileReference() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:LensProfile="lcp1:\#(digest)""#))
        XCTAssertEqual(m.lensProfile, "lcp1:\(digest)")
    }

    func testDefaultIsEmptyAndOmittedOnWrite() throws {
        XCTAssertEqual(AdjustmentModel().lensProfile, "")
        let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(xml.contains("papp:LensProfile"))
    }

    func testBothSpellingsRoundTrip() throws {
        for value in ["lcp1:\(digest)", "lcp1-ack:\(digest)"] {
            var m = AdjustmentModel()
            m.lensProfile = value
            let xml = XMPSerializer.serialize(model: m, culling: CullingState())
            XCTAssertTrue(xml.contains(#"papp:LensProfile="\#(value)""#), xml)
            let (m2, _) = try XMPParser.parse(xml)
            XCTAssertEqual(m2.lensProfile, value)
        }
    }

    /// The reference is a Maple-owned key, not passthrough: the writer
    /// re-emits it from the model, so the passthrough scanner must know it
    /// or a Web-written selection would be duplicated on the next Mac save.
    func testReferenceIsAKnownAttributeNotPassthrough() {
        XCTAssertTrue(XMPKnownFields.isKnownAttribute("papp:LensProfile"))
    }

    /// A different profile selection is a different decode product — the
    /// transaction classifier must re-decode rather than re-run the chain.
    func testChangingTheReferenceIsADecodeEdit() {
        var before = AdjustmentModel()
        before.lensProfile = "lcp1:\(digest)"
        var after = before
        after.lensProfile = "lcp1:\(String(repeating: "b", count: 64))"
        XCTAssertEqual(InvalidationScope.classify(from: before, to: after), .decode)
    }

    private func xmp(attrs: String) -> String {
        """
        <?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:xmp="http://ns.adobe.com/xap/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              \(attrs)/>
          </rdf:RDF>
        </x:xmpmeta>
        """
    }
}
