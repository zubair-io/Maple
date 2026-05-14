// src/apple/Maple/Backup/EngineHost.swift
//
// Singleton boot for the device-side BackupEngine. Lives for the life of
// the process. MapleApp constructs it once and forgets about it; UI reads
// progress via `BackupQueue.observe()`.
//
// `start(settings:)` is the single entry point — called from MapleApp's
// `.task` modifier when the user has configured a server and library.
// `stop()` cancels the runner task; a later `start()` recreates the queue
// and state store so settings changes (different library, different server)
// take effect cleanly.
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

    /// Start (or restart) the engine against the given settings.
    /// Tears down any prior run, creates a fresh queue (so settings
    /// changes take effect), rehydrates persisted pending tasks, and
    /// launches a new runner Task.
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

        // Tear down any previous run (cancels retry tasks, then the runner).
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

            // Fresh queue per start — settings may have changed (different library).
            let queue = InProcessBackupQueue()

            // Rehydrate any persisted pending tasks so the engine resumes work
            // that was queued before a crash / settings change.
            for task in try await state.tasks(in: .pending) {
                await queue.enqueue(task, priority: task.priority)
            }
            // Any .uploading rows left by a crashed run go back to .pending.
            for task in try await state.tasks(in: .uploading) {
                try await state.transition(task.id, to: .pending)
                await queue.enqueue(task, priority: task.priority)
            }
            self.queue = queue

            let upload = UploadClient(
                baseURL: serverBaseURL,
                libraryId: settings.libraryId,
                deviceId: deviceId)

            let reader: any AssetReader = PhotoKitAssetReader(
                deviceId: deviceId,
                geocode: GeocodeClient(baseURL: serverBaseURL))

            let engine = BackupEngine(
                queue: queue,
                state: state,
                upload: upload,
                sidecars: sidecars,
                reader: reader,
                reachability: Reachability(),
                wifiOnly: settings.wifiOnly)
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

    /// Cancel the runner and all pending retry tasks cleanly.
    public func stop() {
        // Cancel retry tasks first so they don't re-enqueue after the runner exits.
        Task { await engine?.stop() }
        runnerTask?.cancel()
        runnerTask = nil
    }
}
