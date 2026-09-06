// ScopeTickDecisionTests.swift — #3387.
//
// The GPU scope readback is one tick late: the sample a present hands back
// describes the model of the present BEFORE it. A drag presents many times
// so nobody notices; a discrete edit presents once, and the sample for that
// edit is only read by a next present an idle canvas never issues. The rule
// that decides "publish" vs "spend one more tick" is pure so it can be
// pinned here without a GPU.

import XCTest

@testable import MapleCore

final class ScopeTickDecisionTests: XCTestCase {
  private func sample(frame: UInt64) -> ScopeSample {
    ScopeSample(bins: [[0]], total: 1, frame: frame)
  }

  func testDisabledDoesNothing() {
    let d = EditSession.scopeTickDecision(
      enabled: false, sample: sample(frame: 5), publishedFrame: 4,
      deliveredSampleIsCurrent: false, heldSampleIsCurrent: false, ticks: 0, maxTicks: 3)
    XCTAssertFalse(d.publish)
    XCTAssertFalse(d.prime)
  }

  func testNoSampleYetDoesNothingHere() {
    // The first-sample priming (#3344) is a separate branch; this rule
    // only acts on a sample the driver actually holds.
    let d = EditSession.scopeTickDecision(
      enabled: true, sample: nil, publishedFrame: nil,
      deliveredSampleIsCurrent: false, heldSampleIsCurrent: false, ticks: 0, maxTicks: 3)
    XCTAssertFalse(d.publish)
    XCTAssertFalse(d.prime)
  }

  /// A fresh frame for the current model: publish, done.
  func testFreshCurrentSamplePublishesAndStops() {
    let d = EditSession.scopeTickDecision(
      enabled: true, sample: sample(frame: 6), publishedFrame: 5,
      deliveredSampleIsCurrent: true, heldSampleIsCurrent: true, ticks: 0, maxTicks: 3)
    XCTAssertTrue(d.publish)
    XCTAssertFalse(d.prime)
  }

  /// The bug: the present after a discrete edit delivers a fresh frame —
  /// but it describes the model BEFORE the edit. Publish it (it is newer
  /// than what is on screen) AND ask for the tick that will carry the
  /// edit's own sample. Without the prime the HUD stays one edit behind.
  func testFreshButOlderSamplePublishesAndPrimes() {
    let d = EditSession.scopeTickDecision(
      enabled: true, sample: sample(frame: 6), publishedFrame: 5,
      deliveredSampleIsCurrent: false, heldSampleIsCurrent: false, ticks: 0, maxTicks: 3)
    XCTAssertTrue(d.publish)
    XCTAssertTrue(d.prime, "the edit's own sample is one tick away — go get it")
  }

  /// A re-read of the published frame with the model moved on: nothing to
  /// publish, still worth a tick.
  func testStaleFrameAfterAnEditPrimes() {
    let d = EditSession.scopeTickDecision(
      enabled: true, sample: sample(frame: 5), publishedFrame: 5,
      deliveredSampleIsCurrent: false, heldSampleIsCurrent: false, ticks: 0, maxTicks: 3)
    XCTAssertFalse(d.publish)
    XCTAssertTrue(d.prime)
  }

  func testStaleFrameWithNoEditDoesNothing() {
    let d = EditSession.scopeTickDecision(
      enabled: true, sample: sample(frame: 5), publishedFrame: 5,
      deliveredSampleIsCurrent: true, heldSampleIsCurrent: true, ticks: 0, maxTicks: 3)
    XCTAssertFalse(d.publish)
    XCTAssertFalse(d.prime)
  }

  func testBudgetStopsTheLoop() {
    let d = EditSession.scopeTickDecision(
      enabled: true, sample: sample(frame: 5), publishedFrame: 5,
      deliveredSampleIsCurrent: false, heldSampleIsCurrent: false, ticks: 3, maxTicks: 3)
    XCTAssertFalse(d.prime, "a readback that never advances must settle, not spin")
  }

  /// The case the second cut missed: the PRIME present re-presents the same
  /// model but delivers nothing new (the map was still in flight). The HUD
  /// still shows the older sample, so keep priming — do not treat "same
  /// model presented again" as "current sample landed".
  func testPrimePresentWithNoNewSampleKeepsPriming() {
    let d = EditSession.scopeTickDecision(
      enabled: true, sample: sample(frame: 5), publishedFrame: 5,
      deliveredSampleIsCurrent: true, heldSampleIsCurrent: false, ticks: 1, maxTicks: 3)
    XCTAssertFalse(d.publish)
    XCTAssertTrue(d.prime, "nothing landed — the shown sample is still the old one")
  }
}
