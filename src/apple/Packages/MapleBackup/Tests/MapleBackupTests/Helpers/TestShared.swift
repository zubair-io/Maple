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
