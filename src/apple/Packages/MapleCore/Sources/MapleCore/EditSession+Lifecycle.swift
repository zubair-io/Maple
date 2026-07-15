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
        }
        // Other SidecarStoreProtocol conformers (CloudSidecarStore) have
        // their own flush semantics — they coalesce per-request and
        // there's no synchronous "force now" call. Their inflight POST
        // either lands or doesn't on the next request cycle.
    }
}
