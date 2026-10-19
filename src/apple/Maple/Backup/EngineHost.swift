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
import MapleBackup
import MapleCore
import OSLog

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

  private var generation = UUID()
  private var activeSettings: BackupSettings?
  public private(set) var uploadAddress: URL?
  public private(set) var usesLocalAddress = false

  private var runnerTask: Task<Void, Never>?
  /// Held while this app runs the engine on the shared state DB (#4988).
  private var engineLock: BackupEngineLock?
  private var engineLockWait: Task<BackupEngineLock, Error>?
  /// Startup is parked until the background helper releases the engine lock;
  /// the panel keeps a Stop control available meanwhile.
  public var isWaitingForBackgroundHelper: Bool { engineLockWait != nil }

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
  public func start(settings: BackupSettings, retryFailed: Bool = false) async {
    log.info(
      "start(settings:) called serverURL=\(settings.serverURL, privacy: .public) libraryId=\(settings.libraryId, privacy: .public) wifiOnly=\(settings.wifiOnly)"
    )
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

    guard progress.phase != .starting else { return }
    if progress.phase == .running && activeSettings == settings { return }

    // Surface "Starting…" to the panel before the (potentially slow)
    // teardown + rehydrate so the user gets immediate feedback that their
    // tap registered. Flipped to `.running` once the runner is launched.
    progress.setPhase(.starting)

    // Tear down any previous run (cancels retry tasks, then the runner).
    await stop()
    let generation = self.generation
    progress.setPhase(.starting)

    do {
      let storageRoot = try BackupStorage.sharedRoot()
      // One engine per shared state DB (#4988): the backup helper may be
      // working through the backlog; never rehydrate rows it is uploading.
      // Wait for it to finish and take over, rather than staying stopped.
      let engineLock: BackupEngineLock
      if let free = try BackupEngineLock.acquire(in: storageRoot) {
        engineLock = free
      } else {
        lastStartError =
          "The background helper is finishing a backup. Maple will take over when it's done."
        let wait = Task {
          try await BackupEngineLock.acquireWhenFree(in: storageRoot, pollInterval: .seconds(2))
        }
        engineLockWait = wait
        let waited = try await wait.value
        if engineLockWait == wait { engineLockWait = nil }
        guard generation == self.generation else {
          waited.release()
          return
        }
        lastStartError = nil
        engineLock = waited
      }
      // This start owns the lock until a running engine takes it. If stop()
      // supersedes it mid-startup, it keeps the lock while it still touches
      // the state DB and gives it back only when it bails, so the helper can
      // never start rehydrating alongside it.
      var lockHandedToEngine = false
      defer { if !lockHandedToEngine { engineLock.release() } }
      let deviceId = try DeviceIdentity.current(
        storageURL: DeviceIdentity.storageURL(in: storageRoot))
      let sidecars = AppSupportSidecarStore(
        root: try AppSupportSidecarStore.defaultRoot(in: storageRoot))
      let state = try BackupStateStore(
        databaseURL: BackupStorage.stateDatabaseURL(
          in: storageRoot, filename: settings.stateDatabaseFilename))

      // Fresh queue per start — settings may have changed (different library).
      let queue = InProcessBackupQueue()
      self.queue = queue

      // Subscribe to the new queue BEFORE rehydrating persisted tasks so
      // that every `.enqueued` event fired during rehydration is counted
      // in totalEnqueued. Subscribing after rehydration causes the
      // progress VM to miss those events and undercount on restart.
      await progress.start(queue: queue)

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

      await LocalNetworkResolver.shared.resolve(identity: serverBaseURL)
      guard generation == self.generation, !Task.isCancelled else { return }
      let effectiveServerURL = LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL)
      uploadAddress = effectiveServerURL
      usesLocalAddress =
        LocalNetworkResolver.shared.status(for: serverBaseURL)?.isConnectedLocally == true
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
      activeSettings = settings
      self.engine = engine
      self.state = state
      self.sidecars = sidecars
      self.runnerTask = Task.detached(priority: .background) {
        await engine.run(keepAlive: true)
      }
      self.engineLock = engineLock
      lockHandedToEngine = true

      startPeriodicWalk(
        deviceId: deviceId, settings: settings,
        libraryId: settings.libraryId, serverBaseURL: serverBaseURL)
      // Runner is live — flip the user-visible phase to Running.
      progress.setPhase(.running)
      // Own initial discovery here, after the queue and runner are ready.
      // A second caller can return early while startup is in progress; it
      // must not subscribe early and lose the initial walk to the phase gate.
      ChangeObserverWiring.start(
        deviceId: deviceId, settings: settings,
        libraryId: settings.libraryId, serverBaseURL: serverBaseURL,
        retryFailed: retryFailed)
      log.info("start ok engine running, state initialized")
    } catch is CancellationError {
      // A stop() ended the wait for the background helper; nothing failed.
      lastStartError = nil
      return
    } catch {
      // The most likely failures are filesystem permission issues or
      // SQLite open errors. Capture into `lastStartError` so the
      // BackupStatusPanel can show the user what went wrong instead
      // of silently leaving engine=nil and the queue empty.
      let msg = String(describing: error)
      BackupIssueStatus.log(.error, "Backup startup failed: \(msg)")
      lastStartError = "Couldn't start backup. Check your server and storage settings."
      // The restart never produced a running engine — drop back to
      // Stopped so the panel doesn't show "Restarting…" forever.
      progress.setPhase(.stopped)
    }
  }

  /// Cancel discovery, active reads/uploads, and retries; pending work stays durable.
  public func stop() async {
    generation = UUID()
    engineLockWait?.cancel()
    engineLockWait = nil
    // Stop uploads first, so an explicit Stop takes effect at once even while
    // a library scan is still winding down.
    let runner = runnerTask
    runner?.cancel()
    if let engine { await engine.stop() }
    // Library walks upsert rows in the shared state DB: wait for them to
    // exit before the lock below is released to the helper (#4988).
    await ChangeObserverWiring.stopAndDrain()
    let periodicWalk = periodicWalkTask
    periodicWalkTask = nil
    periodicWalk?.cancel()
    await periodicWalk?.value
    await runner?.value
    // A companion operation already in flight can schedule a retry while
    // the runner drains. Sweep those late retries after it has fully exited.
    if let engine { await engine.stop() }
    runnerTask = nil
    engine = nil
    engineLock?.release()
    engineLock = nil
    // Stop the progress VM so it detaches from the now-discarded queue.
    // `progress.start(queue:)` is idempotent — a subsequent start(settings:)
    // call will reattach to the new queue cleanly.
    progress.stop()
    progress.setPhase(.stopped)
    progress.setWalkPhase(.idle)
  }

  /// Start (or restart) the periodic safety walk timer.
  /// Fires every 7 days. On iOS the BGProcessingTask handler also triggers
  /// a walk on every background wake; this timer is the macOS fallback.
  private func startPeriodicWalk(
    deviceId: String, settings: BackupSettings,
    libraryId: String, serverBaseURL: URL
  ) {
    periodicWalkTask?.cancel()
    periodicWalkTask = Task.detached(priority: .utility) {
      while !Task.isCancelled {
        // 7 days in nanoseconds.
        let sevenDays: UInt64 = 7 * 24 * 60 * 60 * 1_000_000_000
        try? await Task.sleep(nanoseconds: sevenDays)
        if Task.isCancelled { break }
        await ChangeObserverWiring.runWalk(
          deviceId: deviceId, settings: settings,
          libraryId: libraryId, serverBaseURL: serverBaseURL)
      }
    }
  }
}
