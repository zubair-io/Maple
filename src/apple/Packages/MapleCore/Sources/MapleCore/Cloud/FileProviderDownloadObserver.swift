// FileProviderDownloadObserver.swift — observes byte-progress when iOS/macOS
// materializes a FileProvider-backed asset (e.g. MAPLE.LAWRENCE.IO files
// opened from the Files-app sidebar).
//
// The cloud-search path drives `DownloadProgress` directly through
// `CloudByteDownloadBox` — the bytes come over HTTP via our own URLSession,
// so we see every chunk. FileProvider opens are different: the user picks a
// file via `.fileImporter`, the FileProvider extension lazy-materializes it
// somewhere outside our process, and `Data(contentsOf:)` silently blocks
// inside the materialization. There's no callback, no delegate, just a
// multi-second pause that the user reads as "frozen editor."
//
// This observer fills that gap. On `start(url:progress:)` it asks the
// FileProvider framework whether the URL maps to a known item; if so it
// triggers the system download (via `NSFileProviderManager.requestDownloadFor
// Item`) and observes real byte progress via `NSFileProviderManager
// .globalProgress(for:)` (#1385) — bridging `completedUnitCount`/
// `totalUnitCount` into `DownloadProgress.report(received:total:)` so the
// editor's existing overlay shows received/total/speed exactly like the
// cloud-search path. See that method's doc comment below for why it's used
// instead of the URL-resource polling this replaces.
//
// For local files (non-FileProvider URLs) detection silently no-ops — the
// editor's overlay stays hidden, and the synchronous `Data(contentsOf:)`
// path inside `FilesystemSource.rawBytes` proceeds unchanged.

import Foundation
#if canImport(FileProvider)
import FileProvider
#endif

/// Drives `DownloadProgress` while iOS/macOS materializes a FileProvider-
/// backed file. No-op for local files.
///
/// `stop()` cancels the KVO observation (or the polling fallback) and flips
/// the bound `DownloadProgress` to `finish()`, so the editor's overlay
/// dismisses immediately. It does NOT abort the underlying
/// `NSFileProviderManager.requestDownloadForItem` — the Swift refined API
/// returns void, so there's no handle to cancel. The system download
/// continues in the background until the FileProvider extension completes
/// it.
@MainActor
public final class FileProviderDownloadObserver {
    /// Background poll loop (URL-resource fallback only — see `start`).
    /// Kept around so `stop()` can cancel it via `Task.cancel()` — that
    /// propagates into the loop as `Task.isCancelled`.
    private var pollTask: Task<Void, Never>?
    /// KVO token for the `NSFileProviderManager.globalProgress(for:)` path
    /// (#1385) — the preferred path whenever a domain-specific manager is
    /// available. Invalidated by deallocation or an explicit `stop()`.
    private var progressObservation: NSKeyValueObservation?
    /// The observed `NSProgress` itself (jules review, PR #3185): its own
    /// doc comment requires it to be "retained by the caller" — without a
    /// strong reference here, the local `global` binding inside
    /// `observeGlobalProgress` would deallocate the instant that method
    /// returns, silently killing KVO delivery even though
    /// `progressObservation` (the observation TOKEN, not the observed
    /// object) is still alive. Cleared alongside `progressObservation` in
    /// `stop()`.
    private var globalProgress: Progress?
    /// Weak reference to the sink so `stop()` can call `finish()` without
    /// keeping the progress alive past the editor session.
    private weak var progressSink: DownloadProgress?
    /// Last known expected byte count, updated as either observation path
    /// learns more (the KVO path's `totalUnitCount` starts at `-1`
    /// — "unknown" — until the FileProvider extension reports a real size).
    private var lastExpectedBytes: Int64?

    public init() {}

