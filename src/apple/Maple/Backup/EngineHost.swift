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
  let client = makeBackupHTTPClient(server: server, urlSession: backupUploadSession)
  return { try await client.data(for: $0) }
}

/// Sees the backup's request bodies leave the device, so the screen saver can
/// tell a slow chunk that is still sending from a stalled one (#5457).
let backupTransfers = UploadTransferMonitor()
private let backupUploadSession = URLSession(
  configuration: .default, delegate: backupTransfers, delegateQueue: nil)

/// The authenticated client behind `makeBackupTransport`, also used by the
/// backup screen saver to read the library it is backing up into (#5457).
/// The screen saver's own reads stay off `backupUploadSession`, so they never
/// count as backup traffic.
func makeBackupHTTPClient(
  server: URL, urlSession: URLSession = .shared
) -> AuthenticatedHTTPClient {
  AuthenticatedHTTPClient(
    server: server,
    urlSession: urlSession,
    tokensProvider: { try? TokenStore.load(server: server) },
    // Mirror rotations into the File Provider store too — see CloudTokenPersistence.
    onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
    onSignOut: { CloudTokenPersistence.clear(server: server) },
    refreshExecutor: BackgroundExecution())
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
  /// Whether the engine may run: down while the app is leaving the foreground
  /// (the state DB refuses work so no lock is held at suspension, #5652) and
  /// while a panorama stitch holds a pause (#5653).
  private var runGate = BackupRunGate()
  private var suspensionRequested: Bool { runGate.isSuspended }
  public var isPausedForPanorama: Bool { runGate.isPaused }
  /// Every start and stop runs here, one at a time (#5022): a second Stop, a
  /// BGTask expiry or a new Start never interleaves with a teardown.
  private let lifecycle = SerialOperationQueue()
  /// A requested retry of failed photos survives a newer start superseding it.
  private var retryFailedRequested = false
  public private(set) var activeSettings: BackupSettings?
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
    // Supersedes any earlier start, even one still queued or waiting for the helper's lock.
    generation = UUID()
    let generation = self.generation
    retryFailedRequested = retryFailedRequested || retryFailed
    engineLockWait?.cancel()
    await lifecycle.run {
      await self.performStart(
        settings: settings, serverBaseURL: serverBaseURL, generation: generation)
    }
  }

  private func performStart(
    settings: BackupSettings, serverBaseURL: URL, generation: UUID
  ) async {
    guard generation == self.generation else { return }
    guard runGate.mayRun else {
      if runGate.isPaused, !BackupSettings.isStoppedByUser {
        progress.setPhase(.pausedForPanorama)
      }
      return
    }
    if progress.phase == .running && activeSettings == settings {
      retryFailedRequested = false
      return
    }

    // Surface "Starting…" to the panel before the (potentially slow)
    // teardown + rehydrate so the user gets immediate feedback that their
    // tap registered. Flipped to `.running` once the runner is launched.
    progress.setPhase(.starting)

    // Tear down any previous run (cancels the runner, then its retries).
    await tearDown()
    guard generation == self.generation else { return }
    progress.setPhase(.starting)

    do {
      let storageRoot = try BackupStorage.sharedRoot()
      #if os(macOS)
        // One engine per shared state DB (#4988): the backup helper may be
        // working through the backlog; never rehydrate rows it is uploading.
        guard let acquired = try await acquireEngineLock(in: storageRoot, generation: generation)
        else { return }
        let engineLock: BackupEngineLock? = acquired
      #else
        // Only macOS has a second backup host; holding a file lock in the App
        // Group container through suspension gets an iOS app killed (#5022).
        let engineLock: BackupEngineLock? = nil
      #endif
      // This start owns the lock until a running engine takes it. If stop()
      // supersedes it mid-startup, it keeps the lock while it still touches
      // the state DB and gives it back only when it bails, so the helper can
      // never start rehydrating alongside it.
      var lockHandedToEngine = false
      defer { if !lockHandedToEngine { engineLock?.release() } }
      guard generation == self.generation, runGate.mayRun else { return }
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
      if let snap = try? await state.startupSnapshot(deviceId: deviceId) {
        progress.recordLibrarySnapshot(
          photoIDs: snap.libraryPhotoIDs,
          backedUpIDs: snap.backedUpPhotoIDs)
      }

      guard generation == self.generation, runGate.mayRun else { return }
      try await state.rehydrate(into: queue)

      await LocalNetworkResolver.shared.resolve(identity: serverBaseURL)
      guard generation == self.generation else { return }
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
        geocode: GeocodeClient(baseURL: effectiveServerURL),
        includeLivePhotos: settings.includeLivePhotos)

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
      // Runner is live — flip the user-visible phase to Running, clearing
      // any failure an earlier, superseded start reported.
      lastStartError = nil
      progress.setPhase(.running)
      // Own initial discovery here, after the queue and runner are ready.
      let retryFailed = retryFailedRequested
      retryFailedRequested = false
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
    await stop(then: {})
  }

  private func stop(then afterTeardown: @escaping @MainActor () -> Void) async {
    generation = UUID()
    retryFailedRequested = false
    engineLockWait?.cancel()
    await lifecycle.run {
      await self.tearDown()
      afterTeardown()
    }
  }

  /// Stop the engine, then make the state DB refuse work, so no lock is held
  /// when iOS suspends the process (#5652). If the teardown outlasts 3 seconds
  /// the DB is suspended anyway: the in-flight write fails and its row is
  /// rehydrated on the next start.
  public func suspendStateStore() async {
    runGate.suspend()
    let backstop = Task { @MainActor in
      try await Task.sleep(for: .seconds(3))
      if self.suspensionRequested { BackupStateSuspension.suspend() }
    }
    await stop { if self.suspensionRequested { BackupStateSuspension.suspend() } }
    backstop.cancel()
  }

  /// Let the state DB take writes again. The caller restarts the engine.
  public func resumeStateStore() async {
    runGate.resume()
    await lifecycle.run {
      // A suspend queued behind this resume must win.
      if !self.suspensionRequested { BackupStateSuspension.resume() }
    }
  }

  /// Stop the backup and keep it stopped until the returned pause is released,
  /// so a panorama stitch has the process memory to itself (#5653). Pauses are
  /// counted: the backup restarts only when the last one is released, and not
  /// while the app is in the background. `stoppedRunningWork` tells the caller
  /// whether a running engine was actually taken down.
  public func pauseForPanorama() async -> (id: UUID, stoppedRunningWork: Bool) {
    let id = runGate.pause()
    let stoppedRunningWork = progress.phase == .running || progress.phase == .starting
    let alreadyPaused = progress.phase == .pausedForPanorama
    generation = UUID()
    engineLockWait?.cancel()
    await lifecycle.run {
      await self.tearDown()
      if self.runGate.isPaused, stoppedRunningWork || alreadyPaused {
        self.progress.setPhase(.pausedForPanorama)
      }
    }
    return (id, stoppedRunningWork)
  }

  /// Give one pause back. The last release restarts the backup unless the user
  /// stopped it or the app is in the background (`enterForeground` restarts it).
  public func releasePause(_ id: UUID) async {
    guard runGate.release(id) else { return }
    await lifecycle.run {
      if !self.runGate.isPaused, self.progress.phase == .pausedForPanorama {
        self.progress.setPhase(.stopped)
      }
    }
    await MapleApp.startBackupIfAuthorized()
  }

  private func tearDown() async {
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

  /// The engine lock, waiting for the background helper to finish when it holds
  /// it; `nil` when a stop or newer start superseded this one while waiting.
  private func acquireEngineLock(
    in storageRoot: URL, generation: UUID
  ) async throws -> BackupEngineLock? {
    if let free = try BackupEngineLock.acquire(in: storageRoot) { return free }
    // A superseded start must not wait: the newer start or stop is queued behind it.
    guard generation == self.generation else { return nil }
    lastStartError =
      "The background helper is finishing a backup. Maple will take over when it's done."
    let wait = Task {
      try await BackupEngineLock.acquireWhenFree(in: storageRoot, pollInterval: .seconds(2))
    }
    engineLockWait = wait
    // Cleared however the wait ends — a failed poll must not leave the
    // panel offering Stop for an engine that never started.
    defer { if engineLockWait == wait { engineLockWait = nil } }
    let waited = try await wait.value
    guard generation == self.generation else {
      waited.release()
      lastStartError = nil
      return nil
    }
    lastStartError = nil
    return waited
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
