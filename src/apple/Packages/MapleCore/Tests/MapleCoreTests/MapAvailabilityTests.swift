// MapAvailabilityTests.swift
//
// Covers `MapAvailability.reason(hasAccount:isSignedIn:)` — the pure
// selector behind `AppShell.openMap()`'s empty-state routing (#2848).
// Before this ticket, `.map` selected with no cloud account (or one that
// needed fresh sign-in) fell through to the browse grid instead of a real
// empty state; these three cases are exactly what `MapEmptyState` needs
// to distinguish (no account / sign-in required / ready).

import XCTest
@testable import MapleCloudKit

final class MapAvailabilityTests: XCTestCase {

  func test_reason_noAccount_whenNoAccountConnected() {
    XCTAssertEqual(
      MapAvailability.reason(hasAccount: false, isSignedIn: false),
      .noAccount)
  }

  /// `hasAccount: false` always means `.noAccount`, regardless of
  /// `isSignedIn` — an unreachable combination in production (there's no
  /// session to be signed in without a resolved account), but the
  /// selector should still degrade to the same reason rather than `nil`.
  func test_reason_noAccount_takesPrecedenceOverIsSignedIn() {
    XCTAssertEqual(
      MapAvailability.reason(hasAccount: false, isSignedIn: true),
      .noAccount)
  }

  func test_reason_signInRequired_whenAccountConnectedButNotSignedIn() {
    XCTAssertEqual(
      MapAvailability.reason(hasAccount: true, isSignedIn: false),
      .signInRequired)
  }

  func test_reason_nil_whenAccountConnectedAndSignedIn() {
    XCTAssertNil(MapAvailability.reason(hasAccount: true, isSignedIn: true))
  }
}
