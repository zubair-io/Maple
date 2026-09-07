// MaskRangePickOverlay.swift — the canvas click target for the mask
// panel's colour-range eyedropper (#362). Mounted in the canvas viewport
// while `MaskRangePicker` is armed, exactly like `WhiteBalancePickOverlay`:
// it owns pointer gestures for the duration of the pick so a tap cannot
// also pan, zoom or crop, and inverts the same committed frame/offset and
// crop geometry (`WhiteBalancePickGeometry`) to the uncropped image point
// the sampler takes.

import MapleCore
import MapleUI
import SwiftUI

struct MaskRangePickOverlay: View {
  let state: EditorState
  @State private var sampleTask: Task<Void, Never>?
  @FocusState private var hasKeyboardFocus: Bool
  private var picker: MaskRangePicker { state.maskRangePicker }

  var body: some View {
    GeometryReader { geometry in
      let frame = state.zoom.displayFrameInPoints ?? .zero
      let pan = state.zoom.panOffset
      let nativeSize = state.session.nativeImageSize
      let crop = state.session.model.crop
      Color.clear
        .contentShape(Rectangle())
        .onTapGesture { location in
          guard !state.session.isRendering, !picker.isSampling else { return }
          let point = WhiteBalancePickGeometry.imagePoint(
            at: location, viewport: geometry.size, displayFrame: frame,
            pan: pan, nativeSize: nativeSize, crop: crop)
          sampleTask = Task { await picker.pick(at: point) }
        }
        .accessibilityLabel("Colour range sampling canvas")
        .accessibilityHint("Choose the colour inside the photo the mask should select.")
        .accessibilityIdentifier("editor-mask-range-pick-canvas")
        .overlay(alignment: .top) {
          VStack(spacing: 6) {
            if picker.isSampling || state.session.isRendering {
              ProgressView()
                .accessibilityLabel(picker.isSampling ? "Sampling colour" : "Preparing photo")
            }
            Text(
              picker.message
                ?? (picker.isSampling ? "Sampling colour…" : "Pick a colour in the photo.")
            )
            .font(.callout)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("editor-mask-range-pick-message")
            MuiButton(label: "Cancel", variant: .ghost) { picker.cancel() }
              .accessibilityIdentifier("editor-mask-range-pick-cancel")
          }
          .padding(12)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
          .frame(maxWidth: 320)
          .padding(.horizontal, 16)
          .padding(.top, 60)
        }
    }
    .focusable()
    .focused($hasKeyboardFocus)
    .onAppear { hasKeyboardFocus = true }
    .onChange(of: state.session.showingOriginal) { _, showing in
      if showing { picker.cancel() }
    }
    .onChange(of: state.session.selectedMaskId) { _, _ in picker.cancel() }
    .onDisappear {
      sampleTask?.cancel()
      picker.cancel()
    }
    .onKeyPress(.escape) {
      picker.cancel()
      return .handled
    }
  }
}
