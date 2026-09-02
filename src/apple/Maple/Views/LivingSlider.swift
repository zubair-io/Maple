// LivingSlider.swift — Pro Editor Canvas-first (A1, #1536).
//
// A gradient-track slider primitive for the canvas-first editor. Replaces
// the monochrome `DragBar` on the new pro shell (A2 wires it into the
// editor; A1 builds the self-contained primitive + preview).
//
// Layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │  Label                                      +0.35 EV   │  ← label row (12pt)
//   │  ████████████████│░░░░░░░░░░░░░░░░░░░░░░  ●           │  ← gradient track (8–9pt)
//   └──────────────────────────────────────────────────────────┘
//
// Track:
//   • `LinearGradient` from the catalog, 8pt tall, `capsule` clipped.
//   • Inset 0.5pt hairline in `ProTokens.borderHi` (shows contrast vs canvas).
//   • 1.5pt white zero-notch at the midpoint for bipolar tools.
//
// Thumb:
//   • Circle, diameter = track height + 8pt, white fill, 1pt dark rim.
//   • Gains a 2pt `ProTokens.accent` ring when `value ≠ defaultValue`.
//
// Value label:
//   • Right-aligned, monospaced tabular, 11pt.
//   • Accent colour when modified, `ProTokens.textDim` when at default.
//
// Gesture:
//   • `DragGesture(minimumDistance: 0)` — 1:1 value update during drag.
//   • Commits (calls `onCommit`) on gesture end so callers can snapshot undo.

import SwiftUI
import MapleCore

// MARK: - LivingSlider

/// A Pro-palette gradient slider.
///
/// - Parameters:
///   - label:        Short tool name displayed above the track.
///   - value:        Binding to the current value (in display-range units).
///   - range:        The full display range of valid values.
///   - isBipolar:    `true` → zero notch at midpoint; `false` → no notch.
///   - defaultValue: The canonical default for this field (used to decide
///                   modified-state styling). Defaults to `0`.
///   - gradient:     Catalog stops (from `GradientCatalog`). When `nil`
///                   the track renders a flat neutral fill (graceful
///                   degradation for unlisted tools).
///   - displayValue: Pre-formatted string shown as the right-side readout
///                   (e.g. `"+0.35"`, `"5800 K"`). When omitted the slider
///                   formats `value` with up to 2 decimal places.
///   - onCommit:     Called on drag-end to snapshot an undo boundary.
public struct LivingSlider: View {

    // MARK: Inputs

    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let isBipolar: Bool
    let defaultValue: Double
    let gradientStops: [GradientStop]?
    let displayValue: String?
    let onCommit: (() -> Void)?

    // MARK: Internal state

    /// Snapshot of `value` at the moment a drag gesture begins.
    ///
    /// `@GestureState` resets to its initial value (`nil`) automatically when
    /// the gesture ends **or is cancelled** (e.g. a parent ScrollView steals
    /// the touch). A plain `@State` field only resets inside `.onEnded`, so a
    /// cancellation leaves a stale snapshot that causes the next drag to start
    /// from the wrong baseline.
    @GestureState private var dragStartValue: Double? = nil

    // MARK: Geometry constants

    private let trackHeight: CGFloat = 8
    private var thumbDiameter: CGFloat { trackHeight + 8 }
    private let hairlineWidth: CGFloat = 0.5
    private let zeroNotchWidth: CGFloat = 1.5
    private let accentRingWidth: CGFloat = 2

    // MARK: Init

    public init(
        label: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        isBipolar: Bool = false,
        defaultValue: Double = 0,
        gradient: [GradientStop]? = nil,
        displayValue: String? = nil,
        onCommit: (() -> Void)? = nil
    ) {
        self.label = label
        self._value = value
        self.range = range
        self.isBipolar = isBipolar
        self.defaultValue = defaultValue
        self.gradientStops = gradient
        self.displayValue = displayValue
        self.onCommit = onCommit
    }

    // MARK: Derived

    private var isModified: Bool { abs(value - defaultValue) > 1e-9 }

