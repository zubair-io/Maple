// XMPMetadataTests.swift — round-trip tests for the XmpMetadata struct + GPS/altitude
// encoders + XMPSerializer/Parser metadata support (#1581 / epic #1575).
//
// All tests use real `.xmp` strings via `XMPSerializer.serialize` and
// `XMPParser.parseMetadata` — no mocks, per the sidecar layer testing rule.

import XCTest
@testable import MapleCore

final class XMPMetadataTests: XCTestCase {

    // MARK: - GPS encoding edge cases

    /// Zero magnitude (positive or negative) always maps to the positive hemisphere
    /// so `+0` and `-0` can never flip N/S or E/W on round-trip.
    func testGpsEncodeZeroMagnitude() {
        XCTAssertEqual(gpsToXmp(0.0, axis: .lat),  "0,0.0000N")
        XCTAssertEqual(gpsToXmp(-0.0, axis: .lat), "0,0.0000N")
        XCTAssertEqual(gpsToXmp(0.0, axis: .lon),  "0,0.0000E")
        XCTAssertEqual(gpsToXmp(-0.0, axis: .lon), "0,0.0000E")
    }

    /// Negative latitude uses the S hemisphere.
    func testGpsEncodeNegativeLatitude() {
        // -33.8688° ≈ 33°52.1280′S  (abs * 60 * 1e4 = 2032128.0)
        // roundedMinutes = 2032128 / 1e4 = 203.2128 → wait, let me recompute:
        // abs = 33.8688, abs*60 = 2032.128, *1e4 = 20321280, rounded = 20321280,
        // /1e4 = 2032.1280 → deg = 33, min = 52.1280 → "33,52.1280S"
        XCTAssertEqual(gpsToXmp(-33.8688, axis: .lat), "33,52.1280S")
    }

    /// Positive longitude uses the E hemisphere.
    func testGpsEncodePositiveLongitude() {
        // 151.2093° → abs*60 = 9072.558, *1e4 = 90725580, /1e4 = 9072.5580
        // deg = 151, min = 12.5580 → "151,12.5580E"
        XCTAssertEqual(gpsToXmp(151.2093, axis: .lon), "151,12.5580E")
    }

    /// Near-boundary carry: a value close enough to a full degree that
    /// `abs * 60 * 1e4` rounds to an exact multiple of 600000.
    /// e.g. 89.9999999° ≈ 89 + (0.9999999 * 60) min = 89 + 59.999994 min
    /// abs * 60 * 1e4 = 53999996.4 → rounds to 53999996 → /1e4 = 5399.9996
    /// deg = 89, min = 59.9996 — does NOT carry. Let's find a real carry case:
    /// value = 89 + 59.999995/60 = 89.9999999916...
    /// abs * 60 = 5399.99999..., * 1e4 = 53999999.9 → rounds to 54000000
    /// → /1e4 = 5400.0000 → deg = 90, min = 0.0000 — never emits 60.0000
    func testGpsNearBoundaryCarry() {
        // A value that causes minutes to round up to 60 should carry into degrees.
        // 89.999999992° * 60 * 1e4 = 53999999.952 → rounds to 54000000
        // → roundedMinutes = 5400.0 → deg = 90, min = 0.0000N
        let v = 89.0 + 59.999999 / 60.0  // close to 90°
        let encoded = gpsToXmp(v, axis: .lat)
        // Must not contain ",60." as minutes value.
        XCTAssertFalse(encoded.contains(",60."), "GPS encoder must carry 60-minute to next degree")
    }

    // MARK: - GPS round-trip

    /// `gpsToXmp` → `gpsFromXmp` recovers the value within 4dp precision.
    func testGpsRoundTrip() {
        let cases: [(Double, GpsAxis)] = [
            (48.8566, .lat),
            (-33.8688, .lat),
            (2.3522, .lon),
            (151.2093, .lon),
            (0.0, .lat),
            (-90.0, .lat),
            (180.0, .lon),
        ]
        for (value, axis) in cases {
            let encoded = gpsToXmp(value, axis: axis)
            let decoded = gpsFromXmp(encoded)
            XCTAssertNotNil(decoded, "gpsFromXmp returned nil for \(encoded)")
            if let d = decoded {
                XCTAssertEqual(d, value, accuracy: 1e-4,
                    "GPS round-trip failed for \(value) (\(encoded))")
            }
        }
    }

