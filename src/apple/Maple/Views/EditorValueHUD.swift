// The slider value and its idle timer are observed only by this overlay.
// One sleeper follows the latest deadline throughout a continuous drag.
import MapleCore
import SwiftUI

struct EditorValueHUD: View {
  let state: EditorState
  @State private var visible = false
  @State private var hideDeadline: ContinuousClock.Instant?
  @State private var hideTask: Task<Void, Never>?

  var body: some View {
    ValueChipOverlay(state: state)
      .opacity(visible ? 1 : 0)
      .animation(.easeOut(duration: 0.18), value: visible)
      .allowsHitTesting(false)
      .accessibilityHidden(!visible)
      .onChange(of: state.armedTool) { _, _ in flash() }
      .onChange(of: state.armedDisplayValue) { _, _ in flash() }
      .onDisappear {
        hideTask?.cancel()
        hideTask = nil
        hideDeadline = nil
      }
  }

  private func flash() {
    hideDeadline = .now.advanced(by: .milliseconds(1100))
    visible = true
    guard hideTask == nil else { return }
    hideTask = Task { @MainActor in
      let clock = ContinuousClock()
      while let deadline = hideDeadline {
        do {
          try await clock.sleep(until: deadline)
        } catch { return }
        guard let latest = hideDeadline, clock.now >= latest else { continue }
        withAnimation(.easeOut(duration: 0.25)) { visible = false }
        hideDeadline = nil
      }
      hideTask = nil
    }
  }
}
