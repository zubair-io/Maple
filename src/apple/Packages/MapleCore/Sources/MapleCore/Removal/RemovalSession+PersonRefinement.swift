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
  /// Apply list choices to the retained detector/SAM masks. This cold edit work
  /// stays off main and never re-segments people or enters the slider loop.
  func peopleSelection(
    _ people: [RemovalSession.Person], masks: [RemovalPersonSelection], manualProtection: Data
  ) throws -> (
    selection: Data, protection: Data, bases: [RemovalPersonSelection],
    conflicts: [RemovalPersonProtectionConflict]
  ) {
    var protection = manualProtection
    for person in people where person.keep {
      guard let mask = masks.first(where: { $0.id == person.id }) else {
        throw RemovalError.invalid("Missing detected person selection")
      }
      protection = try RemovalBridge.combineMasks(protection, mask.mask)
    }
    var conflicts: [RemovalPersonProtectionConflict] = []
    let bases = try people.filter { !$0.keep }.compactMap { person -> RemovalPersonSelection? in
      guard let mask = masks.first(where: { $0.id == person.id }) else {
        throw RemovalError.invalid("Missing detected person selection")
      }
      guard !mask.mask.isEmpty else { return nil }
      // Use shared protection subtraction and border trimming: an erased
      // detector extent must not consume the native context limit.
      let selected = try RemovalBridge.refineSelection(
        mask.mask, strokes: [], protection: protection)
      let excluded = try RemovalBridge.combineMasks(mask.mask, selected, subtract: true)
      if !excluded.isEmpty {
        let keepers = try people.filter(\.keep).compactMap { kept -> Int? in
          guard let keptMask = masks.first(where: { $0.id == kept.id }) else {
            throw RemovalError.invalid("Missing kept person selection")
          }
          return try overlaps(excluded, keptMask.mask) ? kept.id : nil
        }
        conflicts.append(
          RemovalPersonProtectionConflict(
            id: person.id, keptPersonIDs: keepers,
            manualProtection: try overlaps(excluded, manualProtection),
            fullyProtected: selected.isEmpty))
      }
      return selected.isEmpty ? nil : RemovalPersonSelection(id: person.id, mask: selected)
    }
    let selection = try bases.reduce(Data()) { try RemovalBridge.combineMasks($0, $1.mask) }
    return (selection, protection, bases, conflicts)
  }

  private func overlaps(_ first: Data, _ second: Data) throws -> Bool {
    guard !first.isEmpty, !second.isEmpty else { return false }
    let outside = try RemovalBridge.combineMasks(first, second, subtract: true)
    return try !RemovalBridge.combineMasks(first, outside, subtract: true).isEmpty
  }

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
  public func beginPersonRefinement(_ id: Int) async {
    guard phase == .ready, mode == .people, people.contains(where: { $0.id == id && !$0.keep })
    else { return }
    if personChoicesNeedApply {
      let token = revision &+ 1
      await selectOtherPeople()
      guard current(token), phase == .ready, !personChoicesNeedApply else { return }
    }
    refinePerson(id)
  }

  public func refinePerson(_ id: Int?) {
    guard phase == .ready else { return }
    guard id == nil || personBases.contains(where: { $0.id == id }) else { return }
    refiningPersonID = id
  }

  func resetPersonRefinement(_ bases: [RemovalPersonSelection] = []) {
    personProtectionConflicts = []
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
