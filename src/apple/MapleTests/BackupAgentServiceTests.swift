// BackupAgentServiceTests.swift — #4718.
//
// The embedded macOS backup helper must be registered with launchd exactly
// when the app itself would run backup, and unregistered otherwise; this
// pins the decision the `SMAppService` call is driven by.

import Foundation
import MapleCore
import XCTest

@testable import Maple

final class BackupAgentServiceTests: XCTestCase {
  private var configured: BackupSettings {
    BackupSettings(
      serverURL: "https://srv.example", libraryId: "lib1", rootFolder: "",
      wifiOnly: false, includeLivePhotos: true, includeVideos: true, includeBursts: false,
      includeSharedLibrary: false, includeSharedAlbums: false)
  }

  func testRegisteredWhenConfiguredAndNotStopped() {
    XCTAssertTrue(BackupAgentService.shouldBeRegistered(settings: configured, stoppedByUser: false))
  }

  func testNotRegisteredWhenStoppedByUser() {
    XCTAssertFalse(BackupAgentService.shouldBeRegistered(settings: configured, stoppedByUser: true))
  }

  func testNotRegisteredWithoutConfiguredSettings() {
    XCTAssertFalse(BackupAgentService.shouldBeRegistered(settings: nil, stoppedByUser: false))
    XCTAssertFalse(BackupAgentService.shouldBeRegistered(settings: .defaults, stoppedByUser: false))
  }

  func testPlistNameMatchesTheEmbeddedLaunchAgent() {
    XCTAssertEqual(BackupAgentService.plistName, "app.justmaple.aperture.backup.plist")
  }
}
