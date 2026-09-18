// FeatureFlagsTests.swift — Unit tests for FeatureFlags.

import Foundation
import XCTest

@testable import MapleCloudKit

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

  func testPublishedAppGroupValueIsHonouredAfterPlist() {
    let shared = FeatureFlags.sharedDefaults()
    UserDefaults.standard.removeObject(forKey: FeatureFlags.earlyFeaturesKey)
    UserDefaults.standard.removeObject(forKey: FeatureFlags.cloudFeaturesKey)
    UserDefaults.standard.removeObject(forKey: FeatureFlags.panoFeaturesKey)
    defer { shared.removeObject(forKey: FeatureFlags.publishedEarlyFeaturesKey) }

    // A test binary is a DEBUG build, so only the "false" direction proves the
    // published value is consulted before the compile-time default.
    shared.set(false, forKey: FeatureFlags.publishedEarlyFeaturesKey)
    XCTAssertFalse(FeatureFlags.areEarlyFeaturesEnabled)
    XCTAssertFalse(FeatureFlags.isMapleCloudEnabled)
    XCTAssertFalse(FeatureFlags.isPanoramaEnabled)

    // Launch-argument / UserDefaults override still wins over the published value.
    UserDefaults.standard.set(true, forKey: FeatureFlags.earlyFeaturesKey)
    XCTAssertTrue(FeatureFlags.areEarlyFeaturesEnabled)
    UserDefaults.standard.removeObject(forKey: FeatureFlags.earlyFeaturesKey)
  }

  func testPublishResolvedFlagsWritesTheAppGroupKey() {
    let shared = FeatureFlags.sharedDefaults()
    defer { shared.removeObject(forKey: FeatureFlags.publishedEarlyFeaturesKey) }
    shared.removeObject(forKey: FeatureFlags.publishedEarlyFeaturesKey)
    setenv(FeatureFlags.earlyFeaturesEnvVar, "0", 1)
    defer { unsetenv(FeatureFlags.earlyFeaturesEnvVar) }

    FeatureFlags.publishResolvedFlags()
    XCTAssertNotNil(shared.object(forKey: FeatureFlags.publishedEarlyFeaturesKey))
    XCTAssertFalse(shared.bool(forKey: FeatureFlags.publishedEarlyFeaturesKey))
  }
}
