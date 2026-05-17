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
    /// Monotonic counter bumped on every `invalidate()`. Each background
    /// kick captures the value at start time; `finishRevalidation` drops
    /// the result if the captured value no longer matches — i.e. an
    /// invalidate() arrived between kick and completion. Without this,
    /// a slow in-flight fetcher could land after an invalidate and
    /// silently repopulate the cache the caller just emptied.
    private var generation: Int = 0
    private var driftHandler: DriftHandler?
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "root-cache")

    public init(domainID: String,
                defaults: UserDefaults? = nil,
                driftHandler: DriftHandler? = nil,
                fetcher: @escaping Fetcher) {
        self.domainID = domainID
        self.defaults = defaults
            ?? UserDefaults(suiteName: FileProviderConfig.appGroupSuiteName)
            ?? .standard
        self.driftHandler = driftHandler
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
        // Cancel and detach any in-flight revalidation so a slow
        // fetcher landing after the caller emptied the cache cannot
        // repopulate it. The generation bump is the authoritative
        // signal: even if `cancel()` is a no-op (URLSession completes
        // anyway), `finishRevalidation` drops the result because the
        // generation it captured no longer matches.
        inflight?.cancel()
        inflight = nil
        generation &+= 1
    }

    // MARK: - Internals

    /// Fire-and-forget background revalidation. Exactly one in flight at
    /// a time. The Task is responsible for clearing `inflight` in BOTH
    /// the success and failure paths so a single transient error does
    /// not leave the slot permanently occupied.
    ///
    /// Critical: `inflight` is cleared in the SAME actor-bound block
    /// that processes the success/failure outcome (`finishRevalidation`)
    /// — not via a separate deferred `Task { ... }`. With the deferred
    /// shape, a synchronous caller arriving between the catch and the
    /// deferred clear would see `inflight != nil`, await the dead Task,
    /// re-throw its error, and the next `kickRevalidation` would be a
    /// no-op too because `inflight` still looked occupied to the next
    /// memory-served read.
    private func kickRevalidation() {
        guard inflight == nil else { return }
        let primed = memoryCache
        let capturedGeneration = generation
        let task = Task { [fetcher] () async throws -> [LibraryRoot] in
            try await fetcher()
        }
        inflight = task
        Task { [weak self] in
            let outcome: Result<[LibraryRoot], Error>
            do {
                outcome = .success(try await task.value)
            } catch {
                outcome = .failure(error)
            }
            await self?.finishRevalidation(outcome,
                                            primed: primed,
                                            capturedGeneration: capturedGeneration)
        }
    }

    /// Single actor-isolated landing for both success and failure of a
    /// background revalidation. Clears `inflight` as part of the same
    /// atomic actor block that applies the result — there is no window
    /// in which `inflight` is non-nil but the outcome has already been
    /// observed.
    private func finishRevalidation(_ outcome: Result<[LibraryRoot], Error>,
                                    primed: [LibraryRoot]?,
                                    capturedGeneration: Int) {
        // Always clear inflight: even a stale result frees the slot for
        // the next caller. Generation gate then decides whether the
        // payload is applied.
        inflight = nil
        guard capturedGeneration == generation else {
            // Cache was invalidated between kick and completion. Drop
            // the result — applying it would silently repopulate what
            // the caller just emptied.
            return
        }
        switch outcome {
        case .success(let fresh):
            applyRevalidation(fresh: fresh, primed: primed)
        case .failure(let error):
            logRevalidationFailure(error)
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
        let capturedGeneration = generation
        let task = Task { [fetcher] () async throws -> [LibraryRoot] in
            try await fetcher()
        }
        inflight = task
        do {
            let fresh = try await task.value
            inflight = nil
            // If the cache was invalidated while we were awaiting, do
            // not write the result back into memory/disk — but still
            // return it to the caller so its current operation
            // completes. The next caller will start fresh.
            if capturedGeneration == generation {
                applyRevalidation(fresh: fresh, primed: memoryCache)
            }
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
