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
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §15.

import Foundation
import OSLog
import MapleBackup
import MapleCore

private let log = Logger(subsystem: "app.justmaple.aperture", category: "Backup.EngineHost")

/// Build the authenticated transport the device-side backup clients use (#855).
///
/// The backup routes are gated behind `requireAuth`, so every backup request
/// must carry a Bearer access token. This wraps a `TokenStore`-backed
/// `AuthenticatedHTTPClient` (the same construction the rest of the app uses)
/// as the `AuthorizingTransport` closure the backup clients take — giving
/// Bearer injection plus single-flight 401-refresh-retry. One client per call,
/// matching the app's existing per-operation usage; `UploadClient`'s own chunk
/// loop reuses the one passed to it, so a token expiry mid-upload refreshes once.
///
/// A genuine refresh *rejection* clears the session (`TokenStore.clear`) —
/// correct for a dead/revoked refresh token. A transient network failure during
/// refresh throws *without* signing out, so a backup over a flaky link doesn't
/// bounce the foreground session.
func makeBackupTransport(server: URL) -> AuthorizingTransport {
    let client = AuthenticatedHTTPClient(
        server: server,
        urlSession: .shared,
        tokensProvider: { try? TokenStore.load(server: server) },
        // Mirror rotations into the File Provider store too — see CloudTokenPersistence.
        onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
        onSignOut: { CloudTokenPersistence.clear(server: server) },
        refreshExecutor: BackgroundExecution())
    return { try await client.data(for: $0) }
}

@MainActor
@Observable
public final class EngineHost {
    public static let shared = EngineHost()

    private(set) public var engine: BackupEngine?
    private(set) public var queue: any BackupQueue = InProcessBackupQueue()
    private(set) public var state: BackupStateStore?
    private(set) public var sidecars: AppSupportSidecarStore?

    /// Persistent progress view-model. Survives navigation — created once
    /// here so `BackupStatusPanel` reads the same instance regardless of how
    /// many times the panel appears and disappears.
    public let progress = BackupProgressViewModel()

    private var runnerTask: Task<Void, Never>?

    /// Long-running task that triggers a safety walk every 7 days.
    /// On iOS this is supplemented by the BGProcessingTask handler;
    /// on macOS this is the primary periodic mechanism.
    private var periodicWalkTask: Task<Void, Never>?

    /// Set when the most recent `start(settings:)` attempt failed. UI
    /// surfaces this in BackupStatusPanel so the user isn't left staring
    /// at a "No photos queued" panel wondering why nothing's happening.
    /// `nil` on success and before the first call.
    public private(set) var lastStartError: String?

    private init() {}

    /// Start (or restart) the engine against the given settings.
    /// Tears down any prior run, creates a fresh queue (so settings
    /// changes take effect), rehydrates persisted pending tasks, and
    /// launches a new runner Task.
    public func start(settings: BackupSettings) async {
        log.info("start(settings:) called serverURL=\(settings.serverURL, privacy: .public) libraryId=\(settings.libraryId, privacy: .public) wifiOnly=\(settings.wifiOnly)")
        guard settings.isConfigured else {
            log.error("start bail: settings.isConfigured == false (serverURL or libraryId empty)")
            lastStartError = "Settings incomplete — pick a server and library first."
            return
        }
        guard let serverBaseURL = URL(string: settings.serverURL) else {
            log.error("start bail: serverURL \(settings.serverURL, privacy: .public) is not a valid URL")
            lastStartError = "Server URL is not valid."
            return
        }
        lastStartError = nil

        // Surface "Restarting…" to the panel before the (potentially slow)
        // teardown + rehydrate so the user gets immediate feedback that their
        // tap registered. Flipped to `.running` once the runner is launched.
        progress.setPhase(.restarting)

        // Tear down any previous run (cancels retry tasks, then the runner).
        await stop()

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
            self.queue = queue

            // Subscribe to the new queue BEFORE rehydrating persisted tasks so
            // that every `.enqueued` event fired during rehydration is counted
            // in totalEnqueued. Subscribing after rehydration causes the
            // progress VM to miss those events and undercount on restart.
            progress.start(queue: queue)

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

            let effectiveServerURL = LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL)
            let upload = UploadClient(
                baseURL: effectiveServerURL,
                libraryId: settings.libraryId,
                deviceId: deviceId,
                transport: makeBackupTransport(server: serverBaseURL))

