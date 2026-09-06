// EditSession+Lifecycle.swift — public editor-lifecycle helpers split out of
// EditSession.swift for the file-size budget (#2009). Keyword editing +
// pending-sidecar flush; both are teardown/metadata operations with no pixel
// impact, kept off the core type declaration.

import Foundation

@MainActor
extension EditSession {
  /// Keep the existing asynchronous updates ordered without waiting on the UI
  /// path. The tail also gives exit a real completion barrier, instead of
  /// hoping an unstructured update reaches the store before `flush()`.
  func scheduleSidecarUpdate(model: AdjustmentModel, culling: CullingState) {
    guard let store = sidecarStore else { return }
    let previous = sidecarUpdateTask
    sidecarUpdateTask = Task {
      await previous?.value
      await store.update(model: model, culling: culling)
    }
  }

  /// Replace the IPTC keyword list (#632). Routes through `culling`'s
  /// `didSet` which schedules the same 750ms-debounced XMP write the
  /// rating/flag mutators use — keywords have zero pixel impact so the
  /// render path is intentionally not kicked. Duplicates are removed
  /// preserving first-occurrence order (`Set` would lose order); blank
  /// entries are dropped since `dc:subject` rejects empty `rdf:li`
  /// content on the read path.
  public func setKeywords(_ keywords: [String]) {
    var seen: Set<String> = []
    var deduped: [String] = []
    for raw in keywords {
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
      seen.insert(trimmed)
      deduped.append(trimmed)
    }
    guard culling.keywords != deduped else { return }
    culling.keywords = deduped
  }

  /// Force an immediate flush of any pending sidecar write. Call before
  /// tearing the editor down so an undo-then-leave sequence persists
  /// the right value (spec § S5 risk #4b). No-op when there's no store
  /// (e.g. preview session, in-memory test).
  ///
  /// Routes through the protocol's `flush()` requirement directly rather
  /// than an `as?` typecast chain over the concrete store types — every
  /// conformer (`XMPSidecarStore`, `PhotoKitSidecarStore`,
  /// `CloudSidecarStore`, `SMBSidecarStore`) implements `flush()` with the
  /// identical "cancel the pending debounce Task, then force the write
  /// now" shape, so there is nothing per-type left to special-case. A
  /// typecast chain silently no-ops for any store type it doesn't
  /// enumerate — which is exactly how `SMBSidecarStore` fell through here
  /// (#2674 review): an edit made within the 750ms debounce window right
  /// before leaving the editor was dropped for SMB sessions because this
  /// method never reached the store at all. Reviewed in #2556 for the
  /// same reason.
  public func flushPendingSidecarWrite() async {
    // A flush is a commit boundary (#2432): close the open transaction
    // so the sidecar describes a recorded action, not a half-gesture.
    endEdit()
    guard let store = sidecarStore else { return }
    await sidecarUpdateTask?.value
    await store.flush()
  }
}