    /// Begin observing `url`. If `url` is not FileProvider-backed (local
    /// file, picker-returned scope URL pointing at a regular folder, etc.)
    /// this returns silently — no progress is reported and the editor's
    /// overlay stays hidden. Errors from the FileProvider APIs are
    /// swallowed; the file still gets read via `Data(contentsOf:)`, which
    /// blocks on materialization regardless of our observation.
    public func start(url: URL, progress: DownloadProgress) async {
        #if canImport(FileProvider)
        guard #available(macOS 13.0, iOS 16.0, *) else { return }

        // (1) Map URL → item + domain identifier. Throws for non-FileProvider
        // URLs (the dominant case for local-folder picks).
        let identifier: (itemID: NSFileProviderItemIdentifier, domainID: NSFileProviderDomainIdentifier?)
        do {
            identifier = try await Self.identifierForUserVisibleFile(at: url)
        } catch {
            return
        }

        // (2) Best-effort expected size from URL resource values. Falls back
        // to nil when unknown; `DownloadProgress.begin(expectedBytes: nil)`
        // renders the bar indeterminate until an observation path learns more.
        let initialExpected = Self.fileSize(of: url)
        lastExpectedBytes = initialExpected
        progress.begin(expectedBytes: initialExpected)
        self.progressSink = progress

        // (3) Resolve the domain so we can build a per-domain manager. A nil
        // domainID corresponds to the system's default domain — we leave the
        // manager as `nil` in that case and fall back to URL-driven polling,
        // which still works (just without continuous KVO updates).
        let manager: NSFileProviderManager?
        if let domainID = identifier.domainID {
            manager = await Self.manager(for: domainID)
        } else {
            manager = nil
        }

        // (4) Kick the download. The Swift refined API returns void; progress
        // is observed separately below (KVO when possible, polling otherwise).
        // Errors here are benign — the file will still materialize when
        // `Data(contentsOf:)` touches it; we just won't get progress feedback.
        if let manager {
            Task.detached {
                try? await manager.requestDownloadForItem(
                    withIdentifier: identifier.itemID,
                    requestedRange: nil
                )
            }
        }

        // (5) Observe progress. `NSFileProviderManager.globalProgress(for:)`
        // (macOS 11.3+ / iOS 16+, both already covered by this method's own
        // `#available` guard) exposes a real NSProgress for every in-flight
        // operation of a kind on this domain — "retained by the caller and
        // to be observed through KVO" per its own doc comment. It replaces
        // the 200 ms URL-resource poll loop this ticket exists to remove:
        // that loop could only see bytes AFTER the FileProvider extension
        // had already written them to disk, which on a single-jump
        // materialization strategy (allocate-then-fill, not stream-as-you-
        // go) meant the bar sat at 0/total for the whole wait and then
        // jumped straight to total/total.
        //
        // `globalProgress` is DOMAIN-global, not per-item — the doc comment
        // is explicit that concurrent operations of the same kind sum into
        // one total. That's an acceptable trade here: this observer only
        // ever has one FileProvider download in flight per editor session
        // (one sidebar-opened file), so in practice the global figure IS
        // this file's figure. A domain-specific `manager` is required to
        // call it at all, so the nil-`manager` branch (no resolvable
        // domain — the pre-existing degraded case) keeps the polling
        // fallback, unchanged from before this fix.
        if let manager {
            observeGlobalProgress(manager: manager)
        } else {
            startPolling(url: url, progress: progress)
        }
        #else
        _ = url
        _ = progress
        #endif
    }

    /// Cancel any active observation (KVO or polling) and finish the bound
    /// progress so the editor's overlay dismisses. Does NOT cancel the
    /// underlying FileProvider download — see the class header. Safe to
    /// call multiple times.
    public func stop() {
        pollTask?.cancel()
        pollTask = nil
        progressObservation?.invalidate()
        progressObservation = nil
        globalProgress = nil
        progressSink?.finish()
        progressSink = nil
    }

    deinit {
        // Best-effort cancellation — `stop()` is the documented teardown.
        pollTask?.cancel()
        progressObservation?.invalidate()
    }

    // MARK: - KVO progress path (#1385)

    #if canImport(FileProvider)
    @available(macOS 13.0, iOS 16.0, *)
    private func observeGlobalProgress(manager: NSFileProviderManager) {
        let global = manager.globalProgress(for: .downloading)
        // Retain the observed NSProgress itself, not just the observation
        // token — its own doc comment requires this ("retained by the
        // caller"); without it `global` would deallocate the instant this
        // method returns, silently killing KVO delivery (jules review,
        // PR #3185).
        globalProgress = global
        // `.initial` fires the handler once synchronously with the CURRENT
        // values, so a download that's already partway in by the time we
        // start observing (another tab/window kicked it earlier) doesn't
        // sit unreported until the next real change.
        progressObservation = global.observe(\.fractionCompleted, options: [.initial, .new]) {
            [weak self] observed, _ in
            guard let self else { return }
            // NSProgress documents its main-queue-updated properties as
            // triggering KVO synchronously on that same queue, but this
            // hops explicitly rather than assuming — `report`/`finish`
            // mutate MainActor-isolated state and must not race a
            // differently-scheduled notification.
            //
            // Reads `self.progressSink` (weak) rather than capturing the
            // `progress` parameter directly (jules review, PR #3185): a
            // captured strong `progress` would chain
            // self -> progressObservation -> closure -> progress,
            // defeating `progressSink`'s whole point — letting the editor
            // session's `DownloadProgress` die on its own schedule instead
            // of being kept alive by this observer.
            Task { @MainActor in
                guard let progress = self.progressSink else { return }
                let total = observed.totalUnitCount > 0 ? observed.totalUnitCount : nil
                if let total { self.lastExpectedBytes = total }
                progress.report(received: observed.completedUnitCount, total: self.lastExpectedBytes)
                if observed.isFinished {
                    progress.finish()
                    self.stop()
                }
            }
        }
    }
    #endif

