import Foundation

extension EditorState {
  /// Shared start boundary for every living slider, including subtool panels.
  /// Arming precedes the transaction so an old deferred value is never reused.
  public func beginSliderInteraction(tool: Tool, subParamID: String? = nil) {
    if armedTool != tool { arm(tool: tool) }
    if let subParamID, armedSubParamId != subParamID { arm(subParamId: subParamID) }
    commit()
    beginGesture()
  }
}
