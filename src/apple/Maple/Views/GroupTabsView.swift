// GroupTabsView.swift — responsive-program S5a (#625).
//
// 4-tab segmented row (Light · Color · Effects · Detail). Selected tab
// gets a `primary` 600-weight label + 1.5pt accent underline. Tap
// switches the armed group via `EditorState.arm(group:)`, cross-fading
// with `Motion.groupSwap`.
//
// Spec: docs/design/responsive-program/s5-editor.md §2.

import SwiftUI
import MapleCore

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
                            .font(.system(size: 12,
                                          weight: selected ? .semibold : .regular))
                            .foregroundStyle(selected ? MapleTokens.primary : MapleTokens.textMuted)
                        Rectangle()
                            .fill(selected ? MapleTokens.primary : Color.clear)
                            .frame(height: 1.5)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("editor-group-\(group.rawValue)")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .frame(height: 32)
        .background(MapleTokens.bg)
    }
}
