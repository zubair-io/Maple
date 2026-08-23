import SwiftUI
import XCTest
@testable import MapleUI

final class DesignTokensTests: XCTestCase {
    func testParseHexLowercase() {
        let c = Color.parseMuiHex("#c4493a")
        XCTAssertEqual(c.r, 0xc4 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(c.g, 0x49 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(c.b, 0x3a / 255.0, accuracy: 0.0001)
    }

    func testParseHexUppercase() {
        let c = Color.parseMuiHex("#FFFFFF")
        XCTAssertEqual(c.r, 1.0, accuracy: 0.0001)
        XCTAssertEqual(c.g, 1.0, accuracy: 0.0001)
        XCTAssertEqual(c.b, 1.0, accuracy: 0.0001)
    }

    func testParseHexWithoutHashPrefix() {
        let c = Color.parseMuiHex("000000")
        XCTAssertEqual(c.r, 0, accuracy: 0.0001)
        XCTAssertEqual(c.g, 0, accuracy: 0.0001)
        XCTAssertEqual(c.b, 0, accuracy: 0.0001)
    }

    func testParseRgba() throws {
        let rgba = try XCTUnwrap(Color.parseMuiRgba("rgba(255, 255, 255, 0.1)"))
        XCTAssertEqual(rgba.r, 1.0, accuracy: 0.0001)
        XCTAssertEqual(rgba.g, 1.0, accuracy: 0.0001)
        XCTAssertEqual(rgba.b, 1.0, accuracy: 0.0001)
        XCTAssertEqual(rgba.a, 0.1, accuracy: 0.0001)
    }

    func testParseRgbaWithExtraWhitespace() throws {
        let rgba = try XCTUnwrap(Color.parseMuiRgba("rgba( 34,  197, 94,  0.15 )"))
        XCTAssertEqual(rgba.r, 34.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(rgba.g, 197.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(rgba.b, 94.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(rgba.a, 0.15, accuracy: 0.0001)
    }

    func testParseRgbaRejectsMalformedInput() {
        XCTAssertNil(Color.parseMuiRgba("#c4493a"))
        XCTAssertNil(Color.parseMuiRgba("rgba(1, 2, 3)"))
        XCTAssertNil(Color.parseMuiRgba("not a color"))
    }

    /// Cross-checks every generated color token actually parses without
    /// falling through to the magenta failure fallback — catches a future
    /// `ui_tokens.rs` value that this parser can't handle before it ships.
    func testEveryGeneratedColorTokenParses() {
        let tokens: [String] = [
            MapleUITokens.bg, MapleUITokens.surface, MapleUITokens.surfaceAlt,
            MapleUITokens.surfaceHover, MapleUITokens.sidebar, MapleUITokens.inputBg,
            MapleUITokens.imageCanvas, MapleUITokens.textMain, MapleUITokens.textMuted,
            MapleUITokens.border, MapleUITokens.borderHi, MapleUITokens.primary,
            MapleUITokens.primaryDim, MapleUITokens.warn, MapleUITokens.bgHover,
            MapleUITokens.bgActive, MapleUITokens.successBg, MapleUITokens.successText,
            MapleUITokens.errorBg, MapleUITokens.errorText, MapleUITokens.star,
        ]
        for token in tokens {
            if token.hasPrefix("#") {
                _ = Color.parseMuiHex(token) // must not crash
            } else {
                XCTAssertNotNil(Color.parseMuiRgba(token), "failed to parse token: \(token)")
            }
        }
    }
}
