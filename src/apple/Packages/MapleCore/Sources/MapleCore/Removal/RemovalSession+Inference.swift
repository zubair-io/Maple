import Foundation

extension RemovalSession {
  public func findPeople() async {
    guard phase == .ready, mode == .people, let context else { return }
    revision &+= 1
    let token = revision
    phase = .selecting
    message = ""
    do {
      let run = try await engine.detectionOperation()
      guard current(token) else {
        run.cancel()
        return
      }
      operation = run
      let detected = try await engine.detect(context: context, operation: run)
      guard current(token) else { return }
      let suggestions = try RemovalBridge.peopleSuggestions(
        detected, width: context.width, height: context.height)
      let suggestedPeople = suggestions.enumerated().map {
        Person(
          id: $0.offset + 1, detection: $0.element.detection,
          keep: $0.element.keep, role: $0.element.role)
      }
      let masks = try await masksForPeople(suggestedPeople, context: context, token: token)
      guard current(token) else { return }
      people = suggestedPeople
      selection = masks.selection
      protection = masks.protection
      personMasks = masks.people
      operation = nil
      phase = .ready
      message = people.isEmpty ? "No people found. Paint the object instead." : peopleMessage
    } catch { fail(error, token: token) }
  }

  public func keepPerson(_ id: Int) {
    guard phase == .ready else { return }
    clearSelection()
    people = people.map {
      Person(
        id: $0.id, detection: $0.detection, keep: $0.id == id ? !$0.keep : $0.keep,
        role: $0.role)
    }
  }

  public func selectOtherPeople() async {
    guard phase == .ready, mode == .people, let context, !people.isEmpty else { return }
    revision &+= 1
    let token = revision
    phase = .selecting
    message = ""
    do {
      let masks = try await masksForPeople(people, context: context, token: token)
      guard current(token) else { return }
      selection = masks.selection
      protection = masks.protection
      personMasks = masks.people
      operation = nil
      phase = .ready
      message = peopleMessage
    } catch { fail(error, token: token) }
  }

  private var peopleMessage: String {
    selection.isEmpty
      ? "No background people selected. Review Keep/Remove choices or use Paint."
      : "Review suggested background people and kept subjects before removing."
  }

  private func masksForPeople(
    _ people: [Person], context: NativeRemovalEditorContext,
    token: UInt64
  ) async throws -> (selection: Data, protection: Data, people: [Data]) {
    guard !people.isEmpty else { return (Data(), manualProtection, []) }
    let run = try await engine.selectionOperation()
    guard current(token) else {
      run.cancel()
      throw CancellationError()
    }
    operation = run
    var selected = Data()
    var protected = manualProtection
    var masks: [Data] = []
    for person in people {
      let mask = try await engine.personMask(person.detection, context: context, operation: run)
      guard current(token) else { throw CancellationError() }
      if person.keep {
        protected = try RemovalBridge.combineMasks(protected, mask)
      } else {
        masks.append(mask)
        selected = try RemovalBridge.combineMasks(selected, mask)
      }
    }
    let selection = try RemovalBridge.combineMasks(selected, protected, subtract: true)
    let individual = try masks.map {
      try RemovalBridge.combineMasks($0, protected, subtract: true)
    }.filter { !$0.isEmpty }
    return (selection, protected, individual)
  }

  public func remove() async {
    guard canRemove, let context, let snapshot else { return }
    revision &+= 1
    let token = revision
    phase = .generating
    message = "Reconstructing selected pixels…"
    do {
      let masks = mode == .people ? personMasks : [selection]
      guard !masks.isEmpty else { throw RemovalError.invalid("Select the people to remove first") }
      var candidate = context
      var generated: [NativeRemovalProposal] = []
      for (index, mask) in masks.enumerated() {
        let next = try await engine.authoringJob()
        guard current(token) else {
          next.cancel()
          return
        }
        job = next
        message = "Reconstructing object \(index + 1) of \(masks.count)…"
        let proposal = try await next.propose(
          handle: candidate.handle, saved: candidate.saved, xmp: candidate.xmp,
          intent: mask, protected: protection,
          holeRadius: ExperimentalRemovalModels.holeRadius,
          fringeRadius: ExperimentalRemovalModels.fringeRadius)
        guard current(token) else { return }
        candidate = try await engine.appending(proposal, to: candidate)
        guard current(token) else { return }
        generated.append(proposal)
      }
      guard session.model == snapshot.model, session.editRevision == snapshot.editRevision else {
        throw RemovalError.saveConflict
      }
      let image = try await engine.review(candidate)
      guard current(token) else { return }
      guard session.model == snapshot.model, session.editRevision == snapshot.editRevision else {
        throw RemovalError.saveConflict
      }
      proposals = generated
      preview = image
      compare = false
      job = nil
      phase = .review
      message = "Review the reconstruction before keeping it."
    } catch { fail(error, token: token) }
  }

  public func keep() async {
    guard phase == .review, !proposals.isEmpty, let snapshot else { return }
    let token = revision
    phase = .saving
    do {
      try await session.acceptRemovals(proposals, snapshot: snapshot)
      // A closed editor still finishes its owned durable save.
      guard current(token) else { return }
      proposals = []
      preview = nil
      compare = false
      phase = .ready
      await open()
      if active, phase == .ready { message = "Removal saved." }
    } catch { fail(error, token: token, phase: .review) }
  }
}
