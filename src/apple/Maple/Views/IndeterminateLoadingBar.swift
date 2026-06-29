// IndeterminateLoadingBar.swift — #1658 — a thin, animated "loading bar" shown
// at the top of the canvas while a cold open resolves its full-quality frame.
//
// Custom rather than `ProgressView().progressViewStyle(.linear)`: an
// INDETERMINATE linear ProgressView does not animate reliably on iOS (it can
// render as a static line), so a hand-rolled sliding highlight guarantees a
// moving fill on both iOS and macOS. No state beyond the looping animation —
// visibility is owned by the caller (`EditSession.shouldShowLoadingIndicator`).

import SwiftUI

/// A browser-style indeterminate progress bar: a faint track with a highlight
/// segment that slides left-to-right on a repeating loop. Under Reduce Motion
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
                let segmentWidth = max(trackWidth * 0.35, 60)
                Capsule()
                    .fill(Color.white)
                    // Travel from fully off the left edge to fully off the right,
                    // then loop (no autoreverse → always L→R, like a load bar).
                    .frame(width: segmentWidth, height: height)
                    .offset(x: animating ? trackWidth : -segmentWidth)
                    .animation(
                        .easeInOut(duration: 1.1).repeatForever(autoreverses: false),
                        value: animating
                    )
            }
            .background(Color.white.opacity(0.18))
            .clipShape(Capsule())
        }
    }
}
