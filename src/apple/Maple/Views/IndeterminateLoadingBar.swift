// IndeterminateLoadingBar.swift — #1658 — a thin, animated "loading bar" shown
// inside the histogram chip while a cold open resolves its full-quality frame.
//
// Custom rather than `ProgressView().progressViewStyle(.linear)`: an
// INDETERMINATE linear ProgressView does not animate reliably on iOS (it can
// render as a static line), so a hand-rolled sliding highlight guarantees a
// moving fill on both iOS and macOS. No state beyond the looping animation —
// visibility is owned by the caller (`EditSession.shouldShowLoadingIndicator`).

import SwiftUI

/// A Cylon-style indeterminate progress bar: a faint track with a highlight
/// segment that sweeps back and forth within the chip. Under Reduce Motion
/// the slide is replaced with a gentle opacity pulse.
struct IndeterminateLoadingBar: View {
  /// Track + highlight thickness. Thin by default.
  var height: CGFloat = 3

  /// Honor Reduce Motion: the sliding highlight is translational motion, which
  /// the setting asks us to avoid. Fall back to an opacity pulse — a cross-fade,
  /// the motion-safe substitute Apple itself uses for reduced motion — that
  /// still reads as "in progress". (Copilot #1659)
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var animating = false

  var body: some View {
    bar
      .frame(height: height)
      .onAppear { animating = true }
      .accessibilityIdentifier("canvas-loading-bar")
      .accessibilityLabel("Loading image")
  }

  @ViewBuilder
  private var bar: some View {
    if reduceMotion {
      // No translation — a full-width fill that gently pulses opacity.
      Capsule()
        .fill(Color.white)
        .frame(maxWidth: .infinity)
        .opacity(animating ? 0.85 : 0.3)
        .animation(
          .easeInOut(duration: 0.9).repeatForever(autoreverses: true),
          value: animating
        )
    } else {
      GeometryReader { geo in
        let trackWidth = geo.size.width
        let segmentWidth = trackWidth * 0.35
        Capsule()
          .fill(
            LinearGradient(
              colors: [.white.opacity(0.25), .white, .white.opacity(0.25)],
              startPoint: .leading, endPoint: .trailing
            )
          )
          // Keep the highlight visible at both ends as it reverses.
          .frame(width: segmentWidth, height: height)
          .offset(x: animating ? trackWidth - segmentWidth : 0)
          .animation(
            .easeInOut(duration: 0.8).repeatForever(autoreverses: true),
            value: animating
          )
      }
      .background(Color.white.opacity(0.18))
      .clipShape(Capsule())
    }
  }
}
