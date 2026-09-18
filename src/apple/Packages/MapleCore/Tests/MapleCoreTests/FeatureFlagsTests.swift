// FeatureFlagsTests.swift — Unit tests for FeatureFlags.

import Foundation
import XCTest

@testable import MapleCore

final class FeatureFlagsTests: XCTestCase {

  func testPrereleaseVersionDetection() {
    XCTAssertTrue(FeatureFlags.isPrereleaseVersion("0.0.5-test.1"))
    XCTAssertTrue(FeatureFlags.isPrereleaseVersion("0.1.0-alpha"))
    XCTAssertTrue(FeatureFlags.isPrereleaseVersion("1.0.0-beta.2"))
    XCTAssertTrue(FeatureFlags.isPrereleaseVersion("0.0.9-rc.1"))
    XCTAssertTrue(FeatureFlags.isPrereleaseVersion("0.0.1-dev"))

    XCTAssertFalse(FeatureFlags.isPrereleaseVersion("0.0.5"))
    XCTAssertFalse(FeatureFlags.isPrereleaseVersion("1.0.0"))
    XCTAssertFalse(FeatureFlags.isPrereleaseVersion("0.1.0"))
  }

  func testEnvironmentVariableOverride() {
    // Test cloud override
    setenv(FeatureFlags.cloudEnvVar, "0", 1)
    XCTAssertFalse(FeatureFlags.isMapleCloudEnabled)

    setenv(FeatureFlags.cloudEnvVar, "1", 1)
    XCTAssertTrue(FeatureFlags.isMapleCloudEnabled)

    unsetenv(FeatureFlags.cloudEnvVar)

    // Test pano override
    setenv(FeatureFlags.panoEnvVar, "0", 1)
    XCTAssertFalse(FeatureFlags.isPanoramaEnabled)

    setenv(FeatureFlags.panoEnvVar, "1", 1)
    XCTAssertTrue(FeatureFlags.isPanoramaEnabled)

    unsetenv(FeatureFlags.panoEnvVar)
  }

  func testMasterEarlyFeaturesEnvironmentVariable() {
    setenv(FeatureFlags.earlyFeaturesEnvVar, "0", 1)
    XCTAssertFalse(FeatureFlags.areEarlyFeaturesEnabled)
    XCTAssertFalse(FeatureFlags.isMapleCloudEnabled)
    XCTAssertFalse(FeatureFlags.isPanoramaEnabled)

    setenv(FeatureFlags.earlyFeaturesEnvVar, "1", 1)
    XCTAssertTrue(FeatureFlags.areEarlyFeaturesEnabled)
    XCTAssertTrue(FeatureFlags.isMapleCloudEnabled)
    XCTAssertTrue(FeatureFlags.isPanoramaEnabled)

    unsetenv(FeatureFlags.earlyFeaturesEnvVar)
  }

  func testUserDefaultsOverride() {
    // Clear before testing
    UserDefaults.standard.removeObject(forKey: FeatureFlags.earlyFeaturesKey)
    UserDefaults.standard.removeObject(forKey: FeatureFlags.cloudFeaturesKey)
    UserDefaults.standard.removeObject(forKey: FeatureFlags.panoFeaturesKey)

    UserDefaults.standard.set(false, forKey: FeatureFlags.earlyFeaturesKey)
    XCTAssertFalse(FeatureFlags.areEarlyFeaturesEnabled)
    XCTAssertFalse(FeatureFlags.isMapleCloudEnabled)
    XCTAssertFalse(FeatureFlags.isPanoramaEnabled)

    UserDefaults.standard.set(true, forKey: FeatureFlags.cloudFeaturesKey)
    XCTAssertTrue(FeatureFlags.isMapleCloudEnabled)
    XCTAssertFalse(FeatureFlags.isPanoramaEnabled)

    UserDefaults.standard.set(true, forKey: FeatureFlags.panoFeaturesKey)
    XCTAssertTrue(FeatureFlags.isPanoramaEnabled)

    UserDefaults.standard.removeObject(forKey: FeatureFlags.earlyFeaturesKey)
    UserDefaults.standard.removeObject(forKey: FeatureFlags.cloudFeaturesKey)
    UserDefaults.standard.removeObject(forKey: FeatureFlags.panoFeaturesKey)
  }
}
