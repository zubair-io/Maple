// ControlVariantToggle.swift — TEMPORARY exploration toggle (#feat/pro-editor-control-variants).
//
// Small segmented control that switches between the two canvas-first control
// panel layout variants:
//   • "Card"  (.compact) — ToolDock (group-switcher) + ControlCard at the bottom.
//   • "Panel" (.panel)   — StackedAdjustmentsPanel as a full-height right-side
//                          inspector (regular) or a bottom sheet (compact).
//
// THIS IS AN EXPLORATION TOGGLE — it exists solely to A/B the two layouts
// during design review and MUST be removed before shipping.  It is
// intentionally unstyled beyond the bare minimum so it reads as dev scaffolding.
//
// Placement: top-trailing, just below the PillHeader, so it is reachable on
// both macOS and iPhone without conflicting with any permanent chrome.

import SwiftUI

// MARK: - ControlVariant

/// The two canvas-first control-panel layout variants under exploration.
/// Stored in `@AppStorage` so the choice survives app restarts during review.
enum ControlVariant: String {
    /// Original A2 layout — ToolDock (group tabs on right) + ControlCard (bottom glass card).
    case compact
    /// New layout — StackedAdjustmentsPanel replaces the dock + card with a
    /// single scrollable inspector.
    case panel
}

// MARK: - ControlVariantToggle

/// Segmented "Card / Panel" toggle placed top-trailing below the pill header.
/// - Parameter selection: `@AppStorage`-backed binding in `EditorView`.
struct ControlVariantToggle: View {
    @Binding var selection: ControlVariant

    var body: some View {
        // Two-segment picker.  Plain picker style so it renders as a compact
        // inline segmented control with no extra decoration.
        Picker("Layout", selection: $selection) {
            Text("Card").tag(ControlVariant.compact)
            Text("Panel").tag(ControlVariant.panel)
        }
        .pickerStyle(.segmented)
        // Narrow fixed width so it doesn't compete with the pill header.
        .frame(width: 130)
        .accessibilityIdentifier("editor-variant-toggle")
        .accessibilityLabel("Control panel layout variant")
    }
}
