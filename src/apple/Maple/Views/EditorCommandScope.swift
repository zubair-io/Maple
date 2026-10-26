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

private struct EditorCanUndoFocusKey: FocusedValueKey {
  typealias Value = Bool
}

private struct EditorCanRedoFocusKey: FocusedValueKey {
  typealias Value = Bool
}

private struct ToneCurveKeyPressFocusKey: FocusedValueKey {
  typealias Value = (KeyPress) -> KeyPress.Result
}

@MainActor final class ToneCurveKeyboardBridge {
  var handle: ((KeyPress) -> KeyPress.Result)?
  var resign: (() -> Void)?
}

private struct ToneCurveKeyboardBridgeKey: EnvironmentKey {
  static let defaultValue: ToneCurveKeyboardBridge? = nil
}

extension EnvironmentValues {
  var toneCurveKeyboardBridge: ToneCurveKeyboardBridge? {
    get { self[ToneCurveKeyboardBridgeKey.self] }
    set { self[ToneCurveKeyboardBridgeKey.self] = newValue }
  }
}

extension FocusedValues {
  var toneCurveKeyPress: ((KeyPress) -> KeyPress.Result)? {
    get { self[ToneCurveKeyPressFocusKey.self] }
    set { self[ToneCurveKeyPressFocusKey.self] = newValue }
  }

  var editorCommandRouter: EditorCommandRouter? {
    get { self[EditorRouterFocusKey.self] }
    set { self[EditorRouterFocusKey.self] = newValue }
  }

  var editorCanUndo: Bool? {
    get { self[EditorCanUndoFocusKey.self] }
    set { self[EditorCanUndoFocusKey.self] = newValue }
  }

  var editorCanRedo: Bool? {
    get { self[EditorCanRedoFocusKey.self] }
    set { self[EditorCanRedoFocusKey.self] = newValue }
  }
}

/// Routes focused knot input before shell navigation. Ordinary slider and
/// text-field input retains its existing native focus route.
struct EditorCommandScope: ViewModifier {
  @State private var router: EditorCommandRouter?
  @State private var toneCurveKeyboardBridge = ToneCurveKeyboardBridge()
  @Environment(\.scenePhase) private var scenePhase
  @FocusState private var canvasFocused: Bool
  @FocusedValue(\.toneCurveKeyPress) private var toneCurveKeyPress
  let state: EditorState
  let navigate: (Int) -> Void

  func body(content: Content) -> some View {
    content
      .environment(\.editorCommandRouter, router)
      .environment(\.toneCurveKeyboardBridge, toneCurveKeyboardBridge)
      .focusedSceneValue(\.editorCommandRouter, router?.isActive == true ? router : nil)
      .focusedSceneValue(\.editorCanUndo, router?.isActive == true ? state.canUndo : false)
      .focusedSceneValue(\.editorCanRedo, router?.isActive == true ? state.canRedo : false)
      .focusable().focused($canvasFocused).focusEffectDisabled()
      .onAppear {
        if router?.isActive != true { router = EditorCommandRouter(state: state) }
        // Forcing key-input focus on iOS summons the software keyboard when
        // a native menu opens. Let touch/hardware focus choose its responder.
        #if os(macOS)
          canvasFocused = true
        #endif
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
      .onChange(of: state.canUndo) { _, _ in
        NotificationCenter.default.post(name: .mapleEditorHistoryDidChange, object: nil)
      }
      .onChange(of: state.canRedo) { _, _ in
        NotificationCenter.default.post(name: .mapleEditorHistoryDidChange, object: nil)
      }
      .onDisappear { router?.deactivate() }
  }

  private func handle(_ press: KeyPress) -> KeyPress.Result {
    guard !state.session.workflow.isBusy, !state.session.workflow.isPresented,
      !EditorTextInput.hasFocus
    else {
      router?.cancelCompare()
      router?.finishNudge()
      return .ignored
    }
    if press.characters.lowercased() == "z", press.modifiers.contains(.command),
      press.modifiers.intersection([.control, .option]).isEmpty
    {
      guard press.phase == .down else { return .handled }
      return perform(press.modifiers.contains(.shift) ? .redo : .undo)
    }
    // A focused knot owns its arrow event before the ancestor scope (#4384).
    // Modifier-based pan and commands still fall through to the normal routes.
    let knotKey = [.leftArrow, .rightArrow, .upArrow, .downArrow].contains(press.key)
    #if os(iOS)
      let knotInput = knotKey || press.key == .tab || press.key == KeyEquivalent("\u{19}")
    #else
      let knotInput = knotKey
    #endif
    if knotInput {
      #if os(iOS)
        if let toneCurveKeyPress {
          let result = toneCurveKeyPress(press)
          if case .handled = result { return .handled }
          // Boundary Tab resigns the native knot and returns .ignored so
          // UIKit can traverse focus. Redispatching it through the bridge
          // would focus the first/last knot again in the same key event.
          if press.key == .tab || press.key == KeyEquivalent("\u{19}") {
            return result
          }
        }
        if let handler = toneCurveKeyboardBridge.handle, case .handled = handler(press) {
          return .handled
        }
      #else
        if let toneCurveKeyPress, case .handled = toneCurveKeyPress(press) { return .handled }
      #endif
    }
    let key = press.characters.lowercased()
    let compare = key == "b" || key == "\\"
    if compare && press.phase == .up { return perform(.compareRelease) }
    // Shift may be released before the arrow; its key-up still closes the
    // burst. A focused slider consumes its own release before reaching us.
    if press.phase == .up && (press.key == .leftArrow || press.key == .rightArrow) {
      return perform(.nudgeRelease)
    }
    guard press.modifiers.intersection([.command, .control]).isEmpty
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
