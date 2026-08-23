import XCTest
@testable import MapleUI

final class MuiHslPanelTests: XCTestCase {
    private let band = MuiHslBandValue(hue: 12, saturation: -8, luminance: 4)

    func testValueReadsHue() {
        XCTAssertEqual(MuiHslPanel.value(band, for: .hue), 12)
    }

    func testValueReadsSaturation() {
        XCTAssertEqual(MuiHslPanel.value(band, for: .saturation), -8)
    }

    func testValueReadsLuminance() {
        XCTAssertEqual(MuiHslPanel.value(band, for: .luminance), 4)
    }

    func testDefaultBandsCoversAllEightHslBands() {
        XCTAssertEqual(
            MuiHslPanel.defaultBands.map(\.id),
            ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"]
        )
    }
}
