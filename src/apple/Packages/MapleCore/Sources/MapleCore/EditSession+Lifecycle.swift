// EditSession+Lifecycle.swift — public editor-lifecycle helpers split out of
// EditSession.swift for the file-size budget (#2009). Keyword editing +
// pending-sidecar flush; both are teardown/metadata operations with no pixel
// impact, kept off the core type declaration.

import Foundation

@MainActor
extension EditSession {
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
    public func flushPendingSidecarWrite() async {
        guard let store = sidecarStore else { return }
        if let xmp = store as? XMPSidecarStore {
            await xmp.flush()
        } else if let photoKit = store as? PhotoKitSidecarStore {
            // Local disk I/O, same shape as XMPSidecarStore (#2555) — force
            // it now rather than leaving it to the 750ms debounce. Without
            // this, backgrounding (or force-quitting) the app right after an
            // edit could kill the process before the debounced write fires,
            // silently dropping the edit the durability fix exists to keep.
            await photoKit.flush()
        } else if let cloud = store as? CloudSidecarStore {
            // `CloudSidecarStore.flush()` cancels the pending debounce Task
            // and issues the PUT immediately — the same "force it now" shape
            // as the other two stores, not merely waiting on an inflight
            // request. Backgrounding right after an edit can kill the process
            // before the 750ms debounce fires here too.
            await cloud.flush()
        }
    }
}
