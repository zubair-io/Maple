import MapleCore
import MapleUI
import SwiftUI

struct FocusedRemovalControls: View {
  @Bindable var state: EditorState
  @State private var flyoutOpen = true

  private var removal: RemovalSession { state.removal }

  var body: some View {
    GeometryReader { geometry in
      HStack(alignment: .top, spacing: 8) {
        if flyoutOpen {
          ScrollView {
            RemovalPanel(state: state, showsModePicker: false)
              .padding(.vertical, 10)
          }
          .frame(width: 320, height: min(680, max(300, geometry.size.height - 112)))
          .background(
            ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 14)
          )
          .overlay {
            RoundedRectangle(cornerRadius: 14).stroke(ProTokens.border, lineWidth: 0.75)
          }
          .reportsWheelExclusion(in: "editorCanvas", active: true)
          .transition(.move(edge: .trailing).combined(with: .opacity))
        }
        RemovalModeRail(state: state, flyoutOpen: $flyoutOpen)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
      .padding(.trailing, 24)
      .padding(.top, 72)
      .padding(.bottom, 20)
      .animation(MapleTokens.Motion.groupSwap, value: flyoutOpen)
    }
  }
}

struct RemovalExitButton: View {
  @Bindable var state: EditorState
  let returnTool: Tool

  var body: some View {
    VStack {
      HStack {
        Button {
          state.arm(tool: returnTool == .remove ? .exposure : returnTool)
        } label: {
          Label("Exit AI editor", systemImage: "xmark")
            .font(.callout.weight(.medium))
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(MapleTokens.surface.opacity(0.96), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("removal-exit-editor")
        Spacer()
      }
      Spacer()
    }
    .padding(.leading, 24)
    .padding(.top, 16)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

private struct RemovalModeRail: View {
  @Bindable var state: EditorState
  @Binding var flyoutOpen: Bool

  private var removal: RemovalSession { state.removal }

  var body: some View {
    VStack(spacing: 6) {
      ForEach(RemovalSession.Mode.allCases, id: \.rawValue) { mode in
        let selected = removal.mode == mode
        Button {
          if selected {
            flyoutOpen.toggle()
          } else {
            flyoutOpen = true
            Task { await removal.setMode(mode) }
          }
        } label: {
          VStack(spacing: 4) {
            ZStack {
              Circle()
                .fill(selected ? ProTokens.accent(0x28) : ProTokens.panel)
                .overlay {
                  Circle().stroke(selected ? ProTokens.accent : ProTokens.border, lineWidth: 0.5)
                }
                .frame(width: 36, height: 36)
              Image(systemName: mode.symbol)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(selected ? ProTokens.accent : ProTokens.text)
            }
            Text(mode.shortLabel)
              .font(.system(size: 9, weight: selected ? .semibold : .regular))
              .foregroundStyle(selected ? ProTokens.accent : ProTokens.textMuted)
              .lineLimit(1)
              .minimumScaleFactor(0.8)
          }
          .frame(width: 52)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(removal.busy || removal.phase == .review)
        .accessibilityLabel(mode.accessibilityLabel)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("removal-mode-\(mode.rawValue)")
      }
    }
    .padding(.vertical, 10)
    .frame(width: 64)
    .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 14))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Removal selection modes")
    .accessibilityIdentifier("removal-mode-rail")
  }
}

extension RemovalSession.Mode {
  fileprivate var shortLabel: String {
    switch self {
    case .paint: "Paint"
    case .smart: "Auto"
    case .people: "People"
    }
  }

  fileprivate var accessibilityLabel: String {
    switch self {
    case .smart: "Auto Mask"
    case .paint, .people: shortLabel
    }
  }

  fileprivate var symbol: String {
    switch self {
    case .paint: "paintbrush.pointed"
    case .smart: "viewfinder"
    case .people: "person.2"
    }
  }
}
