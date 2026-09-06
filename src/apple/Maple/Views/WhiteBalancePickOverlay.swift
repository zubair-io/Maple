import MapleCore
import MapleUI
import SwiftUI

/// Mounted in the canvas viewport beneath the editor chrome. During a pick it
/// owns pointer gestures so a single click cannot also pan, zoom or crop. The
/// geometry below is the same committed frame/offset CanvasZoomHost paints.
struct WhiteBalancePickOverlay: View {
  let state: EditorState
  @State private var sampleTask: Task<Void, Never>?
  @FocusState private var hasKeyboardFocus: Bool
  private var picker: WhiteBalancePicker { state.whiteBalancePicker }

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
        .accessibilityLabel("White balance sampling canvas")
        .accessibilityHint("Choose a white or gray area inside the photo.")
        .accessibilityIdentifier("editor-wb-pick-canvas")
        .overlay(alignment: .top) {
          VStack(spacing: 6) {
            if picker.isSampling || state.session.isRendering {
              ProgressView()
                .accessibilityLabel(
                  picker.isSampling ? "Sampling white balance" : "Preparing photo")
            }
            Text(
              picker.message
                ?? (picker.isSampling
                  ? "Sampling white balance…" : "Pick a white or gray area in the photo.")
            )
            .font(.callout)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("editor-wb-pick-message")
            MuiButton(label: "Cancel", variant: .ghost) { picker.cancel() }
              .accessibilityIdentifier("editor-wb-pick-cancel")
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