            let reader: any AssetReader = PhotoKitAssetReader(
                deviceId: deviceId,
                geocode: GeocodeClient(baseURL: effectiveServerURL))

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

            startPeriodicWalk(deviceId: deviceId, settings: settings,
                              libraryId: settings.libraryId, serverBaseURL: serverBaseURL)
            // Runner is live — flip the user-visible phase to Running.
            progress.setPhase(.running)
            log.info("start ok engine running, state initialized")
        } catch {
            // The most likely failures are filesystem permission issues or
            // SQLite open errors. Capture into `lastStartError` so the
            // BackupStatusPanel can show the user what went wrong instead
            // of silently leaving engine=nil and the queue empty.
            let msg = String(describing: error)
            log.error("start failed: \(msg, privacy: .public)")
            lastStartError = "Couldn't start backup: \(msg)"
            // The restart never produced a running engine — drop back to
            // Stopped so the panel doesn't show "Restarting…" forever.
            progress.setPhase(.stopped)
        }
    }

    /// User-initiated pause. Tears the runner down (same as `stop()`) but
    /// leaves the progress counters intact and clears the now-stale
    /// "Uploading now" tiles so the panel doesn't look frozen. The panel's
    /// Resume button calls `resume()` to pick work back up.
    public func pause() async {
        await stop()
        progress.markPaused()
    }

    /// User-initiated resume from a paused/stopped state. Loads the persisted
    /// settings and restarts the engine. If settings can't be loaded (deleted,
    /// corrupt, or never configured), surface a visible error via
    /// `lastStartError` instead of silently doing nothing — the old Resume
    /// button was a no-op in exactly this case, which is what made it feel
    /// broken. Does NOT pass retryFailed — Resume just picks up where Pause
    /// left off; retrying failures is the explicit "Restart Backup" action.
    public func resume() async {
        guard let settings = BackupSettings.load() else {
            log.error("resume bail: BackupSettings.load() returned nil")
            lastStartError = "Couldn't resume — backup settings are missing. Re-configure the destination and tap Start Backup."
            return
        }
        await start(settings: settings)
    }

    /// Cancel the runner and all pending retry tasks cleanly. Internal
    /// teardown used by both `start()` (restart) and `pause()`. Does not set a
    /// user-visible phase itself — callers own that (start → .restarting/.running,
    /// pause → .paused) so a restart's internal teardown doesn't flicker the
    /// status row.
    public func stop() async {
        // Await engine teardown so retry tasks are cancelled before the runner
        // task exits. This prevents a race where a retry re-enqueues after
        // the queue has been discarded by a subsequent start().
        if let engine {
            await engine.stop()
        }
        runnerTask?.cancel()
        runnerTask = nil
        periodicWalkTask?.cancel()
        periodicWalkTask = nil
        // Stop the progress VM so it detaches from the now-discarded queue.
        // `progress.start(queue:)` is idempotent — a subsequent start(settings:)
        // call will reattach to the new queue cleanly.
        progress.stop()
    }

    /// Start (or restart) the periodic safety walk timer.
    /// Fires every 7 days. On iOS the BGProcessingTask handler also triggers
    /// a walk on every background wake; this timer is the macOS fallback.
    private func startPeriodicWalk(deviceId: String, settings: BackupSettings,
                                   libraryId: String, serverBaseURL: URL) {
        periodicWalkTask?.cancel()
        periodicWalkTask = Task.detached(priority: .utility) {
            while !Task.isCancelled {
                // 7 days in nanoseconds.
                let sevenDays: UInt64 = 7 * 24 * 60 * 60 * 1_000_000_000
                try? await Task.sleep(nanoseconds: sevenDays)
                if Task.isCancelled { break }
                await ChangeObserverWiring.runWalk(deviceId: deviceId, settings: settings,
                                                   libraryId: libraryId, serverBaseURL: serverBaseURL)
            }
        }
    }
}
