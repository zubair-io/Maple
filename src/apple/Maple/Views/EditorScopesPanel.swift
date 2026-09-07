// EditorScopesPanel.swift — the four-up scopes panel (#3251): histogram, luma
// waveform, RGB parade and vectorscope over the same scope readback the
// skin-tone HUD (`VectorscopeHud`) reads — `session.scopeSample`, produced one
// tick late by the GPU-live present (`EditSession+GpuLive.swift`) or by the
// debounced CPU fallback (`EditSession+ScopeCpu.swift`). Mounted top-leading
// over the canvas by `EditorView` on regular width, toggled by the pill's
// "Scopes" button; `EditorView` arms `session.scopeEnabled` while either this
// panel or the HUD is showing.
//
// The waveform / parade / histogram reduction (`ScopePanelSample.reduce`) runs
// on `ScopePanelReducer` — off the MainActor and off the present path, so a
// 512 px snapshot never costs the slider tick anything — and is coalesced to
// the newest sample: a drag publishing a sample per present drops the frames a
// reduction ran past instead of queueing one per frame. The vectorscope member
// draws the 128×128 density bins the scope pass already produces rather than a
// subsampled dot cloud.

import MapleCore
import MapleUI
import SwiftUI

struct EditorScopesPanel: View {
  @Bindable var state: EditorState
  @State private var panel: ScopePanelSample?
  @State private var reducer = ScopePanelReducer()
  /// True while a reduction is in flight — the coalescing gate.
  @State private var reducing = false

  private var sample: ScopeSample? { state.session.scopeSample }

  var body: some View {
    Group {
      if let panel, let sample {
        MuiScopesPanel(sample: Self.muiSample(panel, bins: sample.bins), width: 200, height: 56)
      } else {
        MuiText("Waiting for a frame…", variant: .toolLabel, color: .muted)
          .padding(12)
      }
    }
    .background(.black.opacity(0.62), in: RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
    .overlay(
      RoundedRectangle(cornerRadius: MapleTokens.Radius.sm)
        .strokeBorder(Color.white.opacity(0.2), lineWidth: 1)
    )
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-scopes-panel")
    .accessibilityLabel("Scopes")
    .accessibilityValue(panel.map { "has data, frame \($0.frame)" } ?? "no data")
    .task(id: sample?.frame) { await drainToNewestSample() }
  }

  /// Reduce samples until the plot matches the newest one the session has
  /// published, one reduction at a time. Re-entrant calls (a new frame while
  /// one is in flight) return immediately — the loop picks their sample up
  /// on its next turn, so the panel settles on the last frame of a drag
  /// without ever running two reductions at once.
  private func drainToNewestSample() async {
    guard !reducing else { return }
    reducing = true
    defer { reducing = false }
    while let current = state.session.scopeSample, let snapshot = current.snapshot,
      current.frame != panel?.frame
    {
      panel = await reducer.reduce(snapshot, frame: current.frame)
    }
  }

  /// The design-system sample for one reduced frame: peak-relative
  /// histograms come from the raw counts (`MuiHistogram` normalises), the
  /// vectorscope from the density bins.
  static func muiSample(_ panel: ScopePanelSample, bins: [[UInt32]]) -> MuiScopeSample {
    MuiScopeSample(
      histogram: MuiScopeHistogramSample(
        r: panel.histogramR, g: panel.histogramG, b: panel.histogramB),
      waveformLuma: panel.waveformLuma,
      parade: MuiScopeParadeSample(r: panel.paradeR, g: panel.paradeG, b: panel.paradeB),
      vectorscope: [],
      vectorscopeBins: bins
    )
  }
}
