// Sources/MapleBackup/BackupEngine.swift
//
// Orchestrates the device-side backup pipeline:
//
//   queue.dequeue → state.transition(.uploading) → reader.read → upload →
//   sidecars.delete → state.transition(.uploaded)
//
// AssetReader is injected so tests can substitute synthetic bytes. The real
// implementation lives in MapleApp.PhotoKitAssetReader (Phase 3 Task 3.2) —
// PhotoKit-touching code that's not unit-testable in `swift test`.
//
// Wi-Fi gating (Task 3.12): when `wifiOnly` is true and the current
// reachability is not .wifi, background-priority tasks are re-enqueued
// instead of uploaded. A 30s sleep before re-enqueueing prevents a tight
// CPU loop when Wi-Fi is unavailable.
//
// Retry / backoff policy (Task 3.13): upload failures transition the task
// back to .pending and schedule a re-enqueue via a detached Task that sleeps
// an exponential backoff (1s, 2s, 4s, … capped at 1h). After 8 attempts,
// the task is marked .failedRetry. Retry tasks are tracked in `retryTasks`
// so stop() can cancel them cleanly.
//
// Best-effort companions (#700): only the PRIMARY bytes upload determines
// photo success. Once `upload.upload(...)` lands, the photo transitions to
// `.uploaded` and emits `.completed` — the companion artifacts (sidecar,
// Apple-rendered twin, Live Photo .mov) are uploaded best-effort AFTER that
// commit. A companion failure must NOT fail the photo, re-upload the bytes,
// or burn the photo's retry budget; instead each companion retries on its
// own bounded detached path. The local-edit sidecar is the durability-
// critical companion (it carries the user's intentional Maple edits), so it
// retries harder than the re-derivable generated sidecar / rendered / mov,
// and its local copy is deleted only after the server confirms it landed.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §13, §15, §17.

import Foundation
import os

/// What `BackupEngine` needs from PhotoKit. Real implementation in
/// `PhotoKitAssetReader` (Phase 3).
public protocol AssetReader: Actor {
    func read(phassetLocalId: String) async throws -> AssetReadResult
}

public struct AssetReadResult: Sendable {
    public let originalBytes: Data
    public let renderedBytes: Data?
    /// Bytes of the Live Photo .mov twin, if the asset is a Live Photo.
    /// Uploaded separately via the rendered endpoint with ext "mov".
    /// Lands as `<base>.mov` via suffix-override.
    public let liveVideoBytes: Data?
    /// Filename for the Live Photo .mov twin (e.g. "IMG_1234.mov").
    public let liveVideoFilename: String?
    public let sidecar: PayloadAssembler.SidecarInput
    public let mapleId: String

    public init(originalBytes: Data, renderedBytes: Data?,
                liveVideoBytes: Data? = nil, liveVideoFilename: String? = nil,
                sidecar: PayloadAssembler.SidecarInput, mapleId: String) {
        self.originalBytes = originalBytes
        self.renderedBytes = renderedBytes
        self.liveVideoBytes = liveVideoBytes
        self.liveVideoFilename = liveVideoFilename
        self.sidecar = sidecar
        self.mapleId = mapleId
    }
}

