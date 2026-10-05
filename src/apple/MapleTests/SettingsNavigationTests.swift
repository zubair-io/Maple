// SettingsNavigationTests.swift — unit tests for SettingsNavigation and SettingsTab (#4245).

import Foundation
import XCTest

@testable import Maple

final class SettingsNavigationTests: XCTestCase {

  private var testDefaults: UserDefaults!
  private var suiteName: String!

  override func setUp() {
    super.setUp()
    suiteName = "test.maple.settings.\(UUID().uuidString)"
    testDefaults = UserDefaults(suiteName: suiteName)!
  }

  override func tearDown() {
    testDefaults.removePersistentDomain(forName: suiteName)
    testDefaults = nil
    suiteName = nil
    super.tearDown()
  }

  func testAllSettingsTabCasesHaveMatchingIDs() {
    for tab in SettingsTab.allCases {
      XCTAssertEqual(tab.id, tab.rawValue)
      XCTAssertFalse(tab.rawValue.isEmpty)
    }
  }

  func testTargetTabDefaultsToGeneralWhenKeyIsAbsent() {
    let tab = SettingsNavigation.targetTab(defaults: testDefaults)
    XCTAssertEqual(tab, .general)
  }

  func testTargetTabDefaultsToGeneralWhenKeyIsInvalid() {
    testDefaults.set("invalid_tab_name", forKey: SettingsNavigation.tabDefaultsKey)
    let tab = SettingsNavigation.targetTab(defaults: testDefaults)
    XCTAssertEqual(tab, .general)
  }

  func testSetAndGetTargetTabRoundTrips() {
    for tab in SettingsTab.allCases {
      SettingsNavigation.setTargetTab(tab, defaults: testDefaults)
      XCTAssertEqual(SettingsNavigation.targetTab(defaults: testDefaults), tab)
    }
  }

  func testResolveInitialTabWithPanoWhenEnabled() {
    let resolved = SettingsNavigation.resolveInitialTab(requested: .pano, isPanoEnabled: true)
    XCTAssertEqual(resolved, .pano)
  }

  func testResolveInitialTabWithPanoWhenDisabledFallsBackToGeneral() {
    let resolved = SettingsNavigation.resolveInitialTab(requested: .pano, isPanoEnabled: false)
    XCTAssertEqual(resolved, .general)
  }

  func testResolveInitialTabWithNilDefaultsToGeneral() {
    let resolved = SettingsNavigation.resolveInitialTab(requested: nil, isPanoEnabled: true)
    XCTAssertEqual(resolved, .general)
  }

  func testResolveInitialTabWithStandardTabsPreservesSelectionRegardlessOfPanoFlag() {
    let standardTabs: [SettingsTab] = [
      .general, .backup, .selfHosted, .sources, .observability, .finder, .mapleUIGallery, .about,
    ]
    for tab in standardTabs {
      XCTAssertEqual(
        SettingsNavigation.resolveInitialTab(requested: tab, isPanoEnabled: false), tab)
      XCTAssertEqual(SettingsNavigation.resolveInitialTab(requested: tab, isPanoEnabled: true), tab)
    }
  }
}
