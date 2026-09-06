import Foundation

@MainActor
extension EditSession {
  /// Refine cancellation does not advance the model generation. Keep a
  /// separate owner so an old CPU/GPU/native-detail completion cannot settle
  /// a newer request, and every early return releases its own loading state.
  func beginRenderActivity() -> UInt64 {
    renderActivityID &+= 1
    isRendering = true
    return renderActivityID
  }

  func endRenderActivity(_ activityID: UInt64) {
    guard activityID == renderActivityID else { return }
    isRendering = false
  }
}