    // MARK: - URL-resource polling fallback

    /// Detached so the URL-resource read (which can hit disk) doesn't block
    /// MainActor. The loop hops back to MainActor only for the brief
    /// `progress.report` / `progress.finish` writes. The loop body is
    /// inlined here (instead of passed to a helper) so the `[weak progress]`
    /// capture is re-evaluated on every iteration — a function parameter
    /// would hold a strong reference for the entire loop and defeat the
    /// weak capture (#1384 review).
    private func startPolling(url: URL, progress: DownloadProgress) {
        #if canImport(FileProvider)
        pollTask = Task.detached { [weak self, weak progress] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { break }
                // Re-read the weak captures each iteration so we exit as
                // soon as the editor releases the progress sink (typically
                // when the EditSession deallocates).
                guard let progress else { break }

                let snap = Self.snapshot(url: url)
                // Single hop (jules review, PR #3185 NIT): reading/updating
                // `self.lastExpectedBytes` and reporting/finishing
                // `progress` are both MainActor-isolated work for the same
                // tick — no reason to pay two context switches for it.
                await MainActor.run {
                    if let total = snap.total, total > 0 { self?.lastExpectedBytes = total }
                    progress.report(received: snap.received, total: self?.lastExpectedBytes)
                    if snap.isDone { progress.finish() }
                }
                if snap.isDone { break }
            }
        }
        #endif
    }

    // MARK: - Internals

    #if canImport(FileProvider)
    @available(macOS 13.0, iOS 16.0, *)
    private static func identifierForUserVisibleFile(
        at url: URL
    ) async throws -> (itemID: NSFileProviderItemIdentifier, domainID: NSFileProviderDomainIdentifier?) {
        try await withCheckedThrowingContinuation { cont in
            NSFileProviderManager.getIdentifierForUserVisibleFile(at: url) { itemID, domainID, error in
                if let itemID {
                    cont.resume(returning: (itemID, domainID))
                } else {
                    cont.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    @available(macOS 13.0, iOS 16.0, *)
    private static func manager(for domainID: NSFileProviderDomainIdentifier) async -> NSFileProviderManager? {
        await withCheckedContinuation { cont in
            NSFileProviderManager.getDomainsWithCompletionHandler { domains, _ in
                let match = domains.first(where: { $0.identifier == domainID })
                let manager = match.flatMap { NSFileProviderManager(for: $0) }
                cont.resume(returning: manager)
            }
        }
    }

    /// `(received, total, isDone)` from the URL's resource values. `received`
    /// is `totalFileAllocatedSizeKey` (bytes on disk so far for a
    /// materializing FileProvider item) falling back to `fileSizeKey`;
    /// `total` is `fileSizeKey`; `isDone` is true when the URL reports
    /// ubiquity status `.current` or when received >= total. Nonisolated so
    /// the off-MainActor poll loop can read URL resource values without an
    /// actor hop per tick.
    nonisolated private static func snapshot(url: URL) -> (received: Int64, total: Int64?, isDone: Bool) {
        let keys: Set<URLResourceKey> = [
            .fileSizeKey,
            .totalFileAllocatedSizeKey,
            .ubiquitousItemDownloadingStatusKey,
        ]
        guard let values = try? url.resourceValues(forKeys: keys) else {
            return (0, nil, false)
        }
        let total = values.fileSize.map { Int64($0) }
        let allocated = values.totalFileAllocatedSize.map { Int64($0) }
        let received = allocated ?? total ?? 0
        var isDone = false
        if let total, total > 0, received >= total {
            isDone = true
        }
        if values.ubiquitousItemDownloadingStatus == .current {
            isDone = true
        }
        return (received, total, isDone)
    }
    #endif

    /// Returns the file's declared size via `URLResourceKey.fileSizeKey`. Used
    /// for the initial `DownloadProgress.begin(expectedBytes:)` so the bar
    /// renders determinate from the first frame.
    private static func fileSize(of url: URL) -> Int64? {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return values?.fileSize.map { Int64($0) }
    }
}
