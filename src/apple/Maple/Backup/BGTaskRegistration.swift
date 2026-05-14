// src/apple/Maple/Backup/BGTaskRegistration.swift
//
// iOS background task wiring for the BackupEngine. Registered at app launch
// (MapleApp init), scheduled when the app moves to background. iOS calls our
// handler opportunistically when the device is plugged in, charging, on
// Wi-Fi, etc.
//
// On macOS this file is compiled out — the LaunchAgent (MapleBackupAgent)
// covers background execution there.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §13, §15.

import Foundation
import MapleCore

#if canImport(BackgroundTasks) && os(iOS)
import BackgroundTasks

enum BGTaskRegistration {

  /// Must match INFOPLIST_KEY_BGTaskSchedulerPermittedIdentifiers on the
  /// Maple target.
  static let taskIdentifier = "app.justmaple.aperture.backup.refresh"

  /// Register the handler. Call once at app launch (MapleApp init).
  /// Idempotent — duplicate registration is silently ignored by BGTaskScheduler.
  static func register() {
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: taskIdentifier,
      using: nil
    ) { task in
      handle(task: task as! BGProcessingTask)
    }
  }

  /// Submit a request asking iOS to wake us up later. Call when the app
  /// moves to background (`.onChange(of: scenePhase)` → `.background`).
  /// The 1h earliestBeginDate is a hint; iOS schedules based on its own
  /// heuristics (charge state, network, recent use, etc.).
  static func schedule() {
    let request = BGProcessingTaskRequest(identifier: taskIdentifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    request.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      // Common failures: simulator (BGTaskScheduler unavailable) or hitting
      // the per-app submission quota. Silent in release; visible in debug.
      #if DEBUG
      print("BGTaskRegistration.schedule failed: \(error)")
      #endif
    }
  }

  private static func handle(task: BGProcessingTask) {
    // Always reschedule before doing work — if iOS yanks us mid-flight, the
    // next opportunity is already queued.
    schedule()

    let runner = Task { @MainActor in
      // Walk first so any new captures since the app last ran get enqueued,
      // then drain the queue. iOS limits execution time via the expiration
      // handler; the engine bails cleanly on cancellation.
      if let settings = BackupSettings.load(),
         let serverBaseURL = URL(string: settings.serverURL),
         let storage = try? DeviceIdentity.defaultStorageURL(),
         let deviceId = try? DeviceIdentity.current(storageURL: storage) {
        await ChangeObserverWiring.runWalk(deviceId: deviceId, settings: settings,
                                           libraryId: settings.libraryId,
                                           serverBaseURL: serverBaseURL)
      }
      if let engine = EngineHost.shared.engine {
        await engine.run()
      }
    }

    task.expirationHandler = {
      // iOS is about to suspend us; give the engine a chance to bail cleanly.
      runner.cancel()
    }

    Task {
      _ = await runner.value
      task.setTaskCompleted(success: !runner.isCancelled)
    }
  }
}

#else

/// macOS / non-iOS stub. The LaunchAgent (MapleBackupAgent) covers
/// background execution on macOS; mobile platforms use BGTaskScheduler.
enum BGTaskRegistration {
  static func register() {}
  static func schedule() {}
}

#endif
