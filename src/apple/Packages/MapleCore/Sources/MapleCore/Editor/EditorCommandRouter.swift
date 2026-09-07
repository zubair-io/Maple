import Foundation

/// One editor's command lifetime. Every input reaches the existing edit
/// transactions and zoom controller; no render or undo scheduler lives here.
@MainActor
@Observable
public final class EditorCommandRouter {
  public enum Command: Equatable {
    case undo, redo, resetGroup, fit, actualSize, zoomIn, zoomOut
    case pan(x: Double, y: Double)
    case nudge(Int)
    case nudgeRelease
    case group(Int)
    case compareToggle, comparePress, compareRelease
  }

  public let state: EditorState
  public let comparison: EditorComparison
  public private(set) var isActive = true
  private var comparePressedAt: ContinuousClock.Instant?
  private var compareWasLatched = false
  private var nudgeTransactionID: UInt64?
  private var nudgeTool: Tool?
  private var nudgeSubParamID: String?

  public init(state: EditorState) {
    self.state = state
    self.comparison = EditorComparison(session: state.session)
  }

  /// Capture the asset at resolution time. A queued menu/key action from a
  /// removed editor can neither act on the next image nor revive its old one.
  @discardableResult
  public func perform(_ command: Command, assetID: UUID) -> Bool {
    guard isActive, assetID == state.session.asset.id else { return false }
    switch command {
    case .nudge, .nudgeRelease: break
    default: finishNudge()
    }
    switch command {
    case .undo:
      state.cancelGesture()
      state.undo()
    case .redo:
      state.cancelGesture()
      state.redo()
    case .resetGroup:
      state.endGesture()
      state.resetGroup(state.armedGroup)
    case .fit: state.zoom.resetToFit()
    case .actualSize: state.zoom.zoomToScale(1)
    case .zoomIn: state.zoom.stepZoomIn()
    case .zoomOut: state.zoom.stepZoomOut()
    case .pan(let x, let y): state.zoom.keyboardPan(delta: CGSize(width: x, height: y))
    case .nudge(let direction):
      guard state.armedToolAcceptsValueEdits else { return false }
      let next = DragBarMath.clamp(state.armedInternalValue + Double(direction) * 10)
      guard next != state.armedInternalValue else { return true }
      if nudgeTransactionID != state.session.transactions.nextID || nudgeTool != state.armedTool
        || nudgeSubParamID != state.armedSubParamId
      {
        finishNudge()
        state.commit()
        state.beginGesture()
        nudgeTransactionID = state.session.transactions.nextID
        nudgeTool = state.armedTool
        nudgeSubParamID = state.armedSubParamId
      }
      state.setArmedInternalValue(next)
    case .nudgeRelease:
      guard nudgeTransactionID != nil else { return false }
      finishNudge()
    case .group(let direction):
      state.endGesture()
      let groups = ToolGroup.allCases
      guard let index = groups.firstIndex(of: state.armedGroup) else { return false }
      state.arm(group: groups[(index + direction + groups.count) % groups.count])
    case .compareToggle:
      cancelCompare()
      state.session.showingOriginal.toggle()
    case .comparePress:
      guard comparePressedAt == nil else { return false }
      comparePressedAt = .now
      compareWasLatched = state.session.showingOriginal
      state.session.showingOriginal = true
    case .compareRelease:
      guard let start = comparePressedAt else { return false }
      comparePressedAt = nil
      state.session.showingOriginal =
        start.duration(to: .now) < .milliseconds(300)
        ? !compareWasLatched : compareWasLatched
    }
    return true
  }

  /// A held global value key has one boundary, including deferred controls.
  /// A newer tool/transaction owns its own gesture and must not be closed here.
  public func finishNudge() {
    let ownsGesture =
      nudgeTransactionID != nil
      && nudgeTransactionID == state.session.transactions.nextID
      && nudgeTool == state.armedTool && nudgeSubParamID == state.armedSubParamId
    nudgeTransactionID = nil
    nudgeTool = nil
    nudgeSubParamID = nil
    if ownsGesture { state.endGesture() }
  }

  public func cancelCompare() {
    guard comparePressedAt != nil else { return }
    comparePressedAt = nil
    state.session.showingOriginal = compareWasLatched
  }

  /// Finish writes on their original session, discard a parked decode-product
  /// value, and reject every later callback from this view's old identity.
  public func deactivate() {
    cancelCompare()
    nudgeTransactionID = nil
    state.cancelGesture()
    state.session.endEdit()
    isActive = false
  }
}