    /// `gpsFromXmp` returns nil for malformed strings.
    func testGpsFromXmpMalformed() {
        XCTAssertNil(gpsFromXmp(""))
        XCTAssertNil(gpsFromXmp("48.8566"))         // no comma form
        XCTAssertNil(gpsFromXmp("48,51.3960X"))     // invalid hemisphere
        XCTAssertNil(gpsFromXmp("48 51.3960N"))     // space instead of comma
    }

    // MARK: - Altitude encoding

    /// Positive meters → ref "0" (above sea level).
    func testAltitudePositive() {
        let (value, ref) = altitudeToXmp(35.0)
        XCTAssertEqual(ref, "0")
        XCTAssertEqual(value, "35000/1000")
    }

    /// Negative meters → ref "1" (below sea level), absolute value.
    func testAltitudeNegative() {
        let (value, ref) = altitudeToXmp(-12.5)
        XCTAssertEqual(ref, "1")
        XCTAssertEqual(value, "12500/1000")
    }

    /// `altitudeToXmp` → `altitudeFromXmp` round-trip.
    func testAltitudeRoundTrip() {
        for meters in [0.0, 35.0, -12.5, 8848.0, -423.0] {
            let (v, r) = altitudeToXmp(meters)
            let decoded = altitudeFromXmp(value: v, ref: r)
            XCTAssertNotNil(decoded, "altitudeFromXmp nil for \(v)/\(r)")
            XCTAssertEqual(decoded!, meters, accuracy: 0.001)
        }
    }

    /// `altitudeFromXmp` returns nil on malformed input.
    func testAltitudeFromXmpMalformed() {
        XCTAssertNil(altitudeFromXmp(value: "abc", ref: "0"))
        XCTAssertNil(altitudeFromXmp(value: "35000/0", ref: "0"))  // denom zero
        XCTAssertNil(altitudeFromXmp(value: "", ref: "0"))
    }

    // MARK: - All fields serialize → parse round-trip

    /// Serialize a fully-populated `XmpMetadata` and parse it back; every
    /// field must survive the round-trip with the correct value.
    func testAllFieldsRoundTrip() throws {
        var meta = XmpMetadata()
        meta.gpsLatitude     = 48.8566
        meta.gpsLongitude    = 2.3522
        meta.gpsAltitude     = 35.0
        meta.dateTimeOriginal = "2026-06-26T18:40:00+02:00"
        meta.timeZone        = "Europe/Paris"
        meta.sublocation     = "Rue Vignon"
        meta.city            = "Paris"
        meta.state           = "Île-de-France"
        meta.country         = "France"
        meta.countryCode     = "FR"
        meta.title           = "Sunset"
        meta.caption         = "Notes here & <there>"
        meta.headline        = "Trip"
        meta.instructions    = "Embargo until July"
        meta.creator         = "Ansel Adams"
        meta.creatorJobTitle = "Photographer"
        meta.copyrightNotice = "© 2026 Z. Lawrence"
        meta.copyrightStatus = .copyrighted
        meta.usageTerms      = "All rights reserved"
        meta.credit          = "Z. Lawrence"
        meta.source          = "Maple"

        let xml = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: meta)
        let parsed = XMPParser.parseMetadata(xml)

