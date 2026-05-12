import XCTest
@testable import MapleBackup

final class PayloadAssemblerTests: XCTestCase {

    private let captureDate = Date(timeIntervalSince1970: 1_700_000_000)

    private func makeInput(
        favorite: Bool = false,
        caption: String? = nil,
        keywords: [String] = [],
        tags: [String] = [],
        live: String? = nil,
        burst: String? = nil,
        lat: Double? = nil,
        lon: Double? = nil
    ) -> PayloadAssembler.SidecarInput {
        PayloadAssembler.SidecarInput(
            phassetLocalId: "ABC/L0/001",
            deviceId: "uuid-1",
            captureDate: captureDate,
            latitude: lat, longitude: lon,
            favorite: favorite,
            caption: caption,
            keywords: keywords,
            tags: tags,
            livePhotoCompanion: live,
            burstStackId: burst,
            originalFilename: "IMG_0420.HEIC",
            mtime: 1_700_000_000)
    }

    func testCarriesEveryDocumentedField() {
        let xml = PayloadAssembler.buildSidecarXMP(input: makeInput(
            favorite: true,
            caption: "Cherry blossoms",
            keywords: ["spring", "japan"],
            tags: ["Trips", "Tokyo"],
            live: "IMG_0420.mov",
            burst: "BURST-123",
            lat: 35.68,
            lon: 139.69
        ))
        XCTAssertTrue(xml.contains(#"maple:phassetLocalId="ABC/L0/001""#))
        XCTAssertTrue(xml.contains(#"maple:deviceId="uuid-1""#))
        XCTAssertTrue(xml.contains(#"maple:favorite="True""#))
        XCTAssertTrue(xml.contains(#"maple:caption="Cherry blossoms""#))
        XCTAssertTrue(xml.contains(#"maple:livePhotoCompanion="IMG_0420.mov""#))
        XCTAssertTrue(xml.contains(#"maple:burstStackId="BURST-123""#))
        XCTAssertTrue(xml.contains(#"maple:originalFilename="IMG_0420.HEIC""#))
        XCTAssertTrue(xml.contains(#"maple:gpsLat="35.68""#))
        XCTAssertTrue(xml.contains(#"maple:gpsLon="139.69""#))
        XCTAssertTrue(xml.contains("<rdf:li>spring</rdf:li>"))
        XCTAssertTrue(xml.contains("<rdf:li>japan</rdf:li>"))
        XCTAssertTrue(xml.contains("<rdf:li>Trips</rdf:li>"))
        XCTAssertTrue(xml.contains("<rdf:li>Tokyo</rdf:li>"))
    }

    func testEmptyKeywordsAndTagsProduceEmptyBags() {
        let xml = PayloadAssembler.buildSidecarXMP(input: makeInput())
        XCTAssertTrue(xml.contains("<maple:keywords><rdf:Bag></rdf:Bag></maple:keywords>"))
        XCTAssertTrue(xml.contains("<maple:tags><rdf:Bag></rdf:Bag></maple:tags>"))
    }

    func testFalseFavoriteEmittedAsFalse() {
        let xml = PayloadAssembler.buildSidecarXMP(input: makeInput(favorite: false))
        XCTAssertTrue(xml.contains(#"maple:favorite="False""#))
    }

    func testNilGPSEmittedAsEmptyString() {
        let xml = PayloadAssembler.buildSidecarXMP(input: makeInput(lat: nil, lon: nil))
        XCTAssertTrue(xml.contains(#"maple:gpsLat="""#))
        XCTAssertTrue(xml.contains(#"maple:gpsLon="""#))
    }

    func testCaptionQuoteCharEscaped() {
        let xml = PayloadAssembler.buildSidecarXMP(input: makeInput(caption: #"She said "hi""#))
        // The literal " is escaped to &quot;; the original double-quote MUST NOT
        // appear inside the attribute value or the XML breaks.
        XCTAssertTrue(xml.contains(#"maple:caption="She said &quot;hi&quot;""#))
    }

    func testCaptureDateIsISO8601() {
        let xml = PayloadAssembler.buildSidecarXMP(input: makeInput())
        // 2023-11-14T22:13:20Z is the ISO form of timeIntervalSince1970 1700000000
        XCTAssertTrue(xml.contains(#"maple:captureDate="2023-11-14T22:13:20Z""#))
    }
}
