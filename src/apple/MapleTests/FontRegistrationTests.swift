// FontRegistrationTests.swift — verify bundled fonts resolve at runtime.
//
// Per docs/design/responsive-program/s0-primitives.md §5.2: SwiftUI silently
// falls back to the system font when `Font.custom("name", size:)` cannot
// resolve the requested name. The visible regression is subtle (line
// metrics shift, character shapes change slightly) and easy to miss in a
// screenshot review. A direct UIFont/NSFont lookup against the runtime
// font tables catches the bad-registration case loudly.
//
// The MapleTests Xcode target is host-targeted on Maple.app, so the actual
// loader — `CTFontManagerRegisterFontsForURL` called from `MapleApp.init`
// — has run by the time the test fires. The `INFOPLIST_KEY_UIAppFonts`
// build setting in project.pbxproj is kept for forward compatibility (it
// will become the loader once the Xcode 17 / SDK 26.4 Info.plist
// synthesizer allowlists the key — verified empirically that today's
// synthesizer does not emit `UIAppFonts` into the built plist), but until
// then the Core Text path in `MapleApp.swift` is what populates the font
// registry these assertions read from. A `swift test` in the SPM package
// runs without an app bundle (no MapleApp init, no Core Text registration)
// and would fail this test even when wiring is correct — that is why this
// file lives in the Xcode test target, not in
// `Packages/MapleCore/Tests/MapleCoreTests/`.

import XCTest

#if os(iOS) || os(tvOS) || os(visionOS)
import UIKit
typealias PlatformFont = UIFont
#elseif os(macOS)
import AppKit
typealias PlatformFont = NSFont
#endif

final class FontRegistrationTests: XCTestCase {
    /// Lato Regular (400) — body, rowLabel, toolLabel.
    func testLatoRegularResolves() {
        XCTAssertNotNil(
            PlatformFont(name: "Lato-Regular", size: 14),
            "Lato-Regular missing — check the CTFontManagerRegisterFontsForURL " +
            "call in MapleApp.init (and the future INFOPLIST_KEY_UIAppFonts " +
            "path in project.pbxproj) and that Fonts/Lato-Regular.ttf is in " +
            "the app bundle.")
    }

    /// Lato Bold (700) — chipLabel, eyebrow.
    func testLatoBoldResolves() {
        XCTAssertNotNil(
            PlatformFont(name: "Lato-Bold", size: 11),
            "Lato-Bold missing — check the CTFontManagerRegisterFontsForURL " +
            "call in MapleApp.init (and the future INFOPLIST_KEY_UIAppFonts " +
            "path in project.pbxproj) and that Fonts/Lato-Bold.ttf is in the " +
            "app bundle.")
    }

    /// Merriweather Bold (700) — sourceTitle, sheetTitle.
    func testMerriweatherBoldResolves() {
        XCTAssertNotNil(
            PlatformFont(name: "Merriweather-Bold", size: 17),
            "Merriweather-Bold missing — check the CTFontManagerRegisterFontsForURL " +
            "call in MapleApp.init (and the future INFOPLIST_KEY_UIAppFonts " +
            "path in project.pbxproj) and that Fonts/Merriweather-Bold.ttf " +
            "is in the app bundle.")
    }
}
