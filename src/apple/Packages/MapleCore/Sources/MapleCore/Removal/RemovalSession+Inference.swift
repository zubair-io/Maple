import Foundation

extension RemovalSession {
  public func findPeople() async {
    guard phase == .ready, mode == .people, let context else { return }
    guard modelFolderName != nil else {
      if message.isEmpty {
        message = "Import local AI models to detect background people automatically."
      }
      return
    }
    revision &+= 1
    let token = revision
    phase = .selecting
    message = "Finding people…"
    detectedPersonMasks = []
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
      let discovered = try await masksForPeople(suggestedPeople, context: context, token: token)
      guard current(token) else { return }
      let reviewedPeople = try await engine.peopleMaskSuggestions(
        suggestedPeople, masks: discovered.detected, width: context.width, height: context.height)
      guard current(token) else { return }
      let masks = try await engine.peopleSelection(
        reviewedPeople, masks: discovered.detected, manualProtection: manualProtection)
      guard current(token) else { return }
      people = reviewedPeople
      personChoicesNeedApply = false
      selection = masks.selection
      protection = masks.protection
      personMasks = masks.bases.map(\.mask)
      detectedPersonMasks = discovered.detected
      resetPersonRefinement(masks.bases)
      personProtectionConflicts = masks.conflicts
      operation = nil
      phase = .ready
      message = people.isEmpty ? "No people found. Paint the object instead." : peopleMessage
    } catch { fail(error, token: token, phase: .failed) }
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
    message =
      people.contains { !$0.keep }
      ? "Selected people will be removed. Click Remove when the list is ready."
      : "No people selected for removal. Select people in the list."
  }

  func selectOtherPeople() async {
    guard phase == .ready, mode == .people, let context, !people.isEmpty else { return }
    revision &+= 1
    let token = revision
    phase = .selecting
    message = "Preparing selected people…"
    do {
      let masks = try await masksForPeople(people, context: context, token: token)
      guard current(token) else { return }
      selection = masks.selection
      protection = masks.protection
      personMasks = masks.people
      detectedPersonMasks = masks.detected
      resetPersonRefinement(masks.bases)
      personProtectionConflicts = masks.conflicts
      personChoicesNeedApply = false
      operation = nil
      phase = .ready
      message = peopleMessage
    } catch { fail(error, token: token) }
  }

  private var peopleMessage: String {
    requiresProtectionReview
      ? protectionReviewMessage
      : selection.isEmpty
        ? "No background people selected. Review Keep/Remove choices or use Paint."
        : "Review suggested background people and kept subjects before removing."
  }

  private var protectionReviewMessage: String {
    "Selected people overlap protection. Review the named kept people, refine the selection, or remove only unprotected parts."
  }

  private func masksForPeople(
    _ people: [Person], context: NativeRemovalEditorContext,
    token: UInt64
  ) async throws -> (
    selection: Data, protection: Data, people: [Data], bases: [RemovalPersonSelection],
    detected: [RemovalPersonSelection], conflicts: [RemovalPersonProtectionConflict]
  ) {
    guard !people.isEmpty else { return (Data(), manualProtection, [], [], [], []) }
    if detectedPersonMasks.count == people.count,
      Set(detectedPersonMasks.map(\.id)) == Set(people.map(\.id))
    {
      let masks = try await engine.peopleSelection(
        people, masks: detectedPersonMasks, manualProtection: manualProtection)
      return (
        masks.selection, masks.protection, masks.bases.map(\.mask), masks.bases,
        detectedPersonMasks,
        masks.conflicts
      )
    }
    let run = try await engine.selectionOperation()
    guard current(token) else {
      run.cancel()
      throw CancellationError()
    }
    operation = run
    var detected: [RemovalPersonSelection] = []
    for person in people {
      let mask = try await engine.personMask(person.detection, context: context, operation: run)
      guard current(token) else { throw CancellationError() }
      detected.append(RemovalPersonSelection(id: person.id, mask: mask))
    }
    let masks = try await engine.peopleSelection(
      people, masks: detected, manualProtection: manualProtection)
    return (
      masks.selection, masks.protection, masks.bases.map(\.mask), masks.bases, detected,
      masks.conflicts
    )
  }

  public func remove() async {
    guard phase == .ready else { return }
    if mode == .people, personChoicesNeedApply {
      guard people.contains(where: { !$0.keep }) else {
        message = "No people selected for removal. Select people in the list."
        return
      }
      let preparationToken = revision &+ 1
      await selectOtherPeople()
      guard current(preparationToken), phase == .ready, !personChoicesNeedApply else { return }
    }
    guard !requiresProtectionReview else {
      message = protectionReviewMessage
      return
    }
    await generateSelection()
  }

  /// Explicit partial-removal choice after inspecting actual protected overlap.
  /// List changes invalidate this choice and must be prepared by Remove again.
  public func removeUnprotectedParts() async {
    guard phase == .ready, requiresProtectionReview, canRemove else { return }
    await generateSelection()
  }

  private func generateSelection() async {
    guard !selection.isEmpty else {
      message =
        mode == .people
        ? "No people selected for removal. Select people in the list or use Paint."
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
      let masks: [Data]
      switch mode {
      case .people: masks = personMasks
      case .paint: masks = try await engine.paintIntents(selection, context: context)
      case .smart: masks = [selection]
      }
      guard current(token) else { return }
      guard replacingRemovalID == nil || masks.count == 1 else {
        throw RemovalError.invalid(
          "Replace a saved removal within one native context. Clear distant paint or cancel replacement and create a new removal."
        )
      }
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
