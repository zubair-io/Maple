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
      personChoicesNeedApply = false
      selection = masks.selection
      protection = masks.protection
      personMasks = masks.people
      resetPersonRefinement(masks.bases)
      operation = nil
      phase = .ready
      message = people.isEmpty ? "No people found. Paint the object instead." : peopleMessage
    } catch { fail(error, token: token) }
  }

  public func keepPerson(_ id: Int) {
    guard phase == .ready, people.contains(where: { $0.id == id }) else { return }
    clearSelection()
    people = people.map {
      Person(
        id: $0.id, detection: $0.detection, keep: $0.id == id ? !$0.keep : $0.keep,
        role: $0.role)
    }
    personChoicesNeedApply = true
    message = "Choices changed. Click Apply person choices to update the red removal selection."
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
      resetPersonRefinement(masks.bases)
      personChoicesNeedApply = false
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
  ) async throws -> (
    selection: Data, protection: Data, people: [Data], bases: [RemovalPersonSelection]
  ) {
    guard !people.isEmpty else { return (Data(), manualProtection, [], []) }
    let run = try await engine.selectionOperation()
    guard current(token) else {
      run.cancel()
      throw CancellationError()
    }
    operation = run
    var selected = Data()
    var protected = manualProtection
    var masks: [RemovalPersonSelection] = []
    for person in people {
      let mask = try await engine.personMask(person.detection, context: context, operation: run)
      guard current(token) else { throw CancellationError() }
      if person.keep {
        protected = try RemovalBridge.combineMasks(protected, mask)
      } else {
        masks.append(RemovalPersonSelection(id: person.id, mask: mask))
        selected = try RemovalBridge.combineMasks(selected, mask)
      }
    }
    let selection = try RemovalBridge.combineMasks(selected, protected, subtract: true)
    let bases = try masks.map {
      RemovalPersonSelection(
        id: $0.id, mask: try RemovalBridge.combineMasks($0.mask, protected, subtract: true))
    }.filter { !$0.mask.isEmpty }
    return (selection, protected, bases.map(\.mask), bases)
  }

  public func remove() async {
    guard phase == .ready else { return }
    guard !personChoicesNeedApply else {
      message =
        "Click Apply person choices before removing. Green people are kept; red people are removed."
      return
    }
    guard !selection.isEmpty else {
      message =
        mode == .people
        ? "No people selected for removal. Change unwanted people to Remove, then Apply person choices."
        : "Paint over the object to select it before removing."
      return
    }
    guard modelFolderName != nil else {
      message = "Import local AI models before removing."
      return
    }
    guard let context, let snapshot else {
      message = "The photo is not ready for removal. Retry loading the photo."
      phase = .failed
      return
    }
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
      let reviewed: NativeRemovalEditorContext
      if let id = replacingRemovalID, let original = replacementOriginal {
        reviewed = try await engine.replacementReview(
          id: id, original: original, candidate: candidate)
      } else {
        reviewed = candidate
      }
      let image = try await engine.review(reviewed)
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
      try await session.acceptRemovals(proposals, snapshot: snapshot, replacing: replacingRemovalID)
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
