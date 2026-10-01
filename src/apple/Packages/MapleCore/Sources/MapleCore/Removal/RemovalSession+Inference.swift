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
      // All person proposals remain reviewable; the detector does not assign
      // foreground/background roles (#3942).
      people = detected.filter {
        $0.class == 0 && $0.score >= ExperimentalRemovalModels.personMinScore
      }
      .sorted { $0.score > $1.score }.enumerated().map {
        Person(id: $0.offset + 1, detection: $0.element, keep: false)
      }
      message =
        people.isEmpty
        ? "No people found. Paint the object instead."
        : "Choose who to keep, then select the other people."
      operation = nil
      phase = .ready
    } catch { fail(error, token: token) }
  }

  public func keepPerson(_ id: Int) {
    guard phase == .ready else { return }
    clearSelection()
    people = people.map {
      Person(id: $0.id, detection: $0.detection, keep: $0.id == id ? !$0.keep : $0.keep)
    }
  }

  public func selectOtherPeople() async {
    guard phase == .ready, mode == .people, let context, !people.isEmpty else { return }
    revision &+= 1
    let token = revision
    phase = .selecting
    message = ""
    do {
      let run = try await engine.selectionOperation()
      guard current(token) else {
        run.cancel()
        return
      }
      operation = run
      var selected = Data()
      var protected = manualProtection
      for person in people {
        let mask = try await engine.personMask(person.detection, context: context, operation: run)
        guard current(token) else { return }
        if person.keep {
          protected = try RemovalBridge.combineMasks(protected, mask)
        } else {
          selected = try RemovalBridge.combineMasks(selected, mask)
        }
      }
      selection = try RemovalBridge.combineMasks(selected, protected, subtract: true)
      protection = protected
      operation = nil
      phase = .ready
      message =
        selection.isEmpty ? "No removable people remain." : "Review the selection before removing."
    } catch { fail(error, token: token) }
  }

  public func remove() async {
    guard canRemove, let context, let snapshot else { return }
    revision &+= 1
    let token = revision
    phase = .generating
    message = "Reconstructing selected pixels…"
    do {
      let next = try await engine.authoringJob()
      guard current(token) else {
        next.cancel()
        return
      }
      job = next
      let generated = try await next.propose(
        handle: context.handle, saved: context.saved, xmp: context.xmp,
        intent: selection, protected: protection,
        holeRadius: ExperimentalRemovalModels.holeRadius,
        fringeRadius: ExperimentalRemovalModels.fringeRadius)
      guard current(token) else { return }
      guard session.model == snapshot.model, session.editRevision == snapshot.editRevision else {
        throw RemovalError.saveConflict
      }
      let image = try await engine.review(generated, context: context)
      guard current(token) else { return }
      guard session.model == snapshot.model, session.editRevision == snapshot.editRevision else {
        throw RemovalError.saveConflict
      }
      proposal = generated
      preview = image
      compare = false
      job = nil
      phase = .review
      message = "Review the reconstruction before keeping it."
    } catch { fail(error, token: token) }
  }

  public func keep() async {
    guard phase == .review, let proposal, let snapshot else { return }
    let token = revision
    phase = .saving
    do {
      try await session.acceptRemoval(proposal, snapshot: snapshot)
      // A closed editor still finishes its owned durable save.
      guard current(token) else { return }
      self.proposal = nil
      preview = nil
      compare = false
      phase = .ready
      await open()
      if active, phase == .ready { message = "Removal saved." }
    } catch { fail(error, token: token, phase: .review) }
  }
}
