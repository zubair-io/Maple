import Foundation

public enum GeometricMaskKind: String, CaseIterable, Sendable {
  case linear, radial
}

@MainActor
extension EditSession {
  public var selectedMaskLayer: LocalAdjustment? {
    model.localAdjustments.first { $0.id == selectedMaskId }
  }
  public var selectedMaskComponent: MaskComponent? {
    guard case .group(let group) = selectedMaskLayer?.mask, !group.components.isEmpty else {
      return nil
    }
    return group.components[maskComponentIndex(group)]
  }
  public var selectedMaskGeometry: LocalMask? {
    selectedMaskComponent?.mask ?? selectedMaskLayer?.mask
  }
  private func maskComponentIndex(_ group: MaskGroup) -> Int {
    min(max(selectedMaskComponentIndex, 0), max(group.components.count - 1, 0))
  }

  public func selectMaskComponent(_ index: Int) {
    guard case .group(let group) = selectedMaskLayer?.mask, group.components.indices.contains(index)
    else { return }
    setMaskDragActive(false)
    selectedMaskComponentIndex = index
  }

  private func defaultMask(_ kind: GeometricMaskKind) -> LocalMask {
    switch kind {
    case .linear:
      return .linear(
        start: MaskPoint(x: 0.5, y: 0.15), end: MaskPoint(x: 0.5, y: 0.55), feather: 0.5)
    case .radial:
      let aspect = nativeImageSize.height > 0 ? nativeImageSize.width / nativeImageSize.height : 1
      return .radial(
        center: MaskPoint(x: 0.5, y: 0.5),
        radii: MaskPoint(x: 0.25, y: 0.25 * aspect), angle: 0, feather: 0.5, invert: false)
    }
  }

  public func createGeometricMask(_ kind: GeometricMaskKind) {
    beginEdit(description: "Add \(kind.rawValue) mask")
    let layer = LocalAdjustment(mask: defaultMask(kind), adjustments: PartialAdjustments())
    model.localAdjustments.append(layer)
    selectedMaskId = layer.id
    endEdit()
  }

  /// Transform one layer without altering its controls, range, ID or imported XML.
  /// Slider/canvas gestures open their transaction via setMaskDragActive.
  private func editSelectedMask(
    discrete: Bool, description: String,
    transform: (LocalMask) -> LocalMask
  ) {
    guard let index = model.localAdjustments.firstIndex(where: { $0.id == selectedMaskId }) else {
      return
    }
    let next = transform(model.localAdjustments[index].mask)
    guard next != model.localAdjustments[index].mask else { return }
    let completesTransaction = discrete || !isAdjustingMask
    if completesTransaction {
      beginEdit(description: description)
    }
    model.localAdjustments[index].mask = next
    if completesTransaction { endEdit() }
  }

  public func addMaskComponent(_ kind: GeometricMaskKind, combine: MaskCombine) {
    let leaf = defaultMask(kind)
    let index: Int
    if case .group(let group) = selectedMaskLayer?.mask {
      index = group.components.count
    } else {
      index = 1
    }
    editSelectedMask(discrete: true, description: "Compose mask") { mask in
      guard let component = MaskComponent(mask: leaf, combine: combine) else { return mask }
      if case .group(var group) = mask {
        group.components.append(component)
        return .group(group)
      }
      guard let initial = MaskComponent(mask: mask) else { return mask }
      return .group(MaskGroup(components: [initial, component]))
    }
    selectedMaskComponentIndex = index
  }

  public func removeMaskComponent(_ index: Int) {
    guard case .group(let group) = selectedMaskLayer?.mask, group.components.count > 1,
      group.components.indices.contains(index)
    else { return }
    let selected = maskComponentIndex(group)
    editSelectedMask(discrete: true, description: "Remove mask component") { mask in
      guard case .group(var group) = mask else { return mask }
      group.components.remove(at: index)
      return .group(group)
    }
    selectedMaskComponentIndex = min(
      index < selected ? selected - 1 : selected, group.components.count - 2)
  }

  public func setMaskComponentCombine(_ combine: MaskCombine) {
    editComponent(discrete: true, description: "Change mask composition") { $0.combine = combine }
  }
  public func setMaskComponentInverted(_ inverted: Bool) {
    editComponent(discrete: true, description: "Invert mask component") { $0.invert = inverted }
  }
  private func editComponent(
    discrete: Bool, description: String, transform: (inout MaskComponent) -> Void
  ) {
    editSelectedMask(discrete: discrete, description: description) { mask in
      guard case .group(var group) = mask, !group.components.isEmpty else { return mask }
      let index = self.maskComponentIndex(group)
      transform(&group.components[index])
      return .group(group)
    }
  }

  public func setMaskGeometry(_ geometry: LocalMask) {
    if case .group = geometry { return }
    editSelectedMask(discrete: false, description: "Edit mask geometry") { mask in
      guard case .group(var group) = mask else { return geometry }
      guard !group.components.isEmpty else { return mask }
      let index = self.maskComponentIndex(group)
      _ = group.components[index].replaceMask(geometry)
      return .group(group)
    }
  }

  public func setMaskOpacity(_ opacity: Double) {
    guard opacity.isFinite else { return }
    let value = min(max(opacity, 0), 1)
    editSelectedMask(discrete: false, description: "Mask opacity") { mask in
      if case .group(var group) = mask {
        group.opacity = value
        return .group(group)
      }
      guard value != 1, let component = MaskComponent(mask: mask) else { return mask }
      return .group(MaskGroup(components: [component], opacity: value))
    }
  }

  public func setMaskGroupInverted(_ inverted: Bool) {
    editSelectedMask(discrete: true, description: "Invert mask") { mask in
      guard case .group(var group) = mask else { return mask }
      group.invert = inverted
      return .group(group)
    }
  }
}
