// Tests/MapleBackupTests/Helpers/TestShared.swift
import Foundation
import XCTest
@testable import MapleBackup

actor StubAssetReader: AssetReader {
    var readCount = 0
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        readCount += 1
        return AssetReadResult(
            originalBytes: Data(count: 256),
            renderedBytes: nil,
            sidecar: PayloadAssembler.SidecarInput(
                phassetLocalId: phassetLocalId,
                deviceId: "d",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                latitude: nil, longitude: nil,
                favorite: false, caption: nil,
                keywords: [], tags: [],
                livePhotoCompanion: nil, burstStackId: nil,
                originalFilename: "IMG.heic",
                mtime: 0),
            mapleId: "hash-\(phassetLocalId)")
    }
}

actor FailingAssetReader: AssetReader {
    enum FailError: Error { case forced }
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        throw FailError.forced
    }
}

/// Supplies non-empty `renderedBytes` (Apple-rendered JPEG twin) — the
/// rendered companion is attempted unconditionally whenever it's present, so
/// this reader lets tests exercise that companion path without a local edit.
actor RenderedAssetReader: AssetReader {
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        return AssetReadResult(
            originalBytes: Data(count: 256),
            renderedBytes: Data(count: 64),
            sidecar: PayloadAssembler.SidecarInput(
                phassetLocalId: phassetLocalId,
                deviceId: "d",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                latitude: nil, longitude: nil,
                favorite: false, caption: nil,
                keywords: [], tags: [],
                livePhotoCompanion: nil, burstStackId: nil,
                originalFilename: "IMG.heic",
                mtime: 0),
            mapleId: "hash-\(phassetLocalId)")
    }
}

actor LivePhotoAssetReader: AssetReader {
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        return AssetReadResult(
            originalBytes: Data(count: 256),
            renderedBytes: nil,
            liveVideoBytes: Data(count: 128),
            liveVideoFilename: "IMG.mov",
            sidecar: PayloadAssembler.SidecarInput(
                phassetLocalId: phassetLocalId,
                deviceId: "d",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                latitude: nil, longitude: nil,
                favorite: false, caption: nil,
                keywords: [], tags: [],
                livePhotoCompanion: "IMG.mov", burstStackId: nil,
                originalFilename: "IMG.heic",
                mtime: 0),
            mapleId: "hash-\(phassetLocalId)")
    }
}

/// Thread-safe "resume exactly once" gate for racing two unstructured Tasks
/// past a single `CheckedContinuation` — see `awaitBounded(_:timeout:)`.
final class ResumeOnceGate: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    /// Returns `true` for the first caller only; every later caller gets
    /// `false`, so a slow winner racing a timeout can't double-resume.
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !claimed else { return false }
        claimed = true
        return true
    }
}

/// Await an async `operation` or give up after `timeout`, returning `nil` on
/// timeout — a regression that genuinely hangs `operation` forever must fail
/// the test fast, not stall the whole suite.
///
/// Deliberately NOT a `withTaskGroup`: a group's closure doesn't return until
/// every child task finishes, and `cancelAll()` only sets a flag — it can't
/// force a child to stop early. A child awaiting a truly stuck operation
/// (e.g. a stranded `CheckedContinuation`, exactly the class of bug this
/// exists to catch) ignores that flag and never returns, so a TaskGroup-based
/// version of this helper hangs right alongside the bug it's meant to report
/// on. Racing two independent, unstructured `Task`s past a single
/// `resume`-once continuation avoids that: whichever fires first wins, and
/// the loser is simply abandoned rather than awaited.
func awaitBounded<T: Sendable>(timeout: TimeInterval,
                               _ operation: @escaping @Sendable () async -> T) async -> T? {
    let gate = ResumeOnceGate()
    return await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
        Task {
            let result = await operation()
            if gate.claim() { continuation.resume(returning: result) }
        }
        Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            if gate.claim() { continuation.resume(returning: nil) }
        }
    }
}

/// Thread-safe sink that drains a queue's event stream into a list so a test
/// can assert which companion-lifecycle events fired and in what order.
final class EventSink: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [BackupQueueEvent] = []
    private var task: Task<Void, Never>?

    func attach(to queue: InProcessBackupQueue) async {
        let stream = await queue.observe()
        task = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.lock.lock(); self.events.append(event); self.lock.unlock()
            }
        }
    }
    func stop() { task?.cancel() }
    var snapshot: [BackupQueueEvent] {
        lock.lock(); defer { lock.unlock() }; return events
    }
    func count(where pred: (BackupQueueEvent) -> Bool) -> Int {
        snapshot.filter(pred).count
    }
}
