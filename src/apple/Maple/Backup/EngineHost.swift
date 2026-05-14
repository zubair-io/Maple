// src/apple/Maple/Backup/EngineHost.swift
//
// Singleton boot for the device-side BackupEngine. Lives for the life of
// the process. MapleApp constructs it once and forgets about it; UI reads
// progress via `BackupQueue.observe()`.
//
// `start(settings:)` is the single entry point — called from MapleApp's
// `.task` modifier when the user has configured a server and library.
// `stop()` cancels the runner task; the engine itself stays alive so a
// later `start` reuses the same queue and state store.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §15.

import Foundation
import MapleBackup
import MapleCore

@MainActor
public final class EngineHost {
    public static let shared = EngineHost()

    private(set) public var engine: BackupEngine?
    private(set) public var queue: any BackupQueue = InProcessBackupQueue()
    private(set) public var state: BackupStateStore?
    private(set) public var sidecars: AppSupportSidecarStore?
    private var runnerTask: Task<Void, Never>?

    private init() {}

    /// Start (or restart) the engine against the given settings. Idempotent
    /// — calling twice in a row with the same settings re-creates the runner
    /// without losing queued tasks (the queue is the same instance).
    public func start(settings: BackupSettings) async {
        guard settings.isConfigured else {
            // Not enough config to start — UI should already be showing the
            // "configure server / library" CTA. Silent no-op here.
            return
        }
        guard let serverBaseURL = URL(string: settings.serverURL) else {
            // Settings UI should validate; defensive bail.
            return
        }

        // Tear down any previous run.
        stop()

        do {
            let appSupport = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)
                .appendingPathComponent("Maple", isDirectory: true)
            try FileManager.default.createDirectory(
                at: appSupport, withIntermediateDirectories: true)

            let deviceId = try DeviceIdentity.current(
                storageURL: try DeviceIdentity.defaultStorageURL())
            let sidecars = AppSupportSidecarStore(
                root: try AppSupportSidecarStore.defaultRoot())
            let state = try BackupStateStore(
                databaseURL: appSupport.appendingPathComponent("backup-state.sqlite"))
            let upload = UploadClient(
                baseURL: serverBaseURL,
                libraryId: settings.libraryId,
                deviceId: deviceId)

            // Reader is wired in Task 3.2 (PhotoKitAssetReader). Until then,
            // the engine starts but immediately errors on its first task.
            let reader: any AssetReader = NullAssetReader()

            let engine = BackupEngine(
                queue: queue,
                state: state,
                upload: upload,
                sidecars: sidecars,
                reader: reader)
            self.engine = engine
            self.state = state
            self.sidecars = sidecars
            self.runnerTask = Task.detached(priority: .background) {
                await engine.run()
            }
        } catch {
            // The most likely failures are filesystem permission issues. We
            // surface them via the status panel by leaving engine = nil; the
            // UI shows "not running" + the last-error from the panel state.
            // For now, log to stderr.
            FileHandle.standardError.write(Data("EngineHost.start failed: \(error)\n".utf8))
        }
    }

    /// Cancel the runner. The engine + queue + state objects remain alive so
    /// a subsequent `start` can resume cleanly.
    public func stop() {
        runnerTask?.cancel()
        runnerTask = nil
    }
}

/// Fallback used when PhotoKitAssetReader is not yet wired (Task 3.2).
/// Never returns bytes — the engine just errors on its first task.
private actor NullAssetReader: AssetReader {
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        throw NSError(domain: "EngineHost", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "NullAssetReader: PhotoKitAssetReader not yet wired (Task 3.2)"])
    }
}