        XCTAssertEqual(parsed.gpsLatitude!, 48.8566, accuracy: 1e-4)
        XCTAssertEqual(parsed.gpsLongitude!, 2.3522, accuracy: 1e-4)
        XCTAssertEqual(parsed.gpsAltitude!, 35.0, accuracy: 0.001)
        XCTAssertEqual(parsed.dateTimeOriginal, "2026-06-26T18:40:00+02:00")
        XCTAssertEqual(parsed.timeZone, "Europe/Paris")
        XCTAssertEqual(parsed.sublocation, "Rue Vignon")
        XCTAssertEqual(parsed.city, "Paris")
        XCTAssertEqual(parsed.state, "Île-de-France")
        XCTAssertEqual(parsed.country, "France")
        XCTAssertEqual(parsed.countryCode, "FR")
        XCTAssertEqual(parsed.title, "Sunset")
        XCTAssertEqual(parsed.caption, "Notes here & <there>")
        XCTAssertEqual(parsed.headline, "Trip")
        XCTAssertEqual(parsed.instructions, "Embargo until July")
        XCTAssertEqual(parsed.creator, "Ansel Adams")
        XCTAssertEqual(parsed.creatorJobTitle, "Photographer")
        XCTAssertEqual(parsed.copyrightNotice, "© 2026 Z. Lawrence")
        XCTAssertEqual(parsed.copyrightStatus, .copyrighted)
        XCTAssertEqual(parsed.usageTerms, "All rights reserved")
        XCTAssertEqual(parsed.credit, "Z. Lawrence")
        XCTAssertEqual(parsed.source, "Maple")
    }

    // MARK: - Empty / default metadata

    /// An empty `XmpMetadata()` emits nothing and adds no namespaces.
    func testEmptyMetadataEmitsNothing() {
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: XmpMetadata())
        // The base serializer output must be identical to the one without metadata.
        let base = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertEqual(xml, base, "Empty XmpMetadata should produce identical output to no-metadata call")
    }

    // MARK: - Namespace declarations

    /// Only the namespaces used by the provided metadata are declared.
    func testNamespacesDeclaredConditionally() {
        var meta = XmpMetadata()
        meta.gpsLatitude = 48.8566
        meta.city = "Paris"
        meta.title = "T"

        let xml = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: meta)
        // exif (GPS), photoshop (city), dc (title) should appear.
        XCTAssertTrue(xml.contains("xmlns:exif="), "exif namespace should be declared")
        XCTAssertTrue(xml.contains("xmlns:photoshop="), "photoshop namespace should be declared")
        XCTAssertTrue(xml.contains("xmlns:dc="), "dc namespace should be declared")
        // xmpRights and Iptc4xmpCore should NOT appear.
        XCTAssertFalse(xml.contains("xmlns:xmpRights="),
                       "xmpRights namespace should not be declared when not used")
        XCTAssertFalse(xml.contains("xmlns:Iptc4xmpCore="),
                       "Iptc4xmpCore namespace should not be declared when not used")
    }

    // MARK: - Copyright status tri-state

    /// `.copyrighted` → `xmpRights:Marked="True"`, parses back to `.copyrighted`.
    func testCopyrightStatusCopyrighted() throws {
        var meta = XmpMetadata()
        meta.copyrightStatus = .copyrighted
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: meta)
        XCTAssertTrue(xml.contains(#"xmpRights:Marked="True""#))
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.copyrightStatus, .copyrighted)
    }

    /// `.publicDomain` → `xmpRights:Marked="False"`, parses back to `.publicDomain`.
    func testCopyrightStatusPublicDomain() throws {
        var meta = XmpMetadata()
        meta.copyrightStatus = .publicDomain
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: meta)
        XCTAssertTrue(xml.contains(#"xmpRights:Marked="False""#))
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.copyrightStatus, .publicDomain)
    }

    /// `.unknown` omits the attribute entirely.
    func testCopyrightStatusUnknownOmitsAttribute() {
        var meta = XmpMetadata()
        meta.copyrightStatus = .unknown
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: meta)
        XCTAssertFalse(xml.contains("xmpRights:Marked"),
                       ".unknown copyright status must not emit xmpRights:Marked")
    }

    // MARK: - XML escaping in nested blocks

    /// `&`, `<`, `>` in text fields are escaped on serialize and decoded on parse.
    func testLangAltXMLEscaping() throws {
        var meta = XmpMetadata()
        meta.title   = "Fish & Chips"
        meta.caption = "A < B > C"

        let xml = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: meta)
        XCTAssertTrue(xml.contains("Fish &amp; Chips"))
        XCTAssertTrue(xml.contains("A &lt; B &gt; C"))

        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.title, "Fish & Chips")
        XCTAssertEqual(parsed.caption, "A < B > C")
    }

    // MARK: - Metadata coexists with adjustment + culling

    /// Metadata attributes live in the same `rdf:Description` as the
    /// existing adjustment + culling fields, and both survive round-trip.
    func testMetadataCoexistsWithAdjustmentFields() throws {
        var model = AdjustmentModel()
        model.exposure = 1.5
        model.highlights = -30
        var meta = XmpMetadata()
        meta.city = "Tokyo"
        meta.creator = "Hiroshi Sugimoto"
        let culling = CullingState(stars: 4, flag: .pick, keywords: ["mono"])

        let xml = XMPSerializer.serialize(model: model, culling: culling, metadata: meta)

        // Adjustment fields present.
        XCTAssertTrue(xml.contains(#"crs:Exposure2012="1.50""#))
        XCTAssertTrue(xml.contains(#"crs:Highlights2012="-30""#))
        // Culling present.
        XCTAssertTrue(xml.contains(#"xmp:Rating="4""#))
        XCTAssertTrue(xml.contains("<dc:subject>"))
        // Metadata present.
        XCTAssertTrue(xml.contains(#"photoshop:City="Tokyo""#))
        XCTAssertTrue(xml.contains("<dc:creator>"))

        // Parse-back.
        let (m2, c2) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.exposure, 1.5, accuracy: 0.01)
        XCTAssertEqual(m2.highlights, -30, accuracy: 1)
        XCTAssertEqual(c2.stars, 4)
        XCTAssertEqual(c2.keywords, ["mono"])
        let meta2 = XMPParser.parseMetadata(xml)
        XCTAssertEqual(meta2.city, "Tokyo")
        XCTAssertEqual(meta2.creator, "Hiroshi Sugimoto")
    }

    // MARK: - Per-platform byte-stable round-trip

    /// `serialize → parseMetadata → serialize` yields the same string on Apple.
    func testByteStableRoundTrip() {
        var meta = XmpMetadata()
        meta.gpsLatitude = 48.8566
        meta.gpsLongitude = 2.3522
        meta.gpsAltitude = 35.0
        meta.city = "Paris"
        meta.title = "Sunset"
        meta.copyrightStatus = .copyrighted

        let xml1 = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: meta)
        let parsed = XMPParser.parseMetadata(xml1)
        let xml2 = XMPSerializer.serialize(model: .default, culling: CullingState(), metadata: parsed)
        XCTAssertEqual(xml2, xml1, "serialize → parseMetadata → serialize must be byte-stable")
    }

    // MARK: - Cross-parser semantic parity (TS-serialized sidecar → Swift parser)

    /// Parse a sidecar produced by the TypeScript serializer and confirm the Swift
    /// parser recovers the same field set and values.  The embedded fixture uses
    /// the TS wire format (slightly different namespace ordering + papp: URI, but
    /// the values are identical). Verified against `xmp-metadata-roundtrip.spec.ts`.
    func testCrossParserSemanticParity() {
        // This sidecar was produced by the TypeScript XmpSerializerService for:
        //   gpsLatitude=48.8566, gpsLongitude=2.3522, gpsAltitude=35,
        //   city="Paris", title="Sunset", creator="Ansel Adams",
        //   copyrightStatus="copyrighted", copyrightNotice="© 2026 Z. Lawrence"
        // The TS serializer formats GPS as "48,51.3960N" / "2,21.1320E".
        let tsXml = """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple Hosted 0.1.0">
         <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
            xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            xmlns:papp="http://ns.justmaple.app/photo/1.0/"
            xmlns:exif="http://ns.adobe.com/exif/1.0/"
            xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
            xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
           crs:Version="11.0"
           crs:ProcessVersion="11.0"
           crs:HasSettings="True"
           exif:GPSLatitude="48,51.3960N"
           exif:GPSLongitude="2,21.1320E"
           exif:GPSAltitude="35000/1000"
           exif:GPSAltitudeRef="0"
           photoshop:City="Paris"
           xmpRights:Marked="True">
          <dc:title>
           <rdf:Alt>
            <rdf:li xml:lang="x-default">Sunset</rdf:li>
           </rdf:Alt>
          </dc:title>
          <dc:creator>
           <rdf:Seq>
            <rdf:li>Ansel Adams</rdf:li>
           </rdf:Seq>
          </dc:creator>
          <dc:rights>
           <rdf:Alt>
            <rdf:li xml:lang="x-default">© 2026 Z. Lawrence</rdf:li>
           </rdf:Alt>
          </dc:rights>
          </rdf:Description>
         </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
        let parsed = XMPParser.parseMetadata(tsXml)
        XCTAssertEqual(parsed.gpsLatitude!, 48.8566, accuracy: 1e-4)
        XCTAssertEqual(parsed.gpsLongitude!, 2.3522, accuracy: 1e-4)
        XCTAssertEqual(parsed.gpsAltitude!, 35.0, accuracy: 0.001)
        XCTAssertEqual(parsed.city, "Paris")
        XCTAssertEqual(parsed.title, "Sunset")
        XCTAssertEqual(parsed.creator, "Ansel Adams")
        XCTAssertEqual(parsed.copyrightStatus, .copyrighted)
        XCTAssertEqual(parsed.copyrightNotice, "© 2026 Z. Lawrence")
    }

    // MARK: - Metadata attr parts fixed field order

    /// `metadataAttrParts` always emits GPS → datetime → location → rights in the
    /// canonical TS order, regardless of which fields are set.
    func testMetadataAttrPartsFixedOrder() {
        var meta = XmpMetadata()
        meta.gpsLatitude  = 1.0
        meta.gpsLongitude = 2.0
        meta.gpsAltitude  = 10.0
        meta.city         = "City"
        meta.copyrightStatus = .copyrighted

        let parts = XMPSerializer.metadataAttrParts(meta)
        let keys = parts.map { $0.0 }
        // GPS lat must precede lon must precede alt.
        let latIdx = keys.firstIndex(of: "exif:GPSLatitude")!
        let lonIdx = keys.firstIndex(of: "exif:GPSLongitude")!
        let altIdx = keys.firstIndex(of: "exif:GPSAltitude")!
        let refIdx = keys.firstIndex(of: "exif:GPSAltitudeRef")!
        let cityIdx = keys.firstIndex(of: "photoshop:City")!
        let markedIdx = keys.firstIndex(of: "xmpRights:Marked")!
        XCTAssertLessThan(latIdx, lonIdx)
        XCTAssertLessThan(lonIdx, altIdx)
        XCTAssertLessThan(altIdx, refIdx)
        XCTAssertLessThan(refIdx, cityIdx)
        XCTAssertLessThan(cityIdx, markedIdx)
    }

    // MARK: - xmpRights:Marked nil/omit parity with TS (#1611)

    /// An unknown `xmpRights:Marked` value must leave `copyrightStatus` nil,
    /// not set it to `.unknown`. Mirrors TS `copyrightStatusFromMarked` which
    /// returns `null` for unrecognised strings.
    func testCopyrightStatusUnknownMarkedValueLeavesNil() {
        let xml = """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
              xmpRights:Marked="Unknown"/>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertNil(parsed.copyrightStatus,
            "Unknown xmpRights:Marked value must leave copyrightStatus nil, not .unknown")
    }

    /// Absent `xmpRights:Marked` must leave `copyrightStatus` nil.
    func testCopyrightStatusAbsentMarkedLeavesNil() {
        let xml = """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
              photoshop:City="Paris"/>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertNil(parsed.copyrightStatus,
            "Absent xmpRights:Marked must leave copyrightStatus nil")
    }

    // MARK: - Altitude parsing canonical-form restriction (#1611)

    /// Non-canonical altitude forms (float or signed numerator/denominator)
    /// must be rejected, matching the TS regex `^(\d+)\/(\d+)$`.
    func testAltitudeFromXmpRejectsNonCanonicalForms() {
        // Float numerator — the canonical encoder never emits this.
        XCTAssertNil(altitudeFromXmp(value: "35.5/1", ref: "0"),
            "Float numerator must be rejected")
        // Float denominator.
        XCTAssertNil(altitudeFromXmp(value: "35000/1.0", ref: "0"),
            "Float denominator must be rejected")
        // Signed numerator — sign is encoded in ref, not in the value.
        XCTAssertNil(altitudeFromXmp(value: "-35000/1000", ref: "0"),
            "Signed numerator must be rejected")
    }

    // MARK: - Builder refactor byte-identity (#1611)

    /// With the native builder path, `serialize(model:culling:metadata:)` with
    /// empty `XmpMetadata()` must produce output that is byte-identical to the
    /// base `serialize(model:culling:)` call. Guards that the refactor did not
    /// change any output.
    func testBuilderRefactorEmptyMetadataByteIdentity() {
        let models: [AdjustmentModel] = [.default, {
            var m = AdjustmentModel()
            m.exposure = 1.5
            m.highlights = -30
            return m
        }()]
        let cullings: [CullingState] = [
            CullingState(),
            CullingState(stars: 3, flag: .pick, keywords: ["mono", "city"]),
        ]
        for model in models {
            for culling in cullings {
                let base = XMPSerializer.serialize(model: model, culling: culling)
                let withEmpty = XMPSerializer.serialize(model: model, culling: culling, metadata: XmpMetadata())
                XCTAssertEqual(base, withEmpty,
                    "Empty XmpMetadata must produce byte-identical output to base overload")
            }
        }
    }
}
