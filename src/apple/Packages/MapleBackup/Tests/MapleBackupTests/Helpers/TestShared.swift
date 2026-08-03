// Tests/MapleBackupTests/Helpers/TestShared.swift
import Foundation
import XCTest
@testable import MapleBackup

// MARK: - BackupEngine test harness

/// Shared `BackupEngine` construction, split out of `BackupEngineTests` so
/// `BackupEngineSidecarTests` (and any other split-out suite) can build the
/// same harness without duplicating it.
func freshHarness() throws -> (BackupEngine, InProcessBackupQueue, BackupStateStore, AppSupportSidecarStore, StubAssetReader, URL) {
    let tmpRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("engine-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
    let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
    let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)

    let queue = InProcessBackupQueue()
    let state = try BackupStateStore(databaseURL: stateURL)
    let sidecars = AppSupportSidecarStore(root: sidecarRoot)
    let reader = StubAssetReader()
    let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                              libraryId: "lib", deviceId: "d",
                              transport: stubTransport())
    let engine = BackupEngine(queue: queue, state: state, upload: upload,
                              sidecars: sidecars, reader: reader)
    return (engine, queue, state, sidecars, reader, tmpRoot)
}

/// Variant exposing the #700 `companionBackoff` injection point. Returns the
/// 5 handles the companion tests need. `reader` defaults to the sidecar-only
/// `StubAssetReader`; pass e.g. `RenderedAssetReader()` to exercise a
/// companion that's always attempted regardless of local-edit state.
func freshHarness(
    companionBackoff: @escaping @Sendable (Int) -> TimeInterval,
    reader: any AssetReader = StubAssetReader()
) throws -> (BackupEngine, InProcessBackupQueue, BackupStateStore, AppSupportSidecarStore, URL) {
    let tmpRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("engine-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
    let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
    let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)

    let queue = InProcessBackupQueue()
    let state = try BackupStateStore(databaseURL: stateURL)
    let sidecars = AppSupportSidecarStore(root: sidecarRoot)
    let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                              libraryId: "lib", deviceId: "d",
                              transport: stubTransport())
    let engine = BackupEngine(queue: queue, state: state, upload: upload,
                              sidecars: sidecars, reader: reader,
                              companionBackoff: companionBackoff)
    return (engine, queue, state, sidecars, tmpRoot)
}

/// Convenience: a sequence stub for the standard two-request happy path
/// (ingest → 200+JSON, sidecar → 200 empty).
func ingestAndSidecarStub(mapleId: String = "hash-P1",
                          relPath: String = "2024/03/15/IMG.heic") -> StubURLProtocol.Stub {
    .sequence([
        .ok(json: #"{"maple_id":"\#(mapleId)","target_rel_path":"\#(relPath)"}"#),
        .status(200)
    ])
}

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
