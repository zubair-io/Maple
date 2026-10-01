import MapleCore
import MapleUI
import SwiftUI

struct MaskCompositionSection: View {
  @Bindable var state: EditorState
  private var session: EditSession { state.session }
  private var group: MaskGroup? {
    if case .group(let group) = session.selectedMaskLayer?.mask { return group }
    return nil
  }

  var body: some View {
    VStack(spacing: 6) {
      HStack {
        composeMenu(.add, label: "Add to mask")
        composeMenu(.subtract, label: "Subtract")
        composeMenu(.intersect, label: "Intersect")
      }
      if let group {
        ForEach(Array(group.components.enumerated()), id: \.offset) { index, component in
          MuiListRow(
            label: title(component.mask, index: index),
            subtitle: combineName(component.combine) + (component.invert ? " · inverted" : ""),
            active: session.selectedMaskComponentIndex == index,
            pressed: { session.selectMaskComponent(index) }
          ) {
            MuiButton(
              label: "Delete component", variant: .ghost, size: .sm,
              leadingIcon: "delete", iconOnly: true, disabled: group.components.count == 1
            ) {
              session.removeMaskComponent(index)
            }
            .accessibilityIdentifier("editor-mask-component-delete-\(index)")
          }
          .accessibilityIdentifier("editor-mask-component-\(index)")
        }
        if let component = session.selectedMaskComponent {
          Picker(
            "Combine",
            selection: Binding(get: { component.combine }, set: session.setMaskComponentCombine)
          ) {
            ForEach(MaskCombine.allCases, id: \.self) { mode in Text(combineName(mode)).tag(mode) }
          }
          .pickerStyle(.menu)
          .accessibilityIdentifier("editor-mask-component-combine")
          MuiToggle(
            checked: Binding(get: { component.invert }, set: session.setMaskComponentInverted),
            label: "Invert component"
          )
          .accessibilityIdentifier("editor-mask-component-invert")
        }
        MuiToggle(
          checked: Binding(get: { group.invert }, set: session.setMaskGroupInverted),
          label: "Invert mask"
        )
        .accessibilityIdentifier("editor-mask-group-invert")
      }
      slider("Opacity", value: group?.opacity ?? 1, change: session.setMaskOpacity)
      if let feather = feather {
        slider("Feather", value: feather, change: setFeather)
      }
      if group == nil, case .radial(_, _, _, _, let inverted) = session.selectedMaskGeometry {
        MuiToggle(checked: Binding(get: { inverted }, set: setRadialInverted), label: "Invert")
          .accessibilityIdentifier("editor-mask-invert")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-mask-composition")
  }

  private func composeMenu(_ combine: MaskCombine, label: String) -> some View {
    Menu {
      ForEach(GeometricMaskKind.allCases, id: \.self) { kind in
        Button(kind.rawValue.capitalized) { session.addMaskComponent(kind, combine: combine) }
          .accessibilityIdentifier(
            "editor-mask-\(combineName(combine).lowercased())-\(kind.rawValue)-component")
      }
    } label: {
      MuiText(label, variant: .body)
    }
    .accessibilityLabel(label)
  }

  private func slider(_ label: String, value: Double, change: @escaping (Double) -> Void)
    -> some View
  {
    HStack {
      Text(label).font(.system(size: 11)).frame(width: 90, alignment: .leading)
      Slider(
        value: Binding(get: { value }, set: change), in: 0...1,
        onEditingChanged: { session.setMaskDragActive($0) }
      )
      .accessibilityLabel(label)
      Text(value, format: .percent.precision(.fractionLength(0)))
        .font(.system(size: 11).monospacedDigit()).frame(width: 40, alignment: .trailing)
    }
    .accessibilityIdentifier("editor-mask-\(label.lowercased())")
  }

  private var feather: Double? {
    switch session.selectedMaskGeometry {
    case .linear(_, _, let feather), .radial(_, _, _, let feather, _): return feather
    default: return nil
    }
  }
  private func setFeather(_ value: Double) {
    switch session.selectedMaskGeometry {
    case .linear(let start, let end, _):
      session.setMaskGeometry(.linear(start: start, end: end, feather: value))
    case .radial(let center, let radii, let angle, _, let invert):
      session.setMaskGeometry(
        .radial(center: center, radii: radii, angle: angle, feather: value, invert: invert))
    default: break
    }
  }
  private func setRadialInverted(_ value: Bool) {
    guard
      case .radial(let center, let radii, let angle, let feather, let current) = session
        .selectedMaskGeometry,
      current != value
    else { return }
    session.setMaskDragActive(true)
    session.setMaskGeometry(
      .radial(center: center, radii: radii, angle: angle, feather: feather, invert: value))
    session.setMaskDragActive(false)
  }
  private func title(_ mask: LocalMask, index: Int) -> String {
    let name: String
    switch mask {
    case .linear: name = "Linear"
    case .radial: name = "Radial"
    case .bitmap: name = "Person"
    case .everywhere: name = "Everywhere"
    case .group: name = "Mask group"
    }
    return "\(name) \(index + 1)"
  }
  private func combineName(_ combine: MaskCombine) -> String {
    switch combine {
    case .add: return "Add"
    case .subtract: return "Subtract"
    case .intersect: return "Intersect"
    }
  }
}
