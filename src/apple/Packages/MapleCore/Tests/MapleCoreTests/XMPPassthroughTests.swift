// XMPPassthroughTests.swift — the Apple passthrough contract (#2233).
//
// The load-bearing case is the first test: a real Lightroom-authored sidecar,
// written to a real file in a temp directory, opened through `XMPSidecarStore`,
// nudged by one slider, flushed, and read back — with every region Maple does
// not model byte-identical to what Lightroom wrote. CLAUDE.md forbids mocking
// the sidecar layer precisely because a serializer bug here destroys other
// applications' work, and only a real read-modify-write through the store
// exercises the debounced write path that used to do the destroying.

import XCTest
@testable import MapleCore

final class XMPPassthroughTests: XCTestCase {

    // MARK: - Fixtures

    /// A Lightroom Classic sidecar in Adobe's own layout: single-space
    /// indentation, `x:xmptk`, a foreign `xmpMM:` / `stEvt:` namespace pair
    /// declared on `rdf:Description`, a display-referred PV2012 curve, a mask
    /// group, a snapshot stack and an edit history — everything the ticket
    /// names as a casualty of the pre-#2233 writer.
    static let lightroomSidecar = """
    <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 9.0-c001 79.b0f8be9">
     <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
        xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
       xmp:Rating="3"
       xmpMM:DocumentID="xmp.did:9a5f1b40-2c1b-4a2f-9d3d-1f0b2c4d5e6f"
       xmpMM:InstanceID="xmp.iid:0e3a7c21-91d5-4b0c-8a44-2f7c1e8d9a10"
       crs:Version="15.0"
       crs:ProcessVersion="11.0"
       crs:Exposure2012="+0.35"
       crs:Contrast2012="+10"
       crs:RawFileName="DSCF1234.RAF"
       crs:CameraProfile="Adobe Standard &amp; Neutral"
       crs:HasSettings="True">
       <crs:ToneCurvePV2012>
        <rdf:Seq>
         <rdf:li>0, 0</rdf:li>
         <rdf:li>32, 22</rdf:li>
         <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
       </crs:ToneCurvePV2012>
       <crs:MaskGroupBasedCorrections>
        <rdf:Seq>
         <rdf:li>
          <rdf:Description
           crs:What="Correction"
           crs:CorrectionAmount="1"
           crs:LocalExposure2012="+0.500000">
          <crs:CorrectionMasks>
           <rdf:Seq>
            <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.5" crs:ZeroY="0.1"/>
           </rdf:Seq>
          </crs:CorrectionMasks>
          </rdf:Description>
         </rdf:li>
        </rdf:Seq>
       </crs:MaskGroupBasedCorrections>
       <crs:Snapshots>
        <rdf:Bag>
         <rdf:li>Import</rdf:li>
        </rdf:Bag>
       </crs:Snapshots>
       <xmpMM:History>
        <rdf:Seq>
         <rdf:li stEvt:action="derived" stEvt:parameters="converted 5 &gt; 4 stops"/>
         <rdf:li stEvt:action="saved" stEvt:when="2026-01-04T10:11:12-05:00"/>
        </rdf:Seq>
       </xmpMM:History>
      </rdf:Description>
     </rdf:RDF>
    </x:xmpmeta>
    <?xpacket end="w"?>
    """

    /// The four unknown child elements above, exactly as written. Each must
    /// appear verbatim in anything Maple writes back.
    static let lightroomNodeNames = [
        "crs:ToneCurvePV2012",
        "crs:MaskGroupBasedCorrections",
        "crs:Snapshots",
        "xmpMM:History",
    ]

