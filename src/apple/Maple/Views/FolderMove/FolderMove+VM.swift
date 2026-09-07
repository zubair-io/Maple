// FolderMove+VM.swift — the state machine behind "Move Folder to…" (#2847
// follow-up from the PR #3429 review).
//
// Building the destination tree is not instant: `FolderMoveDestinations
// .localTree` walks every directory under the saved root, and
// `SMBSource.folderTree` walks a whole share over the network, one round
// trip per directory. The first wiring built the tree and only THEN showed
// the picker, so on a large share the context-menu click looked ignored —
// no feedback, and a second click queued a second walk. This view-model
// publishes a `preparing` phase the instant the user asks (the overlay
// shows a spinner sheet on it), refuses a second `begin` while one is in
// flight, and drops a walk's result if the user cancelled while it ran.
//
// Pattern (issue #192): the `+VM.swift` sibling MUST NOT `import SwiftUI`
// so every branch here is unit-testable from `MapleTests/FolderMoveVMTests`
// with an injected loader — no filesystem, no SMB.

import Foundation
import MapleCore
import Observation

@MainActor
@Observable
final class FolderMoveVM {
  /// Produces the destination tree for the target being moved. Runs on the
  /// main actor; the shell's loaders hop off it themselves for the walk.
  typealias Loader = @MainActor () async throws -> [FolderMoveDestination]

  enum Phase {
    case idle
    /// The tree is being built; the overlay shows the spinner sheet.
    case preparing(FolderMovePrompt.Target)
    /// The tree is ready; the overlay shows the Move To modal.
    case ready(FolderMovePrompt)
  }

  private(set) var phase: Phase = .idle
  private var preparation: Task<Void, Never>?

  var isPreparing: Bool {
    if case .preparing = phase { return true }
    return false
  }

  var prompt: FolderMovePrompt? {
    if case .ready(let prompt) = phase { return prompt }
    return nil
  }

  /// Start building the tree for `target`. Ignored (returns `false`) while
  /// a walk is already running or a picker is already up — the double-tap
  /// guard. `onFailure` receives the loader's error after the sheet has
  /// gone back to idle; a cancelled walk reports nothing.
  @discardableResult
  func begin(
    _ target: FolderMovePrompt.Target,
    load: @escaping Loader,
    onFailure: @escaping @MainActor (Error) -> Void = { _ in }
  ) -> Bool {
    guard case .idle = phase else { return false }
    phase = .preparing(target)
    preparation = Task { [weak self] in
      let outcome: Result<[FolderMoveDestination], Error>
      do {
        outcome = .success(try await load())
      } catch {
        outcome = .failure(error)
      }
      // `cancel()` already reset the phase; a late result must not
      // resurrect a picker the user dismissed.
      guard let self, !Task.isCancelled else { return }
      self.preparation = nil
      switch outcome {
      case .success(let nodes):
        self.phase = .ready(FolderMovePrompt(target: target, nodes: nodes))
      case .failure(let error):
        self.phase = .idle
        onFailure(error)
      }
    }
    return true
  }

  /// The user dismissed the spinner sheet or the picker: stop any walk in
  /// flight and go back to idle. Safe to call in any phase.
  func cancel() {
    preparation?.cancel()
    preparation = nil
    phase = .idle
  }

  /// The picker's "Move": hand back the ready prompt and close. `nil` when
  /// no picker was up.
  func finish() -> FolderMovePrompt? {
    guard let prompt else { return nil }
    phase = .idle
    return prompt
  }
}
