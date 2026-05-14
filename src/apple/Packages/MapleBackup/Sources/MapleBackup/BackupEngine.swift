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
// instead of uploaded.
//
// Retry / backoff policy (Task 3.13): upload failures transition the task
// back to .pending and schedule a re-enqueue via a detached Task that sleeps
// an exponential backoff (1s, 2s, 4s, … capped at 1h). After 8 attempts,
// the task is marked .failedRetry.
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
    public let sidecar: PayloadAssembler.SidecarInput
    public let mapleId: String

    public init(originalBytes: Data, renderedBytes: Data?,
                sidecar: PayloadAssembler.SidecarInput, mapleId: String) {
        self.originalBytes = originalBytes
        self.renderedBytes = renderedBytes
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

    /// Drive the queue until empty. The host (MapleApp / MapleBackupAgent)
    /// runs this on a long-lived background Task.
    public func run() async {
        while let next = await queue.dequeue() {
            do {
                try await process(task: next)
            } catch {
                // Errors are handled inside process(task:) — state transitions
                // to .pending for retry or .failedRetry on exhaustion.
            }
        }
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
            await queue.enqueue(task, priority: task.priority)
            return
        }

        do {
            try await state.transition(task.id, to: .uploading)
            let read = try await reader.read(phassetLocalId: task.id.phassetLocalId)
            _ = try await upload.upload(
                phassetLocalId: task.id.phassetLocalId,
                filename: read.sidecar.originalFilename,
                captureDate: read.sidecar.captureDate,
                lat: read.sidecar.latitude,
                lon: read.sidecar.longitude,
                bytes: read.originalBytes,
                mapleId: read.mapleId)
            // On success, drop any App-Support sidecar (it lived only until upload).
            try? sidecars.delete(phassetLocalId: task.id.phassetLocalId)
            try await state.transition(task.id, to: .uploaded, error: nil)
        } catch {
            let nextRetry = task.retryCount + 1
            if nextRetry >= Self.maxRetries {
                try? await state.transition(task.id, to: .failedRetry,
                                            error: "max retries: \(error)")
            } else {
                try? await state.transition(task.id, to: .pending,
                                            error: "\(error)")
                // Re-enqueue from a detached Task that sleeps the backoff.
                let backoff = Self.backoffSeconds(for: nextRetry)
                let queueRef = queue
                Task.detached(priority: .background) {
                    try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                    var retry = task
                    retry.retryCount = nextRetry
                    await queueRef.enqueue(retry, priority: retry.priority)
                }
            }
            throw error
        }
    }

    /// Exponential backoff capped at 1 hour.
    private static func backoffSeconds(for retryCount: Int) -> TimeInterval {
        min(3600, pow(2.0, Double(retryCount)))
    }
}