    private var formattedValue: String {
        if let dv = displayValue { return dv }
        return LivingSliderMath.format(value: value, range: range)
    }

    private func thumbPct(for val: Double) -> Double {
        if isBipolar {
            let half = max((range.upperBound - range.lowerBound) / 2, 1e-9)
            let mid = (range.lowerBound + range.upperBound) / 2
            return LivingSliderMath.pctBipolar(value: val - mid, halfRange: half)
        } else {
            return LivingSliderMath.pctUnipolar(value: val, range: range)
        }
    }

    private func value(fromPct pct: Double) -> Double {
        if isBipolar {
            let half = (range.upperBound - range.lowerBound) / 2
            let mid = (range.lowerBound + range.upperBound) / 2
            return mid + LivingSliderMath.valueBipolar(pct: pct, halfRange: half)
        } else {
            return LivingSliderMath.valueUnipolar(pct: pct, range: range)
        }
    }

    // MARK: SwiftUI colors from GradientStop catalog

    private var swiftUIGradient: LinearGradient {
        guard let stops = gradientStops, !stops.isEmpty else {
            // Fallback: flat neutral fill
            return LinearGradient(
                colors: [ProTokens.border, ProTokens.borderHi],
                startPoint: .leading,
                endPoint: .trailing
            )
        }
        let gradStops: [Gradient.Stop] = stops.map { s in
            Gradient.Stop(
                color: Color(red: s.r, green: s.g, blue: s.b),
                location: s.t
            )
        }
        return LinearGradient(
            stops: gradStops,
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    // MARK: Body

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Label + value row
            HStack {
                Text(label)
                    .font(MapleTokens.Typography.toolLabel)
                    .foregroundStyle(ProTokens.textMuted)
                    .accessibilityHidden(true)

                Spacer()

                Text(formattedValue)
                    .font(MapleTokens.Typography.valueChip)
                    .monospacedDigit()
                    .foregroundStyle(isModified ? ProTokens.accent : ProTokens.textDim)
                    .accessibilityHidden(true)
            }

            // Track + thumb
            GeometryReader { geo in
                let trackWidth = geo.size.width
                let thumbPctNow = thumbPct(for: value)
                // Inset the travel range by thumbRadius so the thumb circle
                // stays fully inside the track at both extremes (pct 0 and 1).
                let thumbRadius = thumbDiameter / 2
                let thumbX = thumbRadius + thumbPctNow * (trackWidth - thumbDiameter)

                ZStack(alignment: .leading) {
                    // Gradient track
                    Capsule()
                        .fill(swiftUIGradient)
                        .frame(height: trackHeight)
                        .overlay(
                            // Hairline inset border
                            Capsule()
                                .strokeBorder(ProTokens.borderHi, lineWidth: hairlineWidth)
                        )
                        .frame(maxWidth: .infinity)

                    // Zero notch (bipolar only)
                    if isBipolar {
                        let notchX = 0.5 * trackWidth
                        Rectangle()
                            .fill(Color.white.opacity(0.80))
                            .frame(width: zeroNotchWidth, height: trackHeight)
                            .position(x: notchX, y: trackHeight / 2)
                    }

                    // Thumb
                    Circle()
                        .fill(Color.white)
                        .frame(width: thumbDiameter, height: thumbDiameter)
                        // Dark rim
                        .shadow(color: .black.opacity(0.45), radius: 1, x: 0, y: 0.5)
                        // Accent ring when modified
                        .overlay(
                            Circle()
                                .strokeBorder(
                                    isModified ? ProTokens.accent : Color.clear,
                                    lineWidth: accentRingWidth
                                )
                        )
                        .position(x: thumbX, y: trackHeight / 2)
                        .accessibilityLabel(label)
                        .accessibilityValue(formattedValue)
                        .accessibilityAdjustableAction { direction in
                            // Use 5% per swipe (range/20) so VoiceOver users
                            // traverse the full range in ~20 gestures rather
                            // than ~100. Fine enough for precision, coarse
                            // enough to be practical.
                            let step = (range.upperBound - range.lowerBound) / 20
                            switch direction {
                            case .increment: value = min(value + step, range.upperBound)
                            case .decrement: value = max(value - step, range.lowerBound)
                            @unknown default: break
                            }
                            // Commit after each VoiceOver step so the undo
                            // boundary is recorded the same way drag does.
                            onCommit?()
                        }
                }
                .frame(height: trackHeight)
                .contentShape(Rectangle().inset(by: -8)) // larger hit area
                .gesture(
                    DragGesture(minimumDistance: 0)
                        // Capture the pre-drag value exactly once. `@GestureState`
                        // is the right primitive here: SwiftUI resets it to `nil`
                        // automatically when the gesture ends *or* is cancelled
                        // (e.g. a parent ScrollView intercepts the touch), so
                        // the next drag always starts from a clean baseline.
                        .updating($dragStartValue) { _, state, _ in
                            if state == nil { state = value }
                        }
                        .onChanged { g in
                            let totalDx = g.translation.width
                            let span = range.upperBound - range.lowerBound
                            guard span > 0, trackWidth > 0 else { return }
                            let travelWidth = trackWidth - thumbDiameter
                            guard travelWidth > 0 else { return }
                            let delta = totalDx / travelWidth * span
                            let newVal = ((dragStartValue ?? value) + delta)
                                .clamped(to: range)
                            value = newVal
                        }
                        .onEnded { _ in
                            onCommit?()
                        }
                )
            }
            .frame(height: thumbDiameter) // GeometryReader needs explicit height
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}

// MARK: - Double clamping helper (file-private)

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

// MARK: - Previews

#if DEBUG
#Preview("LivingSlider — Light group") {
    @Previewable @State var exposure: Double = 0.0
    @Previewable @State var contrast: Double = 20.0
    @Previewable @State var highlights: Double = -30.0

    return VStack(spacing: 0) {
        LivingSlider(
            label: "Exposure",
            value: $exposure,
            range: -4...4,
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.exposure
        )
        LivingSlider(
            label: "Contrast",
            value: $contrast,
            range: -100...100,
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.contrast
        )
        LivingSlider(
            label: "Highlights",
            value: $highlights,
            range: -100...100,
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.highlights
        )
    }
    .padding(.vertical, 8)
    .background(ProTokens.panel)
}

#Preview("LivingSlider — Color group") {
    @Previewable @State var temp: Double = 6500.0
    @Previewable @State var tint: Double = 0.0
    @Previewable @State var vibrance: Double = 0.0

