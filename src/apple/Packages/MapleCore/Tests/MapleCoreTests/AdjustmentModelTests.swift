import XCTest
@testable import MapleCore

final class AdjustmentModelTests: XCTestCase {

    // MARK: - Defaults

    func testDefaultTemperature() { XCTAssertEqual(AdjustmentModel.default.temperature, 6500) }
    func testDefaultExposure() { XCTAssertEqual(AdjustmentModel.default.exposure, 0) }
    func testDefaultNrColor() { XCTAssertEqual(AdjustmentModel.default.nrColor, 25) }
    func testDefaultHighlightRecovery() {
        XCTAssertEqual(AdjustmentModel.default.highlightRecovery, .off)
    }

    /// Ticket 12 Bug 3 / #326 — first-open of a sidecar-less RAW must apply
    /// ACR's import baseline (Sharpness=40, Radius=1.0) so the preview is
    /// no softer than Adobe Camera Raw's. Apple historically carried a
    /// 45/1.0 override; #326 converges all platforms onto the canonical
    /// 40/1.0 ACR values.
    func testDefaultSharpeningMatchesACRRawProfile() {
        XCTAssertEqual(AdjustmentModel.default.sharpenAmount, 40)
        XCTAssertEqual(AdjustmentModel.default.sharpenRadius, 1.0)
    }

    /// Capture sharpening (#271) ships off by default so the parity harness
    /// stays bit-identical to pre-#271 behaviour. Per-camera defaults are a
    /// follow-up calibration ticket.
    func testDefaultCaptureSharpeningIsOff() {
        XCTAssertEqual(AdjustmentModel.default.captureSharpeningAmount, 0)
        XCTAssertEqual(AdjustmentModel.default.captureSharpeningRadius, 1.0)
    }

    func testParseCaptureSharpeningAttributes() throws {
        let xml = xmp(attrs: #"papp:CaptureSharpeningAmount="65" papp:CaptureSharpeningRadius="1.5""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.captureSharpeningAmount, 65)
        XCTAssertEqual(m.captureSharpeningRadius, 1.5, accuracy: 0.01)
    }

    func testCaptureSharpeningRoundTrip() throws {
        var m = AdjustmentModel()
        m.captureSharpeningAmount = 55
        m.captureSharpeningRadius = 1.5
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.captureSharpeningAmount, 55)
        XCTAssertEqual(m2.captureSharpeningRadius, 1.5, accuracy: 0.01)
    }

    // MARK: - XMP Parse

    func testParseExposure() throws {
        let xml = xmp(attrs: #"crs:Exposure2012="1.50""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.exposure, 1.50, accuracy: 0.01)
    }

    func testParseContrast() throws {
        let xml = xmp(attrs: #"crs:Contrast2012="100""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.contrast, 100)
    }

    func testParseVibrance() throws {
        let xml = xmp(attrs: #"crs:Vibrance="75""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.vibrance, 75)
    }

    func testParseDehaze() throws {
        let xml = xmp(attrs: #"crs:Dehaze="100""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.dehaze, 100)
    }

    func testParseWBDaylight() throws {
        let xml = xmp(attrs: #"crs:WhiteBalance="Daylight""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.temperature, 5500, accuracy: 1)
        XCTAssertEqual(m.tint, 10, accuracy: 0.1)
    }

    func testParseExplicitTempOverridesPreset() throws {
        let xml = xmp(attrs: #"crs:WhiteBalance="Daylight" crs:Temperature="3200""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.temperature, 3200, accuracy: 1)
    }

    func testParseHighlightRecoveryBlend() throws {
        let xml = xmp(attrs: #"papp:HighlightRecoveryMode="Blend""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.highlightRecovery, .blend)
    }

    func testParseStars() throws {
        let xml = xmp(attrs: #"xmp:Rating="4""#)
        let (_, c) = try XMPParser.parse(xml)
        XCTAssertEqual(c.stars, 4)
    }

    func testUnknownAttributesIgnored() throws {
        let xml = xmp(attrs: #"crs:Exposure2012="2.0" crs:FutureThing="99""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.exposure, 2.0, accuracy: 0.01)
    }

    // MARK: - Serializer round-trip

    func testRoundTrip() throws {
        var m = AdjustmentModel()
        m.exposure = 1.5
        m.vibrance = 50
        m.highlights = -80
        m.highlightRecovery = .luminance
        let c = CullingState(stars: 3, flag: .pick)
        let xml = XMPSerializer.serialize(model: m, culling: c)
        let (m2, c2) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.exposure, m.exposure, accuracy: 0.01)
        XCTAssertEqual(m2.vibrance, m.vibrance, accuracy: 0.1)
        XCTAssertEqual(m2.highlights, m.highlights, accuracy: 0.1)
        XCTAssertEqual(m2.highlightRecovery, .luminance)
        XCTAssertEqual(c2.stars, 3)
        XCTAssertEqual(c2.flag, .pick)
    }

    // MARK: - XMPSidecarStore

    func testSidecarStoreWriteAndRead() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        defer {
            let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
            try? FileManager.default.removeItem(at: xmpURL)
        }

        let store = XMPSidecarStore(rawURL: tmp)
        var m = AdjustmentModel()
        m.exposure = 0.75
        await store.update(model: m, culling: CullingState(stars: 2, flag: .none))
        await store.flush()

        // Read back
        let (m2, c2) = try await store.load()
        // Because we cached, this should return the in-memory state.
        XCTAssertEqual(m2.exposure, 0.75, accuracy: 0.01)
        XCTAssertEqual(c2.stars, 2)
    }

    // MARK: - Helpers

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
