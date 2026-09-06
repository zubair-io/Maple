import Foundation
import Observation

/// One histogram request/result for the currently presented editor frame.
/// The pill and inspector share it; a newer frame cancels obsolete work.
@MainActor
@Observable
public final class LiveHistogramState {
  public private(set) var revision: UInt64 = 0
  @ObservationIgnored private var computation: Task<CloudHistogram?, Error>?

  public init() {}

  func framePresented() {
    revision &+= 1
    computation?.cancel()
    computation = nil
  }

  func read(
    _ compute: @escaping @MainActor () async throws -> CloudHistogram?
  ) async throws -> CloudHistogram? {
    try Task.checkCancellation()
    let requestedRevision = revision
    let task: Task<CloudHistogram?, Error>
    if let computation {
      task = computation
    } else {
      task = Task {
        try Task.checkCancellation()
        let result = try await compute()
        try Task.checkCancellation()
        return result
      }
      computation = task
    }
    do {
      let result = try await task.value
      try Task.checkCancellation()
      guard revision == requestedRevision else { throw CancellationError() }
      return result
    } catch {
      // One disappearing view must not discard the other view's shared work.
      if revision == requestedRevision, !Task.isCancelled { computation = nil }
      throw error
    }
  }

  deinit { computation?.cancel() }
}