public actor BackupEngine {

    /// Diagnostics for the best-effort companion path (#700). Surfaces which
    /// companion (sidecar / rendered / live-mov) is retrying or has exhausted
    /// its bounded budget, so a stranded artifact is visible in Console.app
    /// without failing the (already-uploaded) photo.
    private static let companionLog = Logger(
        subsystem: "app.justmaple.aperture", category: "backup.companion")

    public enum EngineError: Error, Equatable, Sendable {
        case queueEmpty
    }

    private let queue: any BackupQueue
    private let state: BackupStateStore
    private let upload: UploadClient
    private let sidecars: AppSupportSidecarStore
    private let reader: any AssetReader
    private let reachability: Reachability?
    private let wifiOnly: Bool

    /// How many `process(task:)` runs proceed in parallel inside `run()`.
    /// Defaults to 8 (raised from the original hardcoded 4 in #700). The real
    /// wall-clock parallelism comes from network I/O suspending without holding
    /// the engine's actor isolation, so the cap mostly bounds how many assets
    /// we read + buffer at once. Overridable per-host for fast LAN servers.
    private let maxConcurrency: Int

    /// Backoff (seconds) for the Nth companion retry attempt. Defaults to the
    /// shared exponential schedule; tests inject a zero-delay closure so the
    /// bounded companion retry can be observed without sleeping real backoff.
    /// Internal (not public) — only `@testable` callers reach it; the bytes
    /// retry path deliberately stays on the static schedule.
    let companionBackoff: @Sendable (Int) -> TimeInterval

    /// In-flight retry tasks, tracked so stop() can cancel them cleanly.
    /// Covers both the primary-bytes retry/backoff path and the best-effort
    /// companion retry path (#700).
    ///
    /// Keyed by a token rather than held in a `Set<Task>` so a retry can
    /// retire its OWN entry from inside its closure, before it signals. That
    /// ordering is load-bearing — see `finishRetry(_:)`.
    private var retryTasks: [UUID: Task<Void, Never>] = [:]

    /// Wakes `run()` when a sleeping retry re-enqueues, so it can park
    /// instead of polling on a fixed interval while retries are outstanding
    /// (#1026). See `RetryWakeSignal` for the concurrency contract.
    private let retryWake = RetryWakeSignal()

    /// Reentrancy guard for `run()`. `RetryWakeSignal` has exactly one
    /// continuation slot, so two concurrent `run()` loops both parking on
    /// `retryWake.wait()` would silently overwrite one another's
    /// continuation and strand the first caller forever — `run()` is
    /// `public`, so nothing about the type system stops a second concurrent
    /// call. Set on entry, cleared on every exit (including cancellation)
    /// via `defer`, so a second concurrent call is a safe no-op rather than
    /// a trap or a hang.
    private var isRunning = false

    /// Per-task count of companions currently in their bounded detached-retry
    /// path (#702). A companion enters this set when its inline attempt fails
    /// (`runCompanion` catch) and leaves when it either lands on a retry or
    /// exhausts its budget. The 0→1 transition emits `.companionPending`; the
    /// →0 transition emits `.companionsResolved`, letting the progress VM
    /// distinguish "uploaded, companions pending" from "done". The recursive
    /// reschedule does NOT re-increment — increment is once per failed inline
    /// attempt, decrement is once at each companion's terminus.
    private var outstandingCompanions: [BackupTaskID: Int] = [:]

    /// Maximum retry attempts before a task is marked `.failedRetry`.
    private static let maxRetries = 8

    /// Bounded retry budget for the durability-critical local-edit sidecar
    /// companion. Matched to `maxRetries` so an in-session local-edit upload
    /// gets the same number of attempts the whole-task retry loop used to give
    /// it before #700 decoupled companions from the bytes upload.
    private static let localEditCompanionRetries = 8

    /// Bounded retry budget for re-derivable companions (generated sidecar,
    /// Apple-rendered twin, Live Photo .mov). These can be regenerated from
    /// PHAsset state on a future walk, so they retry lightly and are dropped
    /// on exhaustion rather than stranding a concurrency slot.
    private static let derivedCompanionRetries = 2

    public init(queue: any BackupQueue,
                state: BackupStateStore,
                upload: UploadClient,
                sidecars: AppSupportSidecarStore,
                reader: any AssetReader,
                reachability: Reachability? = nil,
                wifiOnly: Bool = false,
                maxConcurrency: Int = 8,
                companionBackoff: @escaping @Sendable (Int) -> TimeInterval = { min(3600, pow(2.0, Double($0))) }) {
        precondition(maxConcurrency > 0, "maxConcurrency must be > 0")
        self.queue = queue
        self.state = state
        self.upload = upload
        self.sidecars = sidecars
        self.reader = reader
        self.reachability = reachability
        self.wifiOnly = wifiOnly
        self.maxConcurrency = maxConcurrency
        self.companionBackoff = companionBackoff
    }

    /// Drive the queue until empty or until the enclosing Task is cancelled.
    /// Runs up to `maxConcurrency` tasks in parallel. The real wall-clock
    /// parallelism comes from the network I/O in `upload.session.data(for:)`,
    /// which suspends without holding the engine's actor isolation.
    ///
    /// A second concurrent call while one is already running is a safe
    /// no-op — see `isRunning`.
    ///
    /// The host (MapleApp / MapleBackupAgent) runs this on a long-lived
    /// background Task.
    public func run() async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }
        var inFlight = 0
        await withTaskGroup(of: Void.self) { group in
            while !Task.isCancelled {
                if inFlight < maxConcurrency, let next = await queue.dequeue() {
                    inFlight += 1
                    group.addTask { [self] in
                        do {
                            try await process(task: next)
                        } catch {
                            // Errors are handled inside process(task:) — state
                            // transitions to .pending for retry or .failedRetry
                            // on exhaustion.
                        }
                    }
                } else if inFlight > 0 {
                    _ = await group.next()
                    inFlight -= 1
                } else if !retryTasks.isEmpty {
                    // Queue is momentarily empty but retry tasks are still sleeping.
                    // Park here — no fixed-interval wakeup (#1026) — until a retry
                    // actually re-enqueues (or teardown signals us) and loop back
                    // to re-check the queue.
                    await retryWake.wait()
                } else {
                    // Queue is drained and no tasks in flight or pending retries — done.
                    break
                }
            }
        }
    }

    /// Cancel all pending retry tasks. Called by EngineHost.stop() before
    /// cancelling the runner Task so retries are torn down cleanly.
    public func stop() {
        for task in retryTasks.values {
            task.cancel()
        }
        retryTasks.removeAll()
        // Wake a parked runner so it observes teardown promptly. Without this,
        // `run()`'s doc claim that it parks "until a retry re-enqueues (or
        // teardown signals us)" is not actually true: a caller that invokes
        // `stop()` WITHOUT also cancelling the runner Task would leave it
        // parked forever on a `retryTasks` that is now empty. The cancelled
        // retries above do each signal on their way out, but only once their
        // sleep unwinds — and if `retryTasks` was already empty there is
        // nothing to unwind at all.
        Task { await retryWake.signal() }
        // Cancelled companion retries won't reach their decrement, so clear the
        // outstanding-companion counters too — a fresh run starts clean and we
        // never re-emit a stale `.companionsResolved` for a torn-down task (#702).
        outstandingCompanions.removeAll()
    }

    /// Process the next task in the queue, or return without throwing if
    /// the queue is empty. Test entry point.
    public func processOne() async throws {
        guard let next = await queue.dequeue() else { return }
        try await process(task: next)
    }

    private func process(task: BackupTask) async throws {
        // Wi-Fi gate. User-edit priority always uploads (cellular OK).
        if wifiOnly,
           let reachability,
           await reachability.status() != .wifi,
           task.priority < .userEdit {
            try await state.transition(task.id, to: .pending)
            // Exponential backoff on Wi-Fi deferral, capped at 1h. Reuse
            // retryCount as the deferral counter — semantically both represent
            // "this task was attempted and deferred". Prevents a tight 30s spin
            // on permanent cellular connections.
            let backoffSeconds = min(3600, 30.0 * pow(2.0, Double(task.retryCount)))
            let backoffNs = UInt64(backoffSeconds * 1_000_000_000)
            try? await Task.sleep(nanoseconds: backoffNs)
            var deferred = task
            deferred.retryCount += 1
            await queue.enqueue(deferred, priority: deferred.priority)
            return
        }

        await queue.emit(.started(task.id))

        let result: UploadClient.Result
        let read: AssetReadResult
        do {
            try await state.transition(task.id, to: .uploading)
            let readResult = try await reader.read(phassetLocalId: task.id.phassetLocalId)
            read = readResult

            // Capture local references for the progress closure (actor-isolated
            // captures aren't permitted directly inside the async closure below).
            let queueRef = queue
            let taskId = task.id

            // The PRIMARY bytes upload is the only step that decides photo
            // success. Its retry/backoff/busy-elsewhere semantics are unchanged:
            // a failure here falls into the catch blocks below, which schedule
            // a retry (or busy re-enqueue) and rethrow. Companions are handled
            // AFTER this do/catch — they never reach these catch blocks, so a
            // companion failure can't fail the photo or re-upload the bytes.
            result = try await upload.upload(
                phassetLocalId: task.id.phassetLocalId,
                filename: read.sidecar.originalFilename,
                captureDate: read.sidecar.captureDate,
                lat: read.sidecar.latitude,
                lon: read.sidecar.longitude,
                bytes: read.originalBytes,
                mapleId: read.mapleId,
                phassetCloudId: read.sidecar.phassetCloudId,
                onProgress: { sent, total in
                    await queueRef.emit(.progress(taskId, sent: sent, total: total))
                })

            // Bytes landed — the photo counts as uploaded. Persist + emit before
            // touching any companion so a companion hiccup can never revert this.
            try await state.transition(task.id, to: .uploaded, error: nil)
            await queue.emit(.completed(task.id, mapleId: result.mapleId))
        } catch UploadClient.UploadError.busyElsewhere(let retryAfterSeconds) {
            // Another device on the same iCloud library is actively uploading
            // this asset. Re-enqueue at the back of the same priority bucket
            // after a short delay so the other device's upload can progress.
            // Don't bump retryCount — this isn't a failure, it's coordination.
            try? await state.transition(task.id, to: .pending,
                                        error: "busy: another device uploading")
            // Cap the delay so we don't sit idle for the full peer-staleness
            // window (30 min) on every collision — re-probing periodically
            // is cheaper than sleeping the full window.
            let delay = min(retryAfterSeconds, 60)
            let queueRef = queue
            let token = UUID()
            let deferTask = Task.detached(priority: .background) { [weak self] in
                // `try?` would swallow CancellationError and we'd re-enqueue
                // after `stop()` was called — re-checking isCancelled after
                // the sleep keeps the cleanup contract intact.
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                if Task.isCancelled {
                    // Still retire the entry: a cancelled retry that stayed in
                    // `retryTasks` would leave `run()` parked on a wake that
                    // can never arrive.
                    await self?.finishRetry(token)
                    return
                }
                await queueRef.enqueue(task, priority: task.priority)
                await self?.finishRetry(token) // retire, THEN wake run() (#1026)
            }
            retryTasks[token] = deferTask
            await queue.emit(.failed(task.id, error: "busy elsewhere", willRetry: true))
            throw UploadClient.UploadError.busyElsewhere(
                retryAfterSeconds: retryAfterSeconds)
        } catch {
            let nextRetry = task.retryCount + 1
            let willRetry = nextRetry < Self.maxRetries
            if !willRetry {
                try? await state.transition(task.id, to: .failedRetry,
                                            error: "max retries: \(error)",
                                            retryCount: nextRetry)
            } else {
                // Persist the bumped retry count alongside the state flip —
                // otherwise SQLite's `retry_count` stays at the previous
                // value and `EngineHost.start()` rehydration would reset it
                // back to that stale value on restart, making the
                // `maxRetries` ceiling effectively infinite across restarts.
                try? await state.transition(task.id, to: .pending,
                                            error: "\(error)",
                                            retryCount: nextRetry)
                // Re-enqueue from a detached Task that sleeps the backoff.
                let backoff = Self.backoffSeconds(for: nextRetry)
                let queueRef = queue
                let token = UUID()
                let retryTask = Task.detached(priority: .background) { [weak self] in
                    // Same cancellation discipline as the busy-elsewhere path —
                    // bail after the sleep if `stop()` cancelled us.
                    try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                    if Task.isCancelled {
                        await self?.finishRetry(token)
                        return
                    }
                    var retry = task
                    retry.retryCount = nextRetry
                    await queueRef.enqueue(retry, priority: retry.priority)
                    await self?.finishRetry(token) // retire, THEN wake run() (#1026)
                }
                // Track for cancellation on stop().
                retryTasks[token] = retryTask
            }
            await queue.emit(.failed(task.id, error: "\(error)", willRetry: willRetry))
            throw error
        }

        // Reached only when the bytes upload above succeeded (every catch
        // rethrows). The photo is already `.uploaded` + `.completed`. Upload
        // the companions best-effort: an inline first attempt (so request
        // ordering + the sidecar-delete-on-success invariant happen before
        // this call returns, which the synchronous tests rely on), then a
        // bounded detached retry per companion on failure. Companions never
        // throw out of here and never emit `.failed` — a companion exhausting
        // its budget would otherwise double-count the photo in the progress VM
        // (already `.completed`) as failed.
        await uploadCompanionsBestEffort(task: task, read: read, result: result)
    }

    // MARK: - Best-effort companions (#700)

    /// Upload the sidecar, Apple-rendered twin, and Live Photo .mov twin for a
    /// photo whose bytes have already landed. Each companion is attempted inline
    /// once; on failure it schedules its own bounded detached retry. Nothing
    /// here can fail the photo or re-upload the bytes.
    private func uploadCompanionsBestEffort(task: BackupTask,
                                            read: AssetReadResult,
                                            result: UploadClient.Result) async {
        // Sidecar: prefer the user's local-edit XMP if one exists (their
        // intentional Maple edit wins); fall back to the Apple-metadata XMP
        // generated from PHAsset state. Track whether this is a local edit —
        // that's the durability-critical case: it isn't re-derivable from
        // PHAsset state, so it retries harder and its local copy is deleted
        // only after the server confirms it landed.
        let localEditXmp = try? sidecars.read(phassetLocalId: task.id.phassetLocalId)
        let isLocalEdit = localEditXmp != nil
        let sidecarXmp = localEditXmp ?? PayloadAssembler.buildSidecarXMP(input: read.sidecar)

        await runCompanion(
            taskId: task.id,
            label: "sidecar",
            maxAttempts: isLocalEdit ? Self.localEditCompanionRetries
                                     : Self.derivedCompanionRetries
        ) { [self] in
            try await upload.uploadSidecar(
                phassetLocalId: task.id.phassetLocalId,
                targetRelPath: result.targetRelPath,
                xmp: sidecarXmp,
                mapleId: read.mapleId)
            // Delete the local-edit XMP only after the sidecar actually lands on
            // the server, so a failed attempt re-derives correctly on retry and
            // a crash before delivery leaves the user's edit on disk.
            try? sidecars.delete(phassetLocalId: task.id.phassetLocalId)
        }

        // Apple-rendered companion, when present. Re-derivable → light retry.
        if let renderedBytes = read.renderedBytes, !renderedBytes.isEmpty {
            let ext = (result.targetRelPath as NSString).pathExtension
            let renderedExt = ext.isEmpty ? "jpeg" : ext
            await runCompanion(taskId: task.id, label: "rendered",
                               maxAttempts: Self.derivedCompanionRetries) { [self] in
                try await upload.uploadRendered(
                    phassetLocalId: task.id.phassetLocalId,
                    targetRelPath: result.targetRelPath,
                    filenameExt: renderedExt,
                    bytes: renderedBytes,
                    phassetCloudId: read.sidecar.phassetCloudId)
            }
        }

        // Live Photo .mov twin, when present. Lands as `<base>.mov` (no
        // .rendered. infix) via suffix-override. Re-derivable → light retry.
        if let liveBytes = read.liveVideoBytes, !liveBytes.isEmpty {
            await runCompanion(taskId: task.id, label: "live-mov",
                               maxAttempts: Self.derivedCompanionRetries) { [self] in
                try await upload.uploadRendered(
                    phassetLocalId: task.id.phassetLocalId,
                    targetRelPath: result.targetRelPath,
                    filenameExt: "mov",
                    bytes: liveBytes,
                    suffixOverride: "mov",
                    phassetCloudId: read.sidecar.phassetCloudId)
            }
        }
    }

    /// Run one companion upload best-effort: try `op` inline once; on failure
    /// schedule a bounded, exponentially-backed-off detached retry (tracked in
    /// `retryTasks` so `stop()` tears it down cleanly). Never throws, never
    /// emits queue events. `busyElsewhere` on a companion is treated like any
    /// other transient failure here — it's coordination on a re-derivable
    /// artifact, not a reason to fail the (already-uploaded) photo.
    private func runCompanion(taskId: BackupTaskID,
                              label: String,
                              maxAttempts: Int,
                              _ op: @escaping @Sendable () async throws -> Void) async {
        do {
            try await op()
        } catch {
            Self.companionLog.notice(
                "companion \(label, privacy: .public) first attempt failed, scheduling retry: \(String(describing: error), privacy: .public)")
            // This companion is now outstanding — count it once. The bounded
            // detached retry (and its recursive reschedules) decrement exactly
            // once at the chain's terminus (success or exhaustion). Emit the
            // 0→1 `.companionPending` signal here so the photo flips from "done"
            // to "uploaded, companions pending" in the progress VM (#702).
            await companionBecamePending(taskId)
            scheduleCompanionRetry(taskId: taskId, label: label, attempt: 1,
                                   maxAttempts: maxAttempts, op: op)
        }
    }

    /// Schedule the next bounded companion retry. Detached so it doesn't hold a
    /// `run()` concurrency slot; on exhaustion the re-derivable artifact is
    /// simply dropped (a future safety walk can regenerate it).
    private func scheduleCompanionRetry(taskId: BackupTaskID,
                                        label: String,
                                        attempt: Int,
                                        maxAttempts: Int,
                                        op: @escaping @Sendable () async throws -> Void) {
        guard attempt < maxAttempts else {
            Self.companionLog.error(
                "companion \(label, privacy: .public) exhausted \(maxAttempts) attempts — dropping (re-derivable artifacts can be regenerated on a future walk)")
            // Terminal: budget exhausted. Decrement once so a dropped companion
            // doesn't leak as permanently "pending" (#702).
            Task { await self.companionResolved(taskId) }
            return
        }
        let backoff = companionBackoff(attempt)
        let token = UUID()
        let retryTask = Task.detached(priority: .background) { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            if Task.isCancelled {
                await self?.finishRetry(token)
                return
            }
            do {
                try await op()
                // Terminal: the companion landed on this retry. Decrement once.
                await self?.companionResolved(taskId)
            } catch {
                // Bounded recursion via the actor so retryTasks stays consistent.
                // No re-increment: this companion is already counted outstanding.
                await self?.scheduleCompanionRetry(taskId: taskId, label: label,
                                                   attempt: attempt + 1,
                                                   maxAttempts: maxAttempts, op: op)
            }
            // Retire on EVERY exit. A companion retry never enqueues to the
            // upload queue and used to never signal at all, so a `retryTasks`
            // holding only companions parked `run()` on a wake that could not
            // arrive — the 1 s poll used to paper over that.
            await self?.finishRetry(token)
        }
        retryTasks[token] = retryTask
    }

    /// Retire a finished retry and wake `run()` — in that order.
    ///
    /// The ordering is the whole point. `run()` parks precisely because
    /// `retryTasks` was non-empty, so if a retry signalled *before* removing
    /// itself, `run()` could consume that wake, drain the queue, loop, still
    /// observe the stale entry, and park again on a signal already spent —
    /// with `isRunning` latched, no later `run()` could recover it and uploads
    /// would stop until relaunch. Removing first means any wake `run()` acts on
    /// is evaluated against a `retryTasks` that already reflects this task's
    /// exit. Signalling unconditionally (not just when the queue gained work)
    /// is what covers the companion path, which never enqueues anything.
    private func finishRetry(_ token: UUID) async {
        retryTasks[token] = nil
        await retryWake.signal()
    }

    // MARK: - Outstanding-companion accounting (#702)

    /// Record that one more companion for `taskId` has entered its bounded
    /// retry path. Emits `.companionPending` only on the 0→1 transition so the
    /// progress VM flips the photo to "uploaded, companions pending" exactly
    /// once regardless of how many companions are outstanding.
    private func companionBecamePending(_ taskId: BackupTaskID) async {
        let prior = outstandingCompanions[taskId] ?? 0
        outstandingCompanions[taskId] = prior + 1
        if prior == 0 {
            await queue.emit(.companionPending(taskId))
        }
    }

    /// Record that one companion for `taskId` reached a terminal state (landed
    /// or exhausted). Emits `.companionsResolved` only on the →0 transition so
    /// the photo flips back to fully "done" exactly once.
    private func companionResolved(_ taskId: BackupTaskID) async {
        guard let prior = outstandingCompanions[taskId], prior > 0 else { return }
        if prior == 1 {
            outstandingCompanions.removeValue(forKey: taskId)
            await queue.emit(.companionsResolved(taskId))
        } else {
            outstandingCompanions[taskId] = prior - 1
        }
    }

    /// Exponential backoff capped at 1 hour. The `companionBackoff` default
    /// argument inlines the same formula (a `public` init can't reference a
    /// non-public member in a default value).
    private static func backoffSeconds(for retryCount: Int) -> TimeInterval {
        min(3600, pow(2.0, Double(retryCount)))
    }
}