    return VStack(spacing: 0) {
        LivingSlider(
            label: "Temp",
            value: $temp,
            range: 2000...12000,
            isBipolar: false,
            defaultValue: 6500,
            gradient: GradientCatalog.temp,
            displayValue: String(format: "%.0f K", temp)
        )
        LivingSlider(
            label: "Tint",
            value: $tint,
            range: -100...100,
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.tint
        )
        LivingSlider(
            label: "Vibrance",
            value: $vibrance,
            range: -100...100,
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.vibrance
        )
    }
    .padding(.vertical, 8)
    .background(ProTokens.panel)
}

#Preview("LivingSlider — Effects group") {
    @Previewable @State var clarity: Double = 0.0
    @Previewable @State var vignette: Double = -20.0
    @Previewable @State var grain: Double = 25.0

    return VStack(spacing: 0) {
        LivingSlider(
            label: "Clarity",
            value: $clarity,
            range: -100...100,
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.clarity
        )
        LivingSlider(
            label: "Vignette",
            value: $vignette,
            range: -100...100,
            isBipolar: true,
            defaultValue: 0,
            gradient: GradientCatalog.vignette
        )
        LivingSlider(
            label: "Grain",
            value: $grain,
            range: 0...100,
            isBipolar: false,
            defaultValue: 0,
            gradient: GradientCatalog.grain
        )
    }
    .padding(.vertical, 8)
    .background(ProTokens.panel)
}
#endif
