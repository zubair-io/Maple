// EditSession+MaskRange.swift — the model-side surface for a mask's
// colour-range refinement (#362). The panel's enable toggle is a DISCRETE
// edit (its own transaction); the five sliders are CONTINUOUS and write
// straight into `model` inside the transaction their drag opened, exactly
// like the ten adjustment sliders (`MaskSliderRow`). The eyedropper seeds
// through `MaskRangePicker`.

import Foundation

@MainActor
extension EditSession {
  public func maskRange(id: UUID) -> RangeRefinement? {
    model.localAdjustments.first { $0.id == id }?.range
  }

  /// Arm raw-core's default range, or drop the refinement entirely (the
  /// primary mask alone). One undo entry; a no-op writes nothing.
  public func setMaskRangeEnabled(id: UUID, enabled: Bool) {
    guard let index = model.localAdjustments.firstIndex(where: { $0.id == id }),
      (model.localAdjustments[index].range != nil) != enabled
    else { return }
    beginEdit(description: enabled ? "Enable colour range" : "Disable colour range")
    model.localAdjustments[index].range = enabled ? .coreDefault : nil
    endEdit()
  }

  /// Both ends of a mask slider drag, from a plain `Slider`'s
  /// `onEditingChanged` — the only start/end signal it gives.
  ///
  /// Start opens the transaction the drag's writes land in; END CLOSES IT.
  /// Opening without closing leaves the transaction pending, so the drag
  /// records no undo entry and schedules no sidecar write until some later
  /// boundary happens to close it — and whatever the user did in between is
  /// swallowed into the same entry (#3453 review). `isAdjustingMask` rides
  /// the same pair: it hides the overlay tint for the duration of the drag
  /// (#3364), which is exactly the drag's duration and not a moment longer.
  ///
  /// On `EditSession` rather than inside the SwiftUI view so it can be
  /// asserted in tests — the app target's own tests do not run in CI, the
  /// same reason `showsMaskOverlay` lives here.
  public func setMaskDragActive(_ editing: Bool) {
    isAdjustingMask = editing
    if editing {
      beginEdit()
    } else {
      endEdit()
    }
  }

  /// Continuous write: the caller owns the transaction boundary (the
  /// slider's `onEditingChanged` → `setMaskDragActive`), the same contract
  /// the adjustment sliders follow. Ignored for a layer with no range.
  public func setMaskRangeField(id: UUID, _ field: RangeField, _ value: Double) {
    guard let index = model.localAdjustments.firstIndex(where: { $0.id == id }),
      let range = model.localAdjustments[index].range
    else { return }
    model.localAdjustments[index].range = range.with(field, value)
  }
}
