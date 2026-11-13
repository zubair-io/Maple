// GroupTabsView.swift — compact editor group navigation.
//
// Restored from the original S5 iPhone editor. The selected group uses the
// Maple accent and underline; changing groups keeps the current EditorState
// and rendering pipeline intact.

import MapleCore
import SwiftUI

struct GroupTabsView: View {
  @Bindable var state: EditorState

  /// The landscape vertical bar stacks the tabs and turns each label a
  /// quarter-turn, so its underline becomes a rule beside the text.
  var axis: Axis = .horizontal

  private static let verticalTabLength: CGFloat = 76
  static let tabThickness: CGFloat = 44

  var body: some View {
    let arrangement =
      axis == .horizontal
      ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
    arrangement {
      ForEach(ToolGroup.allCases, id: \.self) { group in
        let selected = state.armedGroup == group
        Button {
          withAnimation(MapleTokens.Motion.groupSwap) {
            state.arm(group: group)
          }
        } label: {
          tabLabel(group, selected: selected)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.displayName)
        .accessibilityIdentifier("editor-group-\(group.rawValue)")
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .frame(width: axis == .vertical ? Self.tabThickness : nil)
    .frame(height: axis == .horizontal ? Self.tabThickness : nil)
    .background(axis == .horizontal ? MapleTokens.bg : Color.clear)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-group-tabs")
  }

  @ViewBuilder
  private func tabLabel(_ group: ToolGroup, selected: Bool) -> some View {
    let label = VStack(spacing: 4) {
      Text(group.displayName)
        .font(.system(size: 12, weight: selected ? .semibold : .regular))
        .foregroundStyle(selected ? MapleTokens.primary : MapleTokens.textMuted)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
      Rectangle()
        .fill(selected ? MapleTokens.primary : Color.clear)
        .frame(height: 1.5)
    }
    if axis == .horizontal {
      label.frame(maxWidth: .infinity)
    } else {
      // Rotation is render-only, so the turned label is laid out in the
      // swapped frame it occupies on screen.
      label
        .frame(width: Self.verticalTabLength, height: Self.tabThickness)
        .rotationEffect(.degrees(-90))
        .frame(width: Self.tabThickness, height: Self.verticalTabLength)
    }
  }
}
