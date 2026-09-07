import Foundation

extension EditorState {
  /// The shared B&W rows snapshot before their first binding write. Repeated
  /// ticks retain that snapshot until endGesture, for both slider primitives.
  public func setBlackWhiteMixValue(_ value: Double, bandID: String) {
    guard let band = Tool.bwMix.subParams.first(where: { $0.id == bandID }) else { return }
    let clamped = min(band.range.upperBound, max(band.range.lowerBound, value))
    guard clamped.isFinite, session.model[keyPath: band.keyPath] != clamped else { return }
    if armedTool != .bwMix { arm(tool: .bwMix) }
    if armedSubParamId != bandID { arm(subParamId: bandID) }
    if !gestureActive {
      commit()
      beginGesture()
    }
    setArmedDisplayValue(clamped)
  }
}
