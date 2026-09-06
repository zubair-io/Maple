import MapleCore
import SwiftUI

private struct EditorRouterEnvironmentKey: EnvironmentKey {
  static let defaultValue: EditorCommandRouter? = nil
}

extension EnvironmentValues {
  var editorCommandRouter: EditorCommandRouter? {
    get { self[EditorRouterEnvironmentKey.self] }
    set { self[EditorRouterEnvironmentKey.self] = newValue }
  }
}

private struct EditorRouterFocusKey: FocusedValueKey {
  typealias Value = EditorCommandRouter
}

extension FocusedValues {
  var editorCommandRouter: EditorCommandRouter? {
    get { self[EditorRouterFocusKey.self] }
    set { self[EditorRouterFocusKey.self] = newValue }
  }
}

/// SwiftUI delivers value keys to the focused child first. The shell only
/// handles keys a slider/text field did not claim, on Mac and iPad alike.
struct EditorCommandScope: ViewModifier {
  @State private var router: EditorCommandRouter?
  @Environment(\.scenePhase) private var scenePhase
  @FocusState private var canvasFocused: Bool
  let state: EditorState
  let navigate: (Int) -> Void

  func body(content: Content) -> some View {
    content
      .environment(\.editorCommandRouter, router)
      .focusedSceneValue(\.editorCommandRouter, router?.isActive == true ? router : nil)
      .focusable().focused($canvasFocused).focusEffectDisabled()
      .onAppear {
        if router?.isActive != true { router = EditorCommandRouter(state: state) }
        canvasFocused = true
      }
      .onKeyPress(phases: [.down, .repeat, .up]) { press in handle(press) }
      .onChange(of: canvasFocused) { _, hasFocus in
        if !hasFocus {
          router?.cancelCompare()
          router?.finishNudge()
        }
      }
      .onChange(of: scenePhase) { _, phase in
        if phase != .active {
          router?.cancelCompare()
          router?.finishNudge()
        }
      }
      .onDisappear { router?.deactivate() }
  }

  private func handle(_ press: KeyPress) -> KeyPress.Result {
    let key = press.characters.lowercased()
    let compare = key == "b" || key == "\\"
    if compare && press.phase == .up { return perform(.compareRelease) }
    // Shift may be released before the arrow; its key-up still closes the
    // burst. A focused slider consumes its own release before reaching us.
    if press.phase == .up && (press.key == .leftArrow || press.key == .rightArrow) {
      return perform(.nudgeRelease)
    }
    guard !EditorTextInput.hasFocus,
      press.modifiers.intersection([.command, .control]).isEmpty
    else { return .ignored }
    if compare && press.modifiers.intersection([.option]).isEmpty {
      return press.phase == .repeat ? .handled : perform(.comparePress)
    }
    guard press.phase != .up else { return .ignored }
    if press.modifiers.contains(.option) {
      let step = press.modifiers.contains(.shift) ? 128.0 : 32.0
      switch press.key {
      case .leftArrow: return perform(.pan(x: step, y: 0))
      case .rightArrow: return perform(.pan(x: -step, y: 0))
      case .upArrow: return perform(.pan(x: 0, y: step))
      case .downArrow: return perform(.pan(x: 0, y: -step))
      default: return .ignored
      }
    }
    if press.modifiers.contains(.shift) {
      switch press.key {
      case .leftArrow: return perform(.nudge(-1))
      case .rightArrow: return perform(.nudge(1))
      default: break
      }
    }
    switch press.key {
    case .upArrow: return perform(.group(-1))
    case .downArrow: return perform(.group(1))
    case .leftArrow:
      navigate(-1)
      return .handled
    case .rightArrow:
      navigate(1)
      return .handled
    default:
      switch key {
      case "f": return perform(.fit)
      case "z": return perform(.actualSize)
      case "r": return perform(.resetGroup)
      default: return .ignored
      }
    }
  }

  private func perform(_ command: EditorCommandRouter.Command) -> KeyPress.Result {
    router?.perform(command, assetID: state.session.asset.id) == true ? .handled : .ignored
  }
}
