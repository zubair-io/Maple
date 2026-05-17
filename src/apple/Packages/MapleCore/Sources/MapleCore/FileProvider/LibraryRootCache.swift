// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/LibraryRootCache.swift
import Foundation
import OSLog

/// Caches the library-roots list for the lifetime of the extension
/// process AND persists to App Group `UserDefaults` so first-launch
/// `roots()` returns instantly. A background revalidation runs after
/// every disk-or-memory-served read; if the fresh list differs from
/// the one we just served, an optional `driftHandler` fires so the
/// FP extension can `signalEnumerator(for: .rootContainer)`.
///
/// The cache does NOT call into `NSFileProviderManager` directly — it
/// only emits a drift event. The wiring lives in
/// `FileProviderExtension`.
public actor LibraryRootCache {
    public typealias Fetcher = @Sendable () async throws -> [LibraryRoot]
    public typealias DriftHandler = @Sendable () async -> Void

    private let domainID: String
    private let defaults: UserDefaults
    private let fetcher: Fetcher
    private var memoryCache: [LibraryRoot]?
    private var inflight: Task<[LibraryRoot], Error>?
    private var driftHandler: DriftHandler?
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "root-cache")

    public init(domainID: String,
                defaults: UserDefaults? = nil,
                fetcher: @escaping Fetcher) {
        self.domainID = domainID
        self.defaults = defaults
            ?? UserDefaults(suiteName: FileProviderConfig.appGroupSuiteName)
            ?? .standard
        self.fetcher = fetcher
    }

    private var diskKey: String { "fileprovider.\(domainID).library-roots" }

    public func setDriftHandler(_ handler: @escaping DriftHandler) {
        self.driftHandler = handler
    }

    public func roots() async throws -> [LibraryRoot] {
        // Memory cache wins — return immediately, kick a background revalidation.
        if let mc = memoryCache {
            kickRevalidation()
            return mc
        }
        // Disk cache: prime memory, return synchronously, kick revalidation.
        if let data = defaults.data(forKey: diskKey),
           let decoded = try? JSONDecoder().decode([LibraryRoot].self, from: data) {
            memoryCache = decoded
            kickRevalidation()
            return decoded
        }
        // Cold path: await the fetcher.
        return try await runFetcher()
    }

    public func invalidate() {
        memoryCache = nil
        defaults.removeObject(forKey: diskKey)
    }

    // MARK: - Internals

    /// Fire-and-forget background revalidation. Exactly one in flight at
    /// a time. The Task is responsible for clearing `inflight` in BOTH
    /// the success and failure paths so a single transient error does
    /// not leave the slot permanently occupied.
    private func kickRevalidation() {
        guard inflight == nil else { return }
        let primed = memoryCache
        let task = Task { [fetcher] () async throws -> [LibraryRoot] in
            try await fetcher()
        }
        inflight = task
        Task { [weak self] in
            defer { Task { [weak self] in await self?.clearInflight() } }
            do {
                let fresh = try await task.value
                await self?.applyRevalidation(fresh: fresh, primed: primed)
            } catch {
                // Background revalidation failure is non-fatal — the
                // memory/disk-served value is still good. Log and move
                // on; `clearInflight` runs via defer so the next call
                // will try again.
                await self?.logRevalidationFailure(error)
            }
        }
    }

    /// Synchronous (await-blocking) fetcher path. Used on the first
    /// ever `roots()` call when there is no disk cache to prime from.
    /// Clears `inflight` in both success and failure branches so the
    /// caller's retry-after-error semantics work.
    private func runFetcher() async throws -> [LibraryRoot] {
        if let t = inflight {
            // Piggy-back on the in-flight Task. If it threw, we'll
            // throw too — that's fine, the next call will start a
            // fresh fetcher (the throwing Task clears inflight via
            // its own defer chain).
            return try await t.value
        }
        let task = Task { [fetcher] () async throws -> [LibraryRoot] in
            try await fetcher()
        }
        inflight = task
        do {
            let fresh = try await task.value
            inflight = nil
            applyRevalidation(fresh: fresh, primed: memoryCache)
            return fresh
        } catch {
            // Critical: a fetcher failure here must clear `inflight`
            // so the next caller can retry. Without this, every
            // subsequent call awaits a dead task that just re-throws
            // the same error forever.
            inflight = nil
            throw error
        }
    }

    private func clearInflight() { inflight = nil }

    private func logRevalidationFailure(_ error: Error) {
        log.error("revalidation failed: \(error.localizedDescription, privacy: .public)")
    }

    private func applyRevalidation(fresh: [LibraryRoot],
                                   primed: [LibraryRoot]?) {
        memoryCache = fresh
        if let data = try? JSONEncoder().encode(fresh) {
            defaults.set(data, forKey: diskKey)
        }
        let drifted: Bool
        if let primed {
            drifted = primed != fresh
        } else {
            // No prior in-memory snapshot to compare against — only
            // signal drift if there is actually something to enumerate.
            // First-ever fetch shouldn't fire a "drift" signal on its
            // own; that's just the normal arrival of data.
            drifted = false
        }
        if drifted, let handler = driftHandler {
            Task { await handler() }
        }
    }
}
