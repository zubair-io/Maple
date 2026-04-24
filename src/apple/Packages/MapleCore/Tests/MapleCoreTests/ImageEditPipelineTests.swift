import CoreImage
import XCTest
@testable import MapleCore

final class ImageEditPipelineTests: XCTestCase {
    func testProcessHonorsTargetSizeForDisplayPreview() {
        let pipeline = ImageEditPipeline()
        let decoded = CIImage(color: CIColor(red: 0.25, green: 0.5, blue: 0.75))
            .cropped(to: CGRect(x: 0, y: 0, width: 1000, height: 500))

        let processed = pipeline.process(
            decoded: decoded,
            model: .default,
            targetSize: CGSize(width: 200, height: 200)
        )

        XCTAssertEqual(processed.extent.width, 200, accuracy: 0.01)
        XCTAssertEqual(processed.extent.height, 100, accuracy: 0.01)
    }
}
