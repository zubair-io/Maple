import Foundation

extension EditorState {
  /// Select a named illuminant as one explicit edit. The stored pair is
  /// authoritative; reopening/copying never depends on re-estimating a scene.
  public func applyWhiteBalancePreset(_ preset: WhiteBalancePreset) async {
    guard !Task.isCancelled else { return }
    whiteBalancePicker.cancel()
    if preset == .auto {
      await applyAuto(whiteBalanceOnly: true)
      return
    }
    if preset == .asShot {
      whiteBalancePicker.resetToAsShot()
      return
    }
    var model = session.model
    if let pair = preset.pair {
      model.temperature = pair.temperature
      model.tint = pair.tint
      model.wbScaleVersion = AdjustmentModel.default.wbScaleVersion
    }
    model.whiteBalancePreset = preset
    model.wbSource = preset == .custom ? .manual : .preset
    model.wbSampleX = 0
    model.wbSampleY = 0
    model.wbAlgorithmVersion = 0
    guard model != session.model else { return }
    commit(description: "\(preset.rawValue) white balance")
    session.model = model
    session.endEdit()
  }
}
