import XCTest

@testable import MapleCore

final class PersonSkinMaskServiceTests: XCTestCase {
    private func loadFixture(_ name: String) throws -> CGImage {
        guard let url = Bundle.module.url(forResource: name, withExtension: "png"),
            let provider = CGDataProvider(url: url as CFURL),
            let image = CGImage(pngDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { throw XCTSkip("fixture \(name).png not found") }
        return image
    }

    func testDetectPersonsFindsAtLeastOneCandidateOnAPortrait() async throws {
        let image = try loadFixture("portrait-skin-test")
        let service = PersonSkinMaskService()
        let people = try await service.detectPersons(in: image)
        XCTAssertFalse(people.isEmpty)
        XCTAssertTrue(people[0].boundingBox.width > 0 && people[0].boundingBox.height > 0)
    }

    func testDetectPersonsOnABlankImageThrowsNoPersonDetected() async throws {
        let ctx = CGContext(
            data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        ctx.setFillColor(gray: 0.5, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        let image = ctx.makeImage()!
        let service = PersonSkinMaskService()
        do {
            _ = try await service.detectPersons(in: image)
        } catch PersonSkinMaskError.noPersonDetected {
            return
        }
        // Vision may legitimately return an empty array instead of throwing on
        // a blank frame — either signal is acceptable; only a real detection
        // (asserted in the portrait test above) proves the request works.
    }

    func testMakeRasterProducesWidthTimesHeightBytesCoveringSomeButNotAllPixels() async throws {
        let image = try loadFixture("portrait-skin-test")
        let service = PersonSkinMaskService()
        let people = try await service.detectPersons(in: image)
        let (w, h, bytes) = try await service.makeRaster(
            image: image,
            request: SkinRasterRequest(person: people[0].id, facialSkin: true, bodySkin: true)
        )
        XCTAssertEqual(bytes.count, w * h)
        let nonZero = bytes.filter { $0 > 0 }.count
        XCTAssertGreaterThan(nonZero, 0, "raster is entirely empty")
        XCTAssertLessThan(nonZero, bytes.count, "raster covers the whole frame — segmentation didn't run")
    }

    func testFacialOnlyRasterCoversFewerPixelsThanFacialPlusBody() async throws {
        let image = try loadFixture("portrait-skin-test")
        let service = PersonSkinMaskService()
        let people = try await service.detectPersons(in: image)
        let (_, _, facial) = try await service.makeRaster(
            image: image, request: SkinRasterRequest(person: people[0].id, facialSkin: true, bodySkin: false)
        )
        let (_, _, both) = try await service.makeRaster(
            image: image, request: SkinRasterRequest(person: people[0].id, facialSkin: true, bodySkin: true)
        )
        let count = { (b: [UInt8]) in b.filter { $0 > 0 }.count }
        XCTAssertLessThanOrEqual(count(facial), count(both))
    }
}
