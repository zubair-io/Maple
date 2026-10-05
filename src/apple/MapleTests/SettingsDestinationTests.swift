import MapleCore
import XCTest

@testable import Maple

final class SettingsDestinationTests: XCTestCase {
  func testAllTabsBelongToExpectedSections() {
    XCTAssertEqual(SettingsTab.general.section, .general)
    XCTAssertEqual(SettingsTab.backup.section, .general)
    XCTAssertEqual(SettingsTab.selfHosted.section, .general)
    XCTAssertEqual(SettingsTab.pano.section, .general)
    XCTAssertEqual(SettingsTab.observability.section, .observability)
    XCTAssertEqual(SettingsTab.sources.section, .files)
    XCTAssertEqual(SettingsTab.finder.section, .files)
    XCTAssertEqual(SettingsTab.about.section, .app)
    XCTAssertEqual(SettingsTab.mapleUIGallery.section, .app)
  }

  func testFinderTabLabelMatchesPlatform() {
    #if os(macOS)
      XCTAssertEqual(SettingsTab.finder.label, "Finder")
    #else
      XCTAssertEqual(SettingsTab.finder.label, "Files")
    #endif
  }

  func testPanoramaVisibilityMatchesFeatureFlag() {
    XCTAssertEqual(SettingsTab.pano.isVisible, FeatureFlags.isPanoramaEnabled)
  }

  func testAccessibilityIdentifiers() {
    XCTAssertEqual(SettingsTab.sources.accessibilityIdentifier, "settings.tab.sources")
    XCTAssertEqual(SettingsTab.pano.accessibilityIdentifier, "settings.tab.pano")
    XCTAssertEqual(SettingsTab.about.accessibilityIdentifier, "settings.tab.about")
    XCTAssertNil(SettingsTab.general.accessibilityIdentifier)
  }

  func testAllSectionsCoverAllTabs() {
    let allTabsFromSections = SettingsSection.allCases.flatMap { section in
      SettingsTab.allCases.filter { $0.section == section }
    }
    XCTAssertEqual(allTabsFromSections.count, SettingsTab.allCases.count)
  }
}
