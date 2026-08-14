// PhotosAccessMemoryTests.swift — unit tests for the "did the user ever
// grant Photos access?" memory that backs the sidebar's lost-permission
// warning (#2851).
//
// The memory is UserDefaults-backed; each test injects its own suite so
// nothing touches the real standard defaults.

import XCTest
import Photos
@testable import MapleCore

final class PhotosAccessMemoryTests: XCTestCase {

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "PhotosAccessMemoryTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    // MARK: - Never granted

    func testNeverGrantedIsNotLostAccess() {
        // A fresh install that has never been authorized must not warn —
        // there is nothing to have "lost".
        XCTAssertFalse(PhotosAccessMemory.lostAccess(current: .notDetermined, defaults: defaults))
        XCTAssertFalse(PhotosAccessMemory.lostAccess(current: .denied, defaults: defaults))
        XCTAssertFalse(PhotosAccessMemory.lostAccess(current: .restricted, defaults: defaults))
    }

    func testRecordingNonGrantedStatusDoesNotSetMemory() {
        PhotosAccessMemory.record(.notDetermined, defaults: defaults)
        PhotosAccessMemory.record(.denied, defaults: defaults)
        PhotosAccessMemory.record(.restricted, defaults: defaults)
        XCTAssertFalse(PhotosAccessMemory.lostAccess(current: .notDetermined, defaults: defaults))
    }

    // MARK: - Granted, then reset

    func testAuthorizedThenResetIsLostAccess() {
        PhotosAccessMemory.record(.authorized, defaults: defaults)
        // Test-build reinstall / TCC reset lands back on .notDetermined.
        XCTAssertTrue(PhotosAccessMemory.lostAccess(current: .notDetermined, defaults: defaults))
        // Explicit revocation in Settings lands on .denied.
        XCTAssertTrue(PhotosAccessMemory.lostAccess(current: .denied, defaults: defaults))
        XCTAssertTrue(PhotosAccessMemory.lostAccess(current: .restricted, defaults: defaults))
    }

    func testLimitedCountsAsGranted() {
        PhotosAccessMemory.record(.limited, defaults: defaults)
        XCTAssertTrue(PhotosAccessMemory.lostAccess(current: .notDetermined, defaults: defaults))
    }

    // MARK: - Granted and still granted

    func testCurrentlyGrantedIsNeverLostAccess() {
        PhotosAccessMemory.record(.authorized, defaults: defaults)
        XCTAssertFalse(PhotosAccessMemory.lostAccess(current: .authorized, defaults: defaults))
        XCTAssertFalse(PhotosAccessMemory.lostAccess(current: .limited, defaults: defaults))
    }

    func testRegrantAfterLossClearsWarning() {
        PhotosAccessMemory.record(.authorized, defaults: defaults)
        XCTAssertTrue(PhotosAccessMemory.lostAccess(current: .notDetermined, defaults: defaults))
        // User re-grants through the panel — the warning condition clears
        // purely from the current status; no unlearning step required.
        XCTAssertFalse(PhotosAccessMemory.lostAccess(current: .limited, defaults: defaults))
    }
}
