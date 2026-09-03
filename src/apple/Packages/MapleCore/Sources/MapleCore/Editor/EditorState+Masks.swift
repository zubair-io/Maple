// EditorState+Masks.swift — the mask-editing session (#355, slice 3 of #280).
//
// Transient UI state (which layer is selected, whether a continuous mask
// gesture is open) lives here on `EditorState`; the layers themselves are
// `session.model.localAdjustments`, so undo/redo, the debounced sidecar
// write and the live render all follow automatically from
// `EditSession.model`'s setter — same one-source-of-truth rule every other
// tool obeys (see the `EditorState.swift` header).
//
// Undo boundaries: a DISCRETE edit (add, remove, invert, reset) commits its
// own snapshot; a CONTINUOUS one (a slider or a canvas-handle drag) opens a
// gesture with `beginMaskGesture()` — which commits once, idempotently —
// and closes it with `endMaskGesture()` on release, mirroring
// `beginGesture`/`endGesture` on the scalar value pipe.

import CoreGraphics
import Foundation

extension EditorState {
    /// The selected layer, or nil when nothing valid is selected (the index
    /// can go stale after an undo shrinks the stack).
    public var selectedMask: LocalAdjustment? {
        guard let index = selectedMaskIndex,
              session.model.localAdjustments.indices.contains(index)
        else { return nil }
        return session.model.localAdjustments[index]
    }

    /// Select layer `index` (nil, or an out-of-range index, clears it).
    public func selectMask(_ index: Int?) {
        endMaskGesture()
        selectedMaskIndex = index.flatMap {
            session.model.localAdjustments.indices.contains($0) ? $0 : nil
        }
    }

    /// Append a layer carrying `mask` and no adjustments yet, select it,
    /// and return its index. One undo entry.
    @discardableResult
    public func addMask(_ mask: LocalMask) -> Int {
        endMaskGesture()
        commit()
        session.model.localAdjustments.append(
            LocalAdjustment(mask: mask, adjustments: PartialAdjustments()))
        let index = session.model.localAdjustments.count - 1
        selectedMaskIndex = index
        return index
    }

    /// Add a default linear gradient (top → middle of the frame).
    @discardableResult
    public func addLinearMask() -> Int {
        addMask(MaskGeometry.defaultLinear())
    }

    /// Add a default radial mask — a circle on screen, centered.
    @discardableResult
    public func addRadialMask() -> Int {
        let native = session.nativeImageSize
        let aspect = native.width > 0 && native.height > 0
            ? Double(native.width) / Double(native.height) : 1
        return addMask(MaskGeometry.defaultRadial(imageAspect: aspect))
    }

    /// Remove layer `index`. Selection moves to the nearest surviving layer.
    public func removeMask(at index: Int) {
        guard session.model.localAdjustments.indices.contains(index) else { return }
        endMaskGesture()
        commit()
        session.model.localAdjustments.remove(at: index)
        let count = session.model.localAdjustments.count
        selectedMaskIndex = count == 0 ? nil : min(index, count - 1)
    }

    public func removeSelectedMask() {
        guard let index = selectedMaskIndex else { return }
        removeMask(at: index)
    }

    // MARK: Continuous edits

    /// Open a continuous mask gesture: commits ONE undo snapshot, no matter
    /// how many times it is called before `endMaskGesture()`.
    public func beginMaskGesture() {
        guard !maskGestureActive else { return }
        commit()
        maskGestureActive = true
    }

    /// Close the gesture opened by `beginMaskGesture()`.
    public func endMaskGesture() {
        maskGestureActive = false
    }

    /// Rewrite the selected layer. A `discrete` edit commits its own undo
    /// entry; a continuous one rides the open gesture (opening it if the
    /// caller forgot, so no mask edit can ever land without a snapshot).
    public func updateSelectedMask(discrete: Bool = false, _ body: (inout LocalAdjustment) -> Void) {
        guard let index = selectedMaskIndex,
              session.model.localAdjustments.indices.contains(index)
        else { return }
        if discrete {
            endMaskGesture()
            commit()
        } else {
            beginMaskGesture()
        }
        var layer = session.model.localAdjustments[index]
        body(&layer)
        guard layer != session.model.localAdjustments[index] else { return }
        session.model.localAdjustments[index] = layer
    }

    /// Replace the selected layer's mask shape (a handle drag).
    public func setSelectedMaskShape(_ mask: LocalMask) {
        updateSelectedMask { $0.mask = mask }
    }

    /// The selected layer's value for `field`, `0` when the control is not
    /// set — what a slider shows for "no local change".
    public func maskAdjustment(_ field: WritableKeyPath<PartialAdjustments, Double?>) -> Double {
        selectedMask?.adjustments[keyPath: field] ?? 0
    }

    /// Set one control on the selected layer (continuous — a slider drag).
    public func setMaskAdjustment(_ field: WritableKeyPath<PartialAdjustments, Double?>, _ value: Double) {
        updateSelectedMask { $0.adjustments[keyPath: field] = value }
    }

    /// Clear every control on the selected layer. One undo entry.
    public func resetSelectedMaskAdjustments() {
        updateSelectedMask(discrete: true) { $0.adjustments = PartialAdjustments() }
    }

    /// Set the selected layer's feather (continuous).
    public func setSelectedMaskFeather(_ feather: Double) {
        let clamped = min(1, max(0, feather))
        updateSelectedMask { layer in
            switch layer.mask {
            case .linear(let start, let end, _):
                layer.mask = .linear(start: start, end: end, feather: clamped)
            case .radial(let center, let radii, let angle, _, let invert):
                layer.mask = .radial(center: center, radii: radii, angle: angle, feather: clamped, invert: invert)
            }
        }
    }

    /// Flip a radial layer's sense (discrete). No-op for a linear layer.
    public func setSelectedMaskInverted(_ invert: Bool) {
        updateSelectedMask(discrete: true) { layer in
            if case .radial(let center, let radii, let angle, let feather, _) = layer.mask {
                layer.mask = .radial(center: center, radii: radii, angle: angle, feather: feather, invert: invert)
            }
        }
    }
}
