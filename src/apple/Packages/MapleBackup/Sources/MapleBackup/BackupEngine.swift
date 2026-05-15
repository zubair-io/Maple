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
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §13, §15, §17.

import Foundation

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
    /// TODO: once the server endpoint accepts X-Maple-Suffix-Override, rename
    /// the server-side file from `<base>.rendered.mov` to `<base>.mov`.
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

    /// In-flight retry tasks, tracked so stop() can cancel them cleanly.
    private var retryTasks: Set<Task<Void, Never>> = []

    /// Maximum retry attempts before a task is marked `.failedRetry`.
    private static let maxRetries = 8

    public init(queue: any BackupQueue,
                state: BackupStateStore,
                upload: UploadClient,
                sidecars: AppSupportSidecarStore,
                reader: any AssetReader,
                reachability: Reachability? = nil,
                wifiOnly: Bool = false) {
        self.queue = queue
        self.state = state
        self.upload = upload
        self.sidecars = sidecars
        self.reader = reader
        self.reachability = reachability
        self.wifiOnly = wifiOnly
    }

    /// Drive the queue until empty or until the enclosing Task is cancelled.
    /// Runs up to `maxConcurrency` tasks in parallel. The real wall-clock
    /// parallelism comes from the network I/O in `upload.session.data(for:)`,
    /// which suspends without holding the engine's actor isolation.
    ///
    /// The host (MapleApp / MapleBackupAgent) runs this on a long-lived
    /// background Task.
    public func run() async {
        let maxConcurrency = 4
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
                    // Wait briefly so they can wake and re-enqueue before we exit.
                    try? await Task.sleep(for: .seconds(1))
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
        for task in retryTasks {
            task.cancel()
        }
        retryTasks.removeAll()
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

        do {
            try await state.transition(task.id, to: .uploading)
            let read = try await reader.read(phassetLocalId: task.id.phassetLocalId)

            // Capture local references for the progress closure (actor-isolated
            // captures aren't permitted directly inside the async closure below).
            let queueRef = queue
            let taskId = task.id

            let result = try await upload.upload(
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

            // Upload the sidecar to the cloud library. Prefer the local-edit XMP if
            // one exists in AppSupportSidecarStore (the user's intentional Maple edit
            // wins); fall back to the Apple-metadata XMP generated from PHAsset state.
            let sidecarXmp: String
            if let localEdit = try? sidecars.read(phassetLocalId: task.id.phassetLocalId) {
                sidecarXmp = localEdit
            } else {
                sidecarXmp = PayloadAssembler.buildSidecarXMP(input: read.sidecar)
            }
            try await upload.uploadSidecar(
                phassetLocalId: task.id.phassetLocalId,
                targetRelPath: result.targetRelPath,
                xmp: sidecarXmp)

            // Only after the sidecar lands on the server, delete the local one.
            try? sidecars.delete(phassetLocalId: task.id.phassetLocalId)

            // Upload the Apple-rendered companion when present.
            if let renderedBytes = read.renderedBytes, !renderedBytes.isEmpty {
                let ext = (result.targetRelPath as NSString).pathExtension
                let renderedExt = ext.isEmpty ? "jpeg" : ext
                try await upload.uploadRendered(
                    phassetLocalId: task.id.phassetLocalId,
                    targetRelPath: result.targetRelPath,
                    filenameExt: renderedExt,
                    bytes: renderedBytes)
            }

            // Upload Live Photo .mov twin when present. Uses suffix-override so
            // it lands as `<base>.mov` instead of `<base>.rendered.mov`.
            if let liveBytes = read.liveVideoBytes, !liveBytes.isEmpty {
                try await upload.uploadRendered(
                    phassetLocalId: task.id.phassetLocalId,
                    targetRelPath: result.targetRelPath,
                    filenameExt: "mov",
                    bytes: liveBytes,
                    suffixOverride: "mov")
            }

            try await state.transition(task.id, to: .uploaded, error: nil)
            await queue.emit(.completed(task.id, mapleId: result.mapleId))
        } catch {
            let nextRetry = task.retryCount + 1
            let willRetry = nextRetry < Self.maxRetries
            if !willRetry {
                try? await state.transition(task.id, to: .failedRetry,
                                            error: "max retries: \(error)")
            } else {
                try? await state.transition(task.id, to: .pending,
                                            error: "\(error)")
                // Re-enqueue from a detached Task that sleeps the backoff.
                let backoff = Self.backoffSeconds(for: nextRetry)
                let queueRef = queue
                let retryTask = Task.detached(priority: .background) {
                    try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                    var retry = task
                    retry.retryCount = nextRetry
                    await queueRef.enqueue(retry, priority: retry.priority)
                }
                // Track for cancellation on stop().
                retryTasks.insert(retryTask)
                // Auto-clean when the task finishes.
                Task { [weak self] in
                    _ = await retryTask.value
                    await self?.removeRetryTask(retryTask)
                }
            }
            await queue.emit(.failed(task.id, error: "\(error)", willRetry: willRetry))
            throw error
        }
    }

    private func removeRetryTask(_ task: Task<Void, Never>) {
        retryTasks.remove(task)
    }

    /// Exponential backoff capped at 1 hour.
    private static func backoffSeconds(for retryCount: Int) -> TimeInterval {
        min(3600, pow(2.0, Double(retryCount)))
    }
}
