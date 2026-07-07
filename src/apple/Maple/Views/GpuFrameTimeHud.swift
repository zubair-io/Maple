// GpuFrameTimeHud.swift — the in-app GPU frame-time HUD overlay (epic #925,
// P4b-apple validation / #1053).
//
// Runtime-gated: the overlay only appears when BOTH the GPU live path is active
// (`GpuLiveFlag.isEnabled`, default on / `MAPLE_GPU_LIVE != 0`) AND the HUD
// sub-flag is on (`GpuHudFlag.isEnabled`, `MAPLE_GPU_HUD=1`) — a validation-only
// surface, off in normal use (`EditorView`'s `frameTimeHud` is `EmptyView`).
// Originally mounted by the legacy `FullImageView`; ported to `EditorView`
// (`EditorView+Canvas.swift`) when `FullImageView` was retired (#1807).
//
// ## Role — make the 16ms validation objective
//
// On-device the only way to confirm a slider tick renders inside the 16ms budget
// was a subjective feel-test (device logs aren't capturable on the paired
// Artemis). This overlay reads `GpuLiveDriver.frameStats` (the rolling per-tick
// GPU render+present latency the driver records around `maple_gpu_present_chain`)
// and shows `last / avg / max ms`, colour-coded vs the budget:
//
//   * GREEN  — last ≤ 16ms  (the 60Hz slider-tick target — a frame to spare);
//   * AMBER  — last ≤ 50ms  (the hard limit from CLAUDE.md "Performance invariants");
//   * RED    — last  > 50ms  (a dropped-frame budget violation).
//
// The colour tracks `last` (the live frame the validator is dragging); `avg`/`max`
// give the steady-state + worst-case context. Only real presented frames are in
// the buffer — cancelled (superseded) presents are dropped upstream so the
// numbers don't flatter under a fast drag.

import SwiftUI
import MapleCore

/// The frame-time HUD overlay. Reads the driver's `@Observable` `GpuFrameTimeStats`
/// so it re-renders as frames land. Renders nothing until the first frame (a dash
/// placeholder), and nothing at all unless both gates are on.
struct GpuFrameTimeHud: View {
    /// The rolling stats the driver records into. `@Bindable` is unnecessary (the
    /// view only reads), but the reference must be `@Observable` for per-frame
    /// updates — which `GpuFrameTimeStats` is.
    let stats: GpuFrameTimeStats

    /// The 60Hz slider-tick target (ms). At/under this the HUD is green.
    private static let targetMs = 16.0
    /// The hard latency limit (ms) from CLAUDE.md. Over `targetMs` and at/under
    /// this the HUD is amber; over this it is red.
    private static let hardLimitMs = 50.0

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(spacing: 6) {
                Circle()
                    .fill(budgetColor)
                    .frame(width: 7, height: 7)
                Text("GPU")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.7))
            }
            row(label: "last", value: stats.lastMs, color: budgetColor)
            row(label: "avg", value: stats.avgMs, color: Self.color(for: stats.avgMs))
            row(label: "max", value: stats.maxMs, color: maxColor)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(budgetColor.opacity(0.5), lineWidth: 1)
        )
        .padding(.top, 12)
        .padding(.trailing, 12)
        .allowsHitTesting(false) // never intercept canvas gestures
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("gpu-frametime-hud")
        .accessibilityLabel(accessibilitySummary)
    }

    /// One `label  NN.N ms` row, monospaced-digit so the numbers don't jitter
    /// column width as they change. Shows a dash until the value exists.
    @ViewBuilder
    private func row(label: String, value: Double?, color: Color) -> some View {
        HStack(spacing: 5) {
            Text(label)
                .font(.system(size: 9, weight: .regular, design: .monospaced))
                .foregroundStyle(.white.opacity(0.55))
            Spacer(minLength: 4)
            Text(value.map { String(format: "%4.1f", $0) } ?? "  --")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(color)
            Text("ms")
                .font(.system(size: 8, weight: .regular, design: .monospaced))
                .foregroundStyle(.white.opacity(0.45))
        }
        .frame(minWidth: 78, alignment: .trailing)
    }

    /// Colour-code the live (`last`) frame vs the budget. No frame yet ⇒ neutral.
    private var budgetColor: Color { Self.color(for: stats.lastMs) }

    /// Colour-code the worst frame in the window (the budget violations hide in
    /// `max` even when `avg` looks fine).
    private var maxColor: Color { Self.color(for: stats.maxMs) }

    /// Green ≤ target, amber ≤ hard limit, red beyond. `nil` (no frame) is a muted
    /// neutral so the chip isn't alarmingly red before the first present.
    private static func color(for ms: Double?) -> Color {
        guard let ms else { return Color.white.opacity(0.5) }
        if ms <= targetMs { return .green }
        if ms <= hardLimitMs { return .orange }
        return .red
    }

    /// A VoiceOver-friendly one-line summary (the numbers a sighted validator
    /// reads off the chip).
    private var accessibilitySummary: String {
        func fmt(_ ms: Double?) -> String { ms.map { String(format: "%.1f", $0) } ?? "no data" }
        return "GPU frame time. Last \(fmt(stats.lastMs)) milliseconds, "
            + "average \(fmt(stats.avgMs)), max \(fmt(stats.maxMs)). "
            + "Target \(Int(Self.targetMs)) milliseconds."
    }
}
