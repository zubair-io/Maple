// EditSession+SessionPruning.swift — pure "prune to a keep-set" primitive
// shared by every place `AppShell` (app target) needs to bound its
// per-asset `EditSession` cache.
//
// `AppShell` keeps one `EditSession` per opened/primed asset in a
// `[AssetRef.ID: EditSession]` dictionary that is otherwise append-only:
// `loadFolder` pre-creates a session for every asset in a loaded folder,
// and `ensureSession(for:)` primes one for every grid cell scrolled into
// view. Neither ever prunes, so re-browsing a folder or navigating between
// folders/libraries only ever adds entries — each idle `EditSession` owns
// its own Metal-backed CIContext, RenderActor, NativeDetailRenderer, and
// XMPSidecarStore, so this grows memory without bound (#2038).
//
// `AppShell` has two call sites that need this: the existing editor-open
// prune (keep only the actively-open asset) and the folder/library-
// navigation prune (keep only the newly-current asset list, plus the
// actively-open editor asset if any). Both reduce to "here is the set of
// asset ids that must stay resident" — this function does the actual
// eviction so neither caller duplicates the filter.

/// Filter `sessions` down to only the entries whose asset id is in
/// `keepIDs`. Reassigning a `@State` sessions dictionary to the result
/// drops the last strong reference to every evicted `EditSession`;
/// `EditSession.deinit` cancels its outstanding tasks, so there is no
/// separate teardown call to make here — dropping the reference IS the
/// teardown.
public func prunedSessions(
    _ sessions: [AssetRef.ID: EditSession],
    keeping keepIDs: Set<AssetRef.ID>
) -> [AssetRef.ID: EditSession] {
    sessions.filter { keepIDs.contains($0.key) }
}
