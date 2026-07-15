// GroupTabsView.swift — compact editor group navigation.
//
// Restored from the original S5 iPhone editor. The selected group uses the
// Maple accent and underline; changing groups keeps the current EditorState
// and rendering pipeline intact.

import MapleCore
import SwiftUI

struct GroupTabsView: View {
  @Bindable var state: EditorState

  var body: some View {
    HStack(spacing: 0) {
      ForEach(ToolGroup.allCases, id: \.self) { group in
        let selected = state.armedGroup == group
        Button {
          withAnimation(MapleTokens.Motion.groupSwap) {
            state.arm(group: group)
          }
        } label: {
          VStack(spacing: 4) {
            Text(group.displayName)
              .font(.system(size: 12, weight: selected ? .semibold : .regular))
              .foregroundStyle(selected ? MapleTokens.primary : MapleTokens.textMuted)
            Rectangle()
              .fill(selected ? MapleTokens.primary : Color.clear)
              .frame(height: 1.5)
          }
          .frame(maxWidth: .infinity)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.displayName)
        .accessibilityIdentifier("editor-group-\(group.rawValue)")
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .frame(height: 44)
    .background(MapleTokens.bg)
    .accessibilityIdentifier("editor-group-tabs")
  }
}