    private func makeTempDirectory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-xmp-2233-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    /// The attribute names on the document's `rdf:Description` open tag, in
    /// emitted order, excluding namespace declarations.
    ///
    /// Scoped to the open tag rather than the whole file: a preserved mask
    /// group carries `crs:` attributes of its own, and those are not part of
    /// the canonical ordering under test.
    private func attributeNames(in document: String) -> [String] {
        let lines = document.split(separator: "\n", omittingEmptySubsequences: false)
        guard let start = lines.firstIndex(where: { $0.contains("<rdf:Description ") }) else {
            return []
        }
        return lines[lines.index(after: start)...]
            .prefix { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("<") }
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard let equals = trimmed.firstIndex(of: "="), !trimmed.hasPrefix("xmlns") else {
                    return nil
                }
                return String(trimmed[trimmed.startIndex..<equals])
            }
    }

    /// Canonical namespace rank — 500 for anything outside the eight prefixes
    /// the format pins (`docs/xmp-canonical-format.md` § "Attribute ordering").
    private func namespaceRank(of name: String) -> Int {
        let known = ["xmp", "crs", "papp", "dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
        guard let colon = name.firstIndex(of: ":") else { return 500 }
        return known.firstIndex(of: String(name[name.startIndex..<colon])) ?? 500
    }

    // MARK: - The load → edit → save contract

    /// A real Lightroom sidecar opened through the on-disk store, edited by one
    /// slider and flushed, keeps every unmodelled region byte-for-byte.
    func testLightroomSidecarSurvivesLoadEditSave() async throws {
        let dir = try makeTempDirectory()
        let rawURL = dir.appendingPathComponent("DSCF1234.dng")
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
        try Self.lightroomSidecar.write(to: sidecarURL, atomically: true, encoding: .utf8)

        let store = XMPSidecarStore(rawURL: rawURL)
        let (model, culling) = try await store.load()
        XCTAssertEqual(model.exposure, 0.35, accuracy: 1e-9, "the Lightroom exposure must load")
        XCTAssertEqual(culling.stars, 3)

        var edited = model
        edited.exposure = 1.25
        await store.update(model: edited, culling: culling)
        await store.flush()

        let written = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(written.contains("crs:Exposure2012=\"1.25\""), "the edit must land")

        // Every unknown child element survives byte-for-byte.
        let sourceNodes = XMPChildElementScanner.descriptionChildren(in: Self.lightroomSidecar)
        XCTAssertEqual(sourceNodes.map(\.qName), Self.lightroomNodeNames)
        for node in sourceNodes {
            XCTAssertTrue(written.contains(node.source),
                          "\(node.qName) must be re-emitted verbatim")
        }

        // …and so do the unknown attributes, including the namespace
        // declarations the preserved subtrees depend on.
        for attribute in [
            "xmpMM:DocumentID=\"xmp.did:9a5f1b40-2c1b-4a2f-9d3d-1f0b2c4d5e6f\"",
            "xmpMM:InstanceID=\"xmp.iid:0e3a7c21-91d5-4b0c-8a44-2f7c1e8d9a10\"",
            "crs:RawFileName=\"DSCF1234.RAF\"",
            "crs:CameraProfile=\"Adobe Standard &amp; Neutral\"",
            "xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\"",
            "xmlns:stEvt=\"http://ns.adobe.com/xap/1.0/sType/ResourceEvent#\"",
        ] {
            XCTAssertTrue(written.contains(attribute), "expected preserved attribute: \(attribute)")
        }
    }

    /// The unknown nodes keep their source order — masks, history and
    /// snapshots are ordered stacks, so a re-ordering is a corruption.
    func testUnknownNodeOrderIsPreserved() {
        let passthrough = XMPParser.parsePassthrough(Self.lightroomSidecar)
        XCTAssertEqual(passthrough.unknownNodes.count, 4)
        let written = XMPSerializer.serialize(
            model: .default, culling: CullingState(), passthrough: passthrough)
        let positions = passthrough.unknownNodes.compactMap { written.range(of: $0)?.lowerBound }
        XCTAssertEqual(positions.count, 4, "every node must appear in the output")
        XCTAssertEqual(positions, positions.sorted(), "node order must match the source")
    }

    /// A second save is a fixed point: the document Maple writes parses back
    /// into the same model plus the same bucket and re-serializes identically.
    /// Without this, every slider tick would churn the preserved regions.
    func testResaveIsAFixedPoint() async throws {
        let dir = try makeTempDirectory()
        let rawURL = dir.appendingPathComponent("DSCF1234.dng")
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
        try Self.lightroomSidecar.write(to: sidecarURL, atomically: true, encoding: .utf8)

        let store = XMPSidecarStore(rawURL: rawURL)
        let (model, culling) = try await store.load()
        var edited = model
        edited.exposure = 1.25
        await store.update(model: edited, culling: culling)
        await store.flush()
        let first = try String(contentsOf: sidecarURL, encoding: .utf8)

        let reopened = XMPSidecarStore(rawURL: rawURL)
        let (reloaded, reloadedCulling) = try await reopened.load()
        await reopened.update(model: reloaded, culling: reloadedCulling)
        await reopened.flush()
        let second = try String(contentsOf: sidecarURL, encoding: .utf8)

        XCTAssertEqual(second, first, "write → parse → write must be a fixed point")
    }

    // MARK: - No double emission

    /// Children the serializer builds from the model must not ALSO ride the
    /// passthrough pipe. The keyword bag, the four scene-linear curves and the
    /// metadata blocks are the managed set; Adobe's display-referred
    /// `crs:ToneCurvePV2012` deliberately is not.
    func testManagedChildrenAreNotDuplicated() {
        let source = XMPSerializer.serialize(
            model: XMPCanonicalFormatTests.canonicalFixtureModel(),
            culling: XMPCanonicalFormatTests.canonicalFixtureCulling())
        let passthrough = XMPParser.parsePassthrough(source)
        XCTAssertTrue(passthrough.unknownNodes.isEmpty,
                      "a Maple-authored sidecar has nothing foreign in it")
        XCTAssertTrue(passthrough.unknownAttributes.isEmpty,
                      "…and no unknown attributes either: \(passthrough.unknownAttributes)")

        let rewritten = XMPSerializer.serialize(
            model: XMPCanonicalFormatTests.canonicalFixtureModel(),
            culling: XMPCanonicalFormatTests.canonicalFixtureCulling(),
            passthrough: passthrough)
        XCTAssertEqual(rewritten, source, "an empty bucket must not change a single byte")
    }

    /// The guard behind the whole known-set design: anything the serializer
    /// emits must be in `XMPKnownFields.attributes`, or the parser would file
    /// it as passthrough and the next save would emit it twice.
    func testEverySerializedAttributeIsKnown() {
        var metadata = XmpMetadata()
        metadata.gpsLatitude = 51.5
        metadata.gpsLongitude = -0.12
        metadata.gpsAltitude = 35
        metadata.dateTimeOriginal = "2026-01-04T10:11:12-05:00"
        metadata.timeZone = "-05:00"
        metadata.sublocation = "Southbank"
        metadata.city = "London"
        metadata.state = "England"
        metadata.country = "United Kingdom"
        metadata.countryCode = "GBR"
        metadata.title = "Title"
        metadata.caption = "Caption"
        metadata.headline = "Headline"
        metadata.instructions = "Instructions"
        metadata.creator = "Creator"
        metadata.creatorJobTitle = "Photographer"
        metadata.copyrightNotice = "© 2026"
        metadata.copyrightStatus = .copyrighted
        metadata.usageTerms = "All rights reserved"
        metadata.credit = "Credit"
        metadata.source = "Source"
        let document = XMPSerializer.serialize(
            model: XMPCanonicalFormatTests.canonicalFixtureModel(),
            culling: XMPCanonicalFormatTests.canonicalFixtureCulling(),
            metadata: metadata)
        let emitted = attributeNames(in: document)
        XCTAssertFalse(emitted.isEmpty)
        for name in emitted {
            XCTAssertTrue(XMPKnownFields.isKnownAttribute(name),
                          "\(name) is written by the serializer but missing from the known set — "
                            + "it would be re-emitted a second time through passthrough")
        }
    }

    // MARK: - Canonical ordering

    /// Passthrough attributes slot into the canonical order rather than being
    /// appended raw: unknown-NAMESPACE attributes land after every known
    /// namespace, while an unknown attribute in a known namespace
    /// (`crs:RawFileName`) sorts alphabetically inside that namespace's block —
    /// the rule `docs/xmp-canonical-format.md` § "Attribute ordering" states
    /// and the web writer already follows.
    func testPassthroughAttributesTakeTheirCanonicalPositions() {
        let passthrough = XMPParser.parsePassthrough(Self.lightroomSidecar)
        let document = XMPSerializer.serialize(
            model: .default, culling: CullingState(), passthrough: passthrough)
        let emitted = attributeNames(in: document)
        XCTAssertTrue(emitted.contains("xmpMM:DocumentID"))
        XCTAssertTrue(emitted.contains("crs:RawFileName"))

        let ranks = emitted.map(namespaceRank)
        XCTAssertEqual(ranks, ranks.sorted(), "namespace priority must be non-decreasing")
        for block in Dictionary(grouping: emitted, by: namespaceRank).values {
            XCTAssertEqual(block, block.sorted(),
                           "names sort alphabetically inside a namespace block")
        }
        guard let camera = emitted.firstIndex(of: "crs:CameraProfile"),
              let clarity = emitted.firstIndex(of: "crs:Clarity2012"),
              let documentID = emitted.firstIndex(of: "xmpMM:DocumentID"),
              let wbScale = emitted.firstIndex(of: "papp:WbScaleVersion") else {
            return XCTFail("expected attributes missing from the document")
        }
        XCTAssertLessThan(camera, clarity, "an unknown crs: name interleaves alphabetically")
        XCTAssertLessThan(wbScale, documentID, "an unknown namespace sorts after every known one")
    }

    // MARK: - Cross-platform

    /// A sidecar written by the web serializer — canonical envelope, unknown
    /// nodes already at the six-space child indent — keeps exactly what the web
    /// preserved when Apple re-saves it.
    func testWebWrittenSidecarKeepsWhatWebPreserved() throws {
        let webAuthored = """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description rdf:about=""
              xmlns:xmp="http://ns.adobe.com/xap/1.0/"
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:papp="http://ns.justmaple.app/photo/1.0/"
              crs:Version="11.0"
              crs:ProcessVersion="11.0"
              crs:HasSettings="True"
              crs:Exposure2012="0.4"
              crs:RawFileName="DSCF1234.RAF">
              <crs:ToneCurvePV2012>
                <rdf:Seq>
                  <rdf:li>0, 0</rdf:li>
                  <rdf:li>128, 140</rdf:li>
                </rdf:Seq>
              </crs:ToneCurvePV2012>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
        let dir = try makeTempDirectory()
        let url = dir.appendingPathComponent("web.xmp")
        try webAuthored.write(to: url, atomically: true, encoding: .utf8)

        let source = try String(contentsOf: url, encoding: .utf8)
        let (model, culling) = try XMPParser.parse(source)
        let passthrough = XMPParser.parsePassthrough(source)
        let rewritten = XMPSerializer.serialize(
            model: model, culling: culling, passthrough: passthrough)

        XCTAssertEqual(passthrough.unknownNodes.count, 1)
        XCTAssertTrue(rewritten.contains(passthrough.unknownNodes[0]),
                      "the web-preserved PV2012 curve must survive Apple's re-save")
        XCTAssertTrue(rewritten.contains("crs:RawFileName=\"DSCF1234.RAF\""))
        // The node came in already sitting on the canonical ladder, so the
        // re-emitted block is identical to the source block, indent included.
        XCTAssertTrue(rewritten.contains("      <crs:ToneCurvePV2012>\n        <rdf:Seq>"))
    }

    // MARK: - Scanner edge cases

    /// The scanner must not mistake markup inside comments, CDATA or attribute
    /// values for structure — a Lightroom history string routinely contains a
    /// bare `>`.
    func testScannerSkipsCommentsCdataAndQuotedMarkup() {
        let xml = """
        <?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <!-- <crs:NotAChild/> -->
            <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
              <crs:Alpha note="a &gt; b &lt;/crs:Alpha&gt;">
                <![CDATA[ </crs:Alpha> <crs:Fake/> ]]>
              </crs:Alpha>
              <crs:Beta/>
              <!-- <crs:Gamma/> -->
              <crs:Delta><crs:Alpha/></crs:Delta>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
        let children = XMPChildElementScanner.descriptionChildren(in: xml)
        XCTAssertEqual(children.map(\.qName), ["crs:Alpha", "crs:Beta", "crs:Delta"])
        XCTAssertTrue(children[0].source.hasSuffix("</crs:Alpha>"))
        XCTAssertTrue(children[0].source.contains("CDATA"))
        XCTAssertEqual(children[1].source, "<crs:Beta/>")
        XCTAssertEqual(children[2].source, "<crs:Delta><crs:Alpha/></crs:Delta>")
    }

    /// A self-closing `rdf:Description` — what every Maple sidecar without
    /// keywords or curves looks like — has no children and no passthrough.
    func testSelfClosingDescriptionHasNoChildren() {
        let document = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertTrue(document.contains("/>"), "the fixture must exercise the self-closing form")
        XCTAssertTrue(XMPChildElementScanner.descriptionChildren(in: document).isEmpty)
        XCTAssertEqual(XMPParser.parsePassthrough(document), .empty)
    }

    /// Malformed input is not carried forward: there are no trustworthy bytes
    /// in it, and the store is about to replace the file either way.
    func testMalformedDocumentYieldsEmptyBucket() {
        XCTAssertEqual(XMPParser.parsePassthrough("<not xml"), .empty)
        XCTAssertEqual(XMPParser.parsePassthrough(""), .empty)
    }
}
