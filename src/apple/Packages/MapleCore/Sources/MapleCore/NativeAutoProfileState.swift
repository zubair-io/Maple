// #1472: per-editor immutable artifacts. The job does not retain EditSession;
// source staging stays alive until the joined FFI has actually returned.
import Foundation

@MainActor
final class NativeAutoProfileState {
  private var task: Task<Void, Never>?
  private var revision: UInt64 = 0
  private var request: (quality: Int32, decodeGeneration: UInt64)?
  private(set) var ready: NativeAutoProfile?

  func prepared(
    asset: AssetRef, source: RawRenderSource, quality: PipelineRenderer.Quality,
    decodeGeneration: UInt64, onReady: @escaping @MainActor () -> Void
  ) -> NativeAutoProfile? {
    if let request, request.quality == quality.rawValue,
      request.decodeGeneration == decodeGeneration
    {
      return ready
    }
    task?.cancel()
    revision &+= 1
    let expected = revision
    request = (quality.rawValue, decodeGeneration)
    ready = nil
    task = Task { [weak self, source] in
      do {
        let url = try await source.url(for: asset)
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let result = try await NativeAutoProfilePreparation.shared.prepare(
          url: url, scope: scope, quality: quality)
        guard !Task.isCancelled, let self, self.revision == expected else { return }
        self.ready = result
        self.task = nil
        onReady()
      } catch {
        guard !Task.isCancelled, let self, self.revision == expected else { return }
        self.task = nil
        editSessionLogger.error("Native Auto preparation failed; retaining provisional preview")
        // Keep the already-working proxy frame. Retry on a new decode/source
        // request, never a loop on every slider tick or a fake absent result.
      }
    }
    return nil
  }

  var hasRequested: Bool { request != nil }

  func readyFor(decodeGeneration: UInt64, quality: PipelineRenderer.Quality) -> NativeAutoProfile? {
    guard let request, request.decodeGeneration == decodeGeneration,
      request.quality == quality.rawValue
    else { return nil }
    return ready
  }

  func awaitPreparation() async { await task?.value }

  func cancelAndWait() async {
    let old = task
    revision &+= 1
    task = nil
    request = nil
    ready = nil
    old?.cancel()
    await old?.value
    await NativeAutoProfilePreparation.shared.clearReady()
  }

  deinit { task?.cancel() }
}
