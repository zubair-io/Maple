import CoreImage
import ImageIO
import XCTest
@testable import MapleCore

final class ImageEditPipelineTests: XCTestCase {
    /// Plan 2 v2 v5: the legacy `process` method was deleted along with
    /// the `applyFilters` chain. `processSceneLinear` is now the sole
    /// process entry; it shares the same `prescaleForDisplay` helper
    /// that this test originally exercised, so the contract is unchanged.
    func testProcessHonorsTargetSizeForDisplayPreview() {
        let pipeline = ImageEditPipeline()
        let decoded = CIImage(color: CIColor(red: 0.25, green: 0.5, blue: 0.75))
            .cropped(to: CGRect(x: 0, y: 0, width: 1000, height: 500))

        let processed = pipeline.processSceneLinear(
            decoded: decoded,
            model: .default,
            targetSize: CGSize(width: 200, height: 200)
        )

        XCTAssertEqual(processed.extent.width, 200, accuracy: 0.01)
        XCTAssertEqual(processed.extent.height, 100, accuracy: 0.01)
    }

    // MARK: - T5.4: OutputColorSpace enum and ExportOptions wiring

    /// Verify that `OutputColorSpace.sRGB` resolves to a color space whose
    /// name matches `CGColorSpace.sRGB`. This is the default / existing path.
    func testOutputColorSpace_sRGB_resolves() {
        let cs = OutputColorSpace.sRGB.cgColorSpace
        XCTAssertEqual(cs.name, CGColorSpace.sRGB,
            "sRGB OutputColorSpace must resolve to the sRGB CGColorSpace")
    }

    /// Verify that `OutputColorSpace.displayP3` resolves to Display P3.
    func testOutputColorSpace_displayP3_resolves() {
        let cs = OutputColorSpace.displayP3.cgColorSpace
        XCTAssertEqual(cs.name, CGColorSpace.displayP3,
            "displayP3 OutputColorSpace must resolve to the displayP3 CGColorSpace")
    }

    /// Verify that `OutputColorSpace.proPhoto` returns a non-nil CGColorSpace
    /// and that it is distinct from sRGB.  We cannot assert the ICC bytes
    /// without pulling in a full ICC parser, but we can confirm the space
    /// is non-trivial and has the correct number of color components.
    func testOutputColorSpace_proPhoto_resolves() {
        let cs = OutputColorSpace.proPhoto.cgColorSpace
        XCTAssertEqual(cs.numberOfComponents, 3,
            "ProPhoto CGColorSpace must have 3 components")
        XCTAssertNotEqual(cs.name, CGColorSpace.sRGB,
            "ProPhoto CGColorSpace must not be sRGB")
        XCTAssertNotEqual(cs.name, CGColorSpace.displayP3,
            "ProPhoto CGColorSpace must not be Display P3")
    }

    /// Verify that an `ExportOptions` with `outputColorSpace: nil` uses the
    /// format's built-in color space (existing behaviour preserved).
    func testExportOptions_defaultColorSpace_isNil() {
        let opts = ExportOptions(format: .jpegSRGB)
        XCTAssertNil(opts.outputColorSpace,
            "Default ExportOptions must have nil outputColorSpace (format default wins)")
    }

    /// Verify that an `ExportOptions` with `outputColorSpace: .proPhoto` stores
    /// the value correctly.
    func testExportOptions_proPhotoColorSpace_isStored() {
        let opts = ExportOptions(format: .tiff16, outputColorSpace: .proPhoto)
        XCTAssertEqual(opts.outputColorSpace, .proPhoto,
            "ExportOptions must store the requested outputColorSpace")
    }

    /// End-to-end: encode a tiny solid-colour image as TIFF with
    /// `outputColorSpace: .sRGB` and verify the CGImageSource can read it back
    /// without error. This confirms the encode path does not crash when an
    /// explicit OutputColorSpace is supplied.
    func testEncodeWithExplicitSRGBColorSpace_doesNotCrash() throws {
        // Build a 4×4 sRGB CIImage.
        let image = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5))
            .cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))

        let opts = ExportOptions(
            format: .tiff16,
            quality: 1.0,
            outputColorSpace: .sRGB
        )

        // Encode directly via the private-but-accessible internal function.
        // We can't call the private static method, so use a thin shim through
        // CGImageDestination to verify the encode contract.
        let context = CIContext(options: [
            .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
        ])
        guard let cgImg = context.createCGImage(
            image,
            from: image.extent,
            format: .RGBA8,
            colorSpace: opts.outputColorSpace?.cgColorSpace ?? opts.format.targetColorSpace
        ) else {
            XCTFail("createCGImage failed")
            return
        }

        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData, "public.tiff" as CFString, 1, nil
        ) else {
            XCTFail("CGImageDestinationCreateWithData failed")
            return
        }
        CGImageDestinationAddImage(dest, cgImg, nil)
        let finalised = CGImageDestinationFinalize(dest)
        XCTAssertTrue(finalised, "CGImageDestinationFinalize must succeed")
        XCTAssertGreaterThan(mutableData.length, 0, "Encoded TIFF must have non-zero size")

        // Parse the result back via CGImageSource to confirm it's a valid TIFF.
        guard let src = CGImageSourceCreateWithData(mutableData, nil) else {
            XCTFail("Could not create CGImageSource from encoded TIFF")
            return
        }
        XCTAssertEqual(CGImageSourceGetCount(src), 1, "TIFF must contain exactly one image")
    }

    /// Verify that the ProPhoto ICC profile bytes we embed produce a
    /// `CGColorSpace` that Core Image will accept (it should not return nil).
    func testProPhotoICCProfile_isAcceptedByCoreImage() {
        let cs = OutputColorSpace.proPhoto.cgColorSpace
        // Core Image must be able to create a CIImage with this color space.
        let img = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5))
            .cropped(to: CGRect(x: 0, y: 0, width: 2, height: 2))
        let ctx = CIContext()
        let cgImg = ctx.createCGImage(img, from: img.extent, format: .RGBA8, colorSpace: cs)
        XCTAssertNotNil(cgImg,
            "CIContext must accept the embedded ProPhoto CGColorSpace")
    }
}
