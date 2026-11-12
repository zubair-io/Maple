// EditorHaptics.swift — the canvas-first editor's tactile vocabulary (#5122).
//
// One name per kind of moment, so the same moment feels the same wherever it
// happens: a slider's zero notch on the ruler and in the inspector, a
// selection in the dock, the tabs, the pills and the side rail. The slider
// and selection weights are the ones `docs/design/responsive-program/
// s5-editor.md` § Haptics set out.
//
// Haptics are for iPhone and iPad; on the Mac the modifiers below do
// nothing. Every haptic is a SwiftUI `sensoryFeedback`, which the system
// plays or drops according to the user's own settings (System Haptics, and
// Vibration under Accessibility › Touch), so nothing here needs a setting
// of its own. Each fires on a discrete change of state, never per frame.

import MapleCore
import SwiftUI

enum EditorHaptic: Equatable {
  /// A slider crossing its default: the zero notch of a two-sided one.
  case notch
  /// A slider reaching either end of its range.
  case limit
  /// A group, tool or sub-parameter becoming the selected one; a slider
  /// reset, or switched to fine adjustment.
  case selection
  /// Taking hold of a handle on the canvas.
  case grab
  /// An Undo or Redo that changed the photo.
  case undo
  /// A one-tap edit landing: Auto, a preset, a paste, a reset.
  case commit

  var feedback: SensoryFeedback {
    switch self {
    case .notch, .grab, .undo: return .impact(weight: .light)
    case .limit: return .impact(weight: .medium)
    case .selection: return .selection
    case .commit: return .success
    }
  }

  /// The haptic for a slider moving from `old` to `new`, if it has one:
  /// arriving at an end of the range, else crossing the default.
  static func slider(
    from old: Double, to new: Double, range: ClosedRange<Double>, defaultValue: Double
  ) -> EditorHaptic? {
    guard new != old else { return nil }
    if new == range.lowerBound || new == range.upperBound { return .limit }
    let crossed =
      (old < defaultValue && new >= defaultValue) || (old > defaultValue && new <= defaultValue)
    return crossed ? .notch : nil
  }

  /// The haptic for a step in the edit history, if it has one. An edit made
  /// by a gesture commits silently: the gesture gave its own feedback.
  static func history(_ event: EditHistoryEvent?) -> EditorHaptic? {
    switch event {
    case .undo, .redo: return .undo
    case .commit(let kind): return kind.landsAtOnce ? .commit : nil
    case nil: return nil
    }
  }
}

/// The haptic a view last asked for. Each `play` is a new value, so the same
/// haptic twice in a row is felt twice; several in one update are felt once,
/// as the last.
struct EditorHapticPulse: Equatable {
  private(set) var haptic: EditorHaptic?
  private var serial = 0

  mutating func play(_ haptic: EditorHaptic) {
    self.haptic = haptic
    serial += 1
  }
}

extension View {
  /// Plays each haptic `pulse` is asked for.
  func editorHaptics(_ pulse: EditorHapticPulse) -> some View {
    #if os(iOS)
      sensoryFeedback(trigger: pulse) { _, pulse in pulse.haptic?.feedback }
    #else
      self
    #endif
  }

  /// Plays the selection haptic when this control becomes the selected one,
  /// however the selection got there.
  func editorSelectionHaptic(isSelected: Bool) -> some View {
    #if os(iOS)
      sensoryFeedback(EditorHaptic.selection.feedback, trigger: isSelected) { _, selected in
        selected
      }
    #else
      self
    #endif
  }
}

#if os(iOS)
  /// Confirms Undo, Redo and one-tap edits. A leaf of its own so the
  /// history is the only thing its observation re-evaluates.
  struct EditorHistoryHaptics: View {
    let session: EditSession

    var body: some View {
      Color.clear
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
        .allowsHitTesting(false)
        .sensoryFeedback(trigger: session.editHistoryMark) { old, new in
          EditorHaptic.history(EditHistoryEvent.between(old, new))?.feedback
        }
    }
  }
#endif
