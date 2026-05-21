// RawImageCache.swift — Session-scoped, single-entry cache for the
// rawler-decoded RAW handle. Keyed on (URL, mtime). Eviction on asset
// switch.
//
// Architectural prerequisite for Plan 3 (Deep Zoom tile rendering):
// without this, every tile render rawler-decodes a 100 MP RAW
// (~3-5 s per tile, blowing past the slider-tick budget). With it,
// rawler-decode happens once per asset open and tiles share the
// cached `MapleRawHandle`. See Plan 3 Task 5.
//
// In-memory only. No disk persistence — the underlying handle is an
// opaque pointer to a heap-allocated rawler decode result, which can't
// safely cross process boundaries. Disk persistence would require a
// portable serialization of the decoded mosaic and is left to a
// follow-up plan.
//
// Concurrency: an actor. The `handle(for:)` call is the public entry
// point and is `async`. The actual rawler decode is offloaded onto a
// detached `Task` so the actor isn't blocked while a 100 MP RAW
// streams off disk. Once the decode lands, the actor stores the
// resulting `MapleRawHandle` in `current` and returns it.
//
// Cross-link: .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md
// Task 5.

import Foundation

public actor RawImageCache {
    /// Process-wide shared instance. Most callers should use `.shared`
    /// to ensure all tile fetches across the app see a single cached
    /// handle. Tests construct their own instances for isolation.
    public static let shared = RawImageCache()

    private struct Entry {
        let url: URL
        let mtime: Date
        let handle: MapleRawHandle
    }

    private var current: Entry?

    /// In-flight decode tasks, keyed by URL. The deep-zoom tile path
    /// fires N concurrent `handle(for:)` calls (one per visible tile),
    /// and without this map every concurrent call would START its own
    /// `ffi_rawler_decode` because `current` is nil while the first
    /// decode awaits. User reported on iPad: 20 visible tiles → 20
    /// parallel decodes of a 100 MP RAW → 7-22 s per decode under
    /// memory contention. With this map, the second-through-Nth caller
    /// just await the same `Task` the first caller started.
    private var pendingDecodes: [URL: Task<MapleRawHandle, Error>] = [:]

    public init() {}

    /// Returns the cached handle for `url` if its mtime hasn't changed
    /// since the cached entry was decoded, otherwise evicts and decodes
    /// fresh. The decode runs on a detached task at user-initiated
    /// priority so the actor isn't blocked. Concurrent callers for the
    /// same URL share a single in-flight decode (see `pendingDecodes`).
    ///
    /// Throws whatever `PipelineRenderer.openRawHandle(rawPath:)`
    /// throws — typically `PipelineError.renderFailed` for missing
    /// files or unsupported RAW formats.
    public func handle(for url: URL) async throws -> MapleRawHandle {
        let mtime = Self.modificationDate(for: url)
        if let entry = current,
           entry.url == url,
           entry.mtime == mtime {
            return entry.handle
        }
        // Concurrent caller for the same URL — share the in-flight Task.
        if let pending = pendingDecodes[url] {
            return try await pending.value
        }
        // Different asset OR same asset with newer sidecar — evict and
        // decode. Eviction happens BEFORE the decode so that if the
        // decode throws we don't leave a stale cached handle behind.
        current = nil
        let task = Task.detached(priority: .userInitiated) {
            try PipelineRenderer.openRawHandle(rawPath: url, xmpPath: nil)
        }
        pendingDecodes[url] = task
        do {
            let handle = try await task.value
            current = Entry(url: url, mtime: mtime, handle: handle)
            pendingDecodes.removeValue(forKey: url)
            return handle
        } catch {
            pendingDecodes.removeValue(forKey: url)
            throw error
        }
    }

    /// Force eviction. Useful when the editor switches assets and the
    /// caller wants to free the ~30-300 MB of decoded mosaic
    /// immediately rather than waiting for the next `handle(for:)`
    /// call. Idempotent; safe to call when the cache is already empty.
    public func evict() {
        current = nil
        // Don't cancel pending decodes — a caller may still be awaiting
        // them. They'll resolve and just not get cached afterward (the
        // entry won't be re-set since `current` is nil and the URL no
        // longer matches anything).
    }

    /// Currently cached URL, if any. Used by tests and instrumentation
    /// to verify cache state without poking the internal storage.
    public var cachedURL: URL? { current?.url }

    // MARK: - Helpers

    /// Best-effort filesystem mtime lookup. Falls back to
    /// `Date.distantPast` when the file is unreachable so the very
    /// next `handle(for:)` call always misses the cache (and surfaces
    /// the underlying file error from the FFI).
    private static func modificationDate(for url: URL) -> Date {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.modificationDate] as? Date) ?? Date.distantPast
    }
}
