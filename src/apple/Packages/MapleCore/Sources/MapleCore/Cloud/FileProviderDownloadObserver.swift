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
// Item`) and polls `URLResourceKey.totalFileAllocatedSizeKey` against
// `.fileSizeKey` until the download flips to "downloaded" — bridging those
// numbers into `DownloadProgress.report(received:total:)` so the editor's
// existing overlay shows received/total/speed exactly like the cloud-search
// path.
//
// For local files (non-FileProvider URLs) detection silently no-ops — the
// editor's overlay stays hidden, and the synchronous `Data(contentsOf:)`
// path inside `FilesystemSource.rawBytes` proceeds unchanged.

import Foundation
#if canImport(FileProvider)
import FileProvider
#endif

/// Drives `DownloadProgress` while iOS/macOS materializes a FileProvider-
/// backed file. No-op for local files. Cancels the underlying download on
/// `stop()` so an in-flight materialization doesn't outlive the editor's
/// interest in the asset.
@MainActor
public final class FileProviderDownloadObserver {
    /// Cancellation flag for the polling task. Re-checked after every sleep
    /// so `stop()` ends the loop within one poll interval (~200 ms).
    private var isCancelled: Bool = false
    /// Background poll loop. Kept around so `stop()` can cancel it.
    private var pollTask: Task<Void, Never>?

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
        // renders the bar indeterminate until the poll loop learns more.
        let initialExpected = Self.fileSize(of: url)
        progress.begin(expectedBytes: initialExpected)

        // (3) Resolve the domain so we can build a per-domain manager. A nil
        // domainID corresponds to the system's default domain — we leave the
        // manager as `nil` in that case and rely on the URL-driven polling
        // path, which still works.
        let manager: NSFileProviderManager?
        if let domainID = identifier.domainID {
            manager = await Self.manager(for: domainID)
        } else {
            manager = nil
        }

        // (4) Kick the download. The Swift refined API returns void; we
        // observe bytes-received via URL resource polling. Errors here are
        // benign — the file will still materialize when `Data(contentsOf:)`
        // touches it; we just won't get progress feedback.
        if let manager {
            Task.detached {
                try? await manager.requestDownloadForItem(
                    withIdentifier: identifier.itemID,
                    requestedRange: nil
                )
            }
        }

        // (5) Poll the URL's file-size resource keys every ~200 ms,
        // forwarding the partial size into `DownloadProgress.report`.
        // Bails when the URL reports `.current` ubiquity status (download
        // complete) or when `stop()` flips `isCancelled`.
        pollTask = Task { [weak self, weak progress] in
            await self?.pollLoop(url: url, expected: initialExpected, progress: progress)
        }
        #else
        _ = url
        _ = progress
        #endif
    }

    /// Cancel the poll loop and finish the progress observation. Safe to
    /// call multiple times.
    public func stop() {
        isCancelled = true
        pollTask?.cancel()
        pollTask = nil
    }

    deinit {
        // Best-effort cancellation — `stop()` is the documented teardown.
        pollTask?.cancel()
    }

    // MARK: - Internals

    #if canImport(FileProvider)
    @available(macOS 13.0, iOS 16.0, *)
    private func pollLoop(url: URL, expected initialExpected: Int64?, progress: DownloadProgress?) async {
        var lastExpected: Int64? = initialExpected
        // `pollLoop` inherits MainActor isolation from the @MainActor class, so
        // `isCancelled` and `progress.report(...)` are reachable without an
        // actor hop. `Task.sleep` yields the actor, which is the only reason
        // this loop doesn't peg the main thread between polls.
        while !Task.isCancelled, !isCancelled {
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, !isCancelled else { break }
            guard let progress else { break }

            let (received, total, isDone) = Self.snapshot(url: url)
            if let total, total > 0 {
                lastExpected = total
            }
            progress.report(received: received, total: lastExpected)
            if isDone {
                progress.finish()
                break
            }
        }
    }

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
    /// ubiquity status `.current` or when received >= total.
    private static func snapshot(url: URL) -> (received: Int64, total: Int64?, isDone: Bool) {
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
