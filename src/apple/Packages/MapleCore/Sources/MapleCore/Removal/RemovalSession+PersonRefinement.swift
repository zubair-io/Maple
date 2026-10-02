import Foundation

struct RemovalPersonSelection: Sendable {
  let id: Int
  let mask: Data
}

struct RemovalPersonGesture: Sendable {
  let id: Int
  let strokes: [RemovalStroke]
}

extension NativeRemovalEditorEngine {
  /// Source mask replay stays off main and never invokes a model. Each person
  /// retains an independent native window for the existing grouped generation.
  func refinePeople(
    _ bases: [RemovalPersonSelection], gestures: [RemovalPersonGesture], protection: Data
  ) throws -> (selection: Data, masks: [Data]) {
    let masks = try bases.map { base in
      let strokes = gestures.filter { $0.id == base.id }.flatMap(\.strokes)
      return try RemovalBridge.refineSelection(base.mask, strokes: strokes, protection: protection)
    }.filter { !$0.isEmpty }
    let selection = try masks.reduce(Data()) { try RemovalBridge.combineMasks($0, $1) }
    return (selection, masks)
  }
}

extension RemovalSession {
  public func refinePerson(_ id: Int?) {
    guard phase == .ready else { return }
    guard id == nil || personBases.contains(where: { $0.id == id }) else { return }
    refiningPersonID = id
  }

  func resetPersonRefinement(_ bases: [RemovalPersonSelection] = []) {
    personBases = bases
    personGestures = []
    redoPersonGestures = []
    refiningPersonID = nil
  }

  func paintPerson(_ strokes: [RemovalStroke], token: UInt64)
    async throws
  {
    guard let id = refiningPersonID, !strokes.isEmpty else {
      if current(token) { phase = .ready }
      return
    }
    let proposed = personGestures + [RemovalPersonGesture(id: id, strokes: strokes)]
    let result = try await engine.refinePeople(
      personBases, gestures: proposed, protection: protection)
    guard current(token) else { return }
    personGestures = proposed
    redoPersonGestures = []
    selection = result.selection
    personMasks = result.masks
    phase = .ready
  }

  func undoPersonRefinement() async {
    guard canUndoSelection, let gesture = personGestures.last else { return }
    let token = revision &+ 1
    revision = token
    phase = .selecting
    message = ""
    do {
      let proposed = Array(personGestures.dropLast())
      let result = try await engine.refinePeople(
        personBases, gestures: proposed, protection: protection)
      guard current(token) else { return }
      personGestures = proposed
      redoPersonGestures.append(gesture)
      selection = result.selection
      personMasks = result.masks
      phase = .ready
    } catch { fail(error, token: token) }
  }

  func redoPersonRefinement() async {
    guard canRedoSelection, let gesture = redoPersonGestures.last else { return }
    let token = revision &+ 1
    revision = token
    phase = .selecting
    message = ""
    do {
      let proposed = personGestures + [gesture]
      let result = try await engine.refinePeople(
        personBases, gestures: proposed, protection: protection)
      guard current(token) else { return }
      personGestures = proposed
      redoPersonGestures.removeLast()
      selection = result.selection
      personMasks = result.masks
      phase = .ready
    } catch { fail(error, token: token) }
  }
}
