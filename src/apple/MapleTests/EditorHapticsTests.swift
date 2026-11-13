import MapleCore
import SwiftUI
import XCTest

@testable import Maple

/// The editor's tactile vocabulary (#5122): which moments are felt, how, and
/// that a gesture's own commit is not felt a second time.
final class EditorHapticsTests: XCTestCase {
  // MARK: - Sliders

  func testASliderCrossingItsDefaultIsANotch() {
    let range = -100.0...100.0
    XCTAssertEqual(EditorHaptic.slider(from: -3, to: 2, range: range, defaultValue: 0), .notch)
    XCTAssertEqual(EditorHaptic.slider(from: 4, to: 0, range: range, defaultValue: 0), .notch)
    // A one-sided slider has its notch at its default, not at zero.
    XCTAssertEqual(
      EditorHaptic.slider(from: 6400, to: 6550, range: 2000...12000, defaultValue: 6500), .notch)
  }

  func testASliderReachingAnEndIsALimit() {
    let range = -100.0...100.0
    XCTAssertEqual(EditorHaptic.slider(from: 95, to: 100, range: range, defaultValue: 0), .limit)
    XCTAssertEqual(EditorHaptic.slider(from: -50, to: -100, range: range, defaultValue: 0), .limit)
    // The end wins where the default sits on it.
    XCTAssertEqual(EditorHaptic.slider(from: 12, to: 0, range: 0...100, defaultValue: 0), .limit)
  }

  func testASliderMovingOnOneSideIsSilent() {
    let range = -100.0...100.0
    XCTAssertNil(EditorHaptic.slider(from: 5, to: 60, range: range, defaultValue: 0))
    XCTAssertNil(EditorHaptic.slider(from: -60, to: -5, range: range, defaultValue: 0))
    XCTAssertNil(EditorHaptic.slider(from: 100, to: 100, range: range, defaultValue: 0))
    XCTAssertNil(EditorHaptic.slider(from: 0, to: 0, range: range, defaultValue: 0))
  }

  // MARK: - History

  func testUndoAndRedoFeelTheSame() {
    XCTAssertEqual(EditorHaptic.history(.undo), .undo)
    XCTAssertEqual(EditorHaptic.history(.redo), .undo)
  }

  func testOneTapEditsConfirmWhenTheyLand() {
    for kind in [EditTransaction.Kind.auto, .paste, .preset, .reset, .variant] {
      XCTAssertEqual(EditorHaptic.history(.commit(kind)), .commit, "\(kind)")
    }
  }

  func testAGestureCommitsSilently() {
    for kind in [EditTransaction.Kind.adjustment, .crop, .mask, .repair] {
      XCTAssertNil(EditorHaptic.history(.commit(kind)), "\(kind)")
    }
    XCTAssertNil(EditorHaptic.history(nil))
  }

  // MARK: - Feedback

  /// The slider and selection weights of `s5-editor.md` § Haptics.
  func testEachMomentHasOneFeedback() {
    XCTAssertEqual(EditorHaptic.notch.feedback, .impact(weight: .light))
    XCTAssertEqual(EditorHaptic.limit.feedback, .impact(weight: .medium))
    XCTAssertEqual(EditorHaptic.selection.feedback, .selection)
    XCTAssertEqual(EditorHaptic.grab.feedback, .impact(weight: .light))
    XCTAssertEqual(EditorHaptic.undo.feedback, .impact(weight: .light))
    XCTAssertEqual(EditorHaptic.commit.feedback, .success)
  }

  func testAPulseIsNewEachTimeItIsPlayed() {
    var pulse = EditorHapticPulse()
    XCTAssertNil(pulse.haptic)
    let idle = pulse
    pulse.play(.notch)
    let first = pulse
    pulse.play(.notch)
    XCTAssertNotEqual(first, idle)
    XCTAssertNotEqual(pulse, first, "the same haptic twice must be felt twice")
    pulse.play(.selection)
    XCTAssertEqual(pulse.haptic, .selection, "the last haptic asked for is the one played")
  }
}
