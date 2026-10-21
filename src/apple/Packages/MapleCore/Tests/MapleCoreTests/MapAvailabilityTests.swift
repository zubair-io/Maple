// MapAvailabilityTests.swift
//
// Covers `MapAvailability.reason(server:isSignedIn:)` — the pure
// selector behind `AppShell.openMap()`'s empty-state routing (#2848).
// Before this ticket, `.map` selected with no cloud account (or one that
// needed fresh sign-in) fell through to the browse grid instead of a real
// empty state; these three cases are exactly what `MapEmptyState` needs
// to distinguish (no account / sign-in required / ready).

import XCTest
@testable import MapleCloudKit

final class MapAvailabilityTests: XCTestCase {
  private let server = URL(string: "https://maple.example.com")!
  private let otherServer = URL(string: "https://other.example.com")!

  func test_reason_noAccount_whenNoAccountConnected() {
    XCTAssertEqual(MapAvailability.reason(server: nil, isSignedIn: false), .noAccount)
  }

  /// No server always means `.noAccount`, regardless of `isSignedIn` — an
  /// unreachable combination in production (there's no session to be signed
  /// in without a resolved account), but the selector should still degrade
  /// to the same reason rather than `nil`.
  func test_reason_noAccount_takesPrecedenceOverIsSignedIn() {
    XCTAssertEqual(MapAvailability.reason(server: nil, isSignedIn: true), .noAccount)
  }

  /// #5033: the reason names the server, so the empty state's Sign in button
  /// can prefill it.
  func test_reason_signInRequired_namesTheServer() {
    XCTAssertEqual(
      MapAvailability.reason(server: server, isSignedIn: false),
      .signInRequired(server: server))
  }

  func test_reason_nil_whenAccountConnectedAndSignedIn() {
    XCTAssertNil(MapAvailability.reason(server: server, isSignedIn: true))
  }

  // MARK: - Reopening after sign-in (#5033)

  /// Before #5033 the Map kept its sign-in message after the user signed in
  /// (from its own button or the sidebar) until they navigated away and back.
  func test_signInToTheMapsServer_reopensTheMap() {
    XCTAssertTrue(
      MapUnavailableReason.signInRequired(server: server).reopensAfterSignIn(to: server))
  }

  func test_signInToAnotherServer_leavesTheMapAlone() {
    XCTAssertFalse(
      MapUnavailableReason.signInRequired(server: server).reopensAfterSignIn(to: otherServer))
  }

  func test_connectingAFirstAccount_reopensTheMap() {
    XCTAssertTrue(MapUnavailableReason.noAccount.reopensAfterSignIn(to: server))
  }

  func test_aRestoreInFlight_isNotRestarted() {
    XCTAssertFalse(MapUnavailableReason.connecting.reopensAfterSignIn(to: server))
  }
}
