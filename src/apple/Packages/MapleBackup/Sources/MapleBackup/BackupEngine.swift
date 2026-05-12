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
// Retry / backoff policy is added in Phase 3 Task 3.13. This v0 engine
// surfaces upload failures as thrown errors; the caller drives the
// retry loop.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §15, §17.

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

    public init(queue: any BackupQueue,
                state: BackupStateStore,
                upload: UploadClient,
                sidecars: AppSupportSidecarStore,
                reader: any AssetReader) {
        self.queue = queue
        self.state = state
        self.upload = upload
        self.sidecars = sidecars
        self.reader = reader
    }

    /// Drive the queue until empty. The host (MapleApp / MapleBackupAgent)
    /// runs this on a long-lived background Task.
    public func run() async {
        while let next = await queue.dequeue() {
            do {
                try await process(task: next)
            } catch {
                // v0 surfaces errors; Phase 3's retry policy will mark the
                // task as failedRetry and re-enqueue with backoff.
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
        try await state.transition(task.id, to: .uploading)
        let read = try await reader.read(phassetLocalId: task.id.phassetLocalId)
        let captureDate = read.sidecar.captureDate
        let lat = read.sidecar.latitude
        let lon = read.sidecar.longitude
        let filename = read.sidecar.originalFilename
        _ = try await upload.upload(
            phassetLocalId: task.id.phassetLocalId,
            filename: filename,
            captureDate: captureDate,
            lat: lat,
            lon: lon,
            bytes: read.originalBytes,
            mapleId: read.mapleId)
        // On success, drop any App-Support sidecar (it lived only until upload).
        try? sidecars.delete(phassetLocalId: task.id.phassetLocalId)
        try await state.transition(task.id, to: .uploaded, error: nil)
    }
}
