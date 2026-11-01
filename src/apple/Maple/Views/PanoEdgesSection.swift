// PanoEdgesSection.swift — Boundary Warp and Auto Crop in PanoMergeView
// (#5575, epic #5570), directly under the preview.
//
// Both settings only re-composite: the session keeps the alignment it already
// has, so a change refreshes the preview without matching again. The slider
// commits when the drag ends (not on every step), the toggle at once.

import MapleCore
import MapleUI
import SwiftUI

struct PanoEdgesSection: View {
  let session: PanoMergeSession

  @State private var requestedWarp = 0.0

  var body: some View {
    Section {
      MuiSlider(
        label: "Boundary Warp",
        value: $requestedWarp,
        range: 0...100,
        step: 1,
        unit: "%",
        disabled: session.isRunning,
        helper: helper.text,
        helperTone: helper.tone,
        onCommit: { session.options.boundaryWarp = $0 },
        identifier: "pano-boundary-warp",
        helperIdentifier: "pano-boundary-warp-reason"
      )

      MuiToggle(
        checked: Binding(
          get: { session.options.autoCrop },
          set: { session.options.autoCrop = $0 }
        ),
        label: "Auto Crop",
        disabled: session.isRunning
      )
      .accessibilityIdentifier("pano-auto-crop")

      MuiText(PanoEdgesReport.autoCropHelp, variant: .body, color: .muted)
    } header: {
      Text("Edges")
    }
    .onAppear { requestedWarp = session.options.boundaryWarp }
    .onChange(of: session.options.boundaryWarp) { _, warp in requestedWarp = warp }
  }

  private var helper: (text: String, tone: MuiSliderHelperTone) {
    let line = PanoEdgesReport.boundaryWarpLine(
      requested: requestedWarp, report: session.edgesReport)
    return (line.text, line.isReason ? .warning : .muted)
  }
}
