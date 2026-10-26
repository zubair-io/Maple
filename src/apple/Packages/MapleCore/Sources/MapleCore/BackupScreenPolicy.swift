// BackupScreenPolicy.swift
//
// Whether the iPhone/iPad screen stays awake, and whether the Light Table
// screen saver shows, while a Photos backup uploads (#5457). Pure inputs in,
// one decision out, so the app's controller only gathers state and applies
// the result.
//
//   - Nothing happens unless a backup is actually uploading and the user
//     left "Keep screen on during backup" enabled.
//   - Plugged in (charging or full): the screen stays on for as long as the
//     upload runs, and after `screenSaverDelay` without a touch the screen
//     saver appears (when enabled) — unless someone is using the app in a
//     way a touch count can't see: VoiceOver, Switch Control, or typing.
//   - On battery: the screen stays on only until `batteryAwakeLimit` passes
//     without a touch, then normal auto-lock resumes. No screen saver.

import Foundation

public struct BackupScreenPreferences: Equatable, Sendable {
  public var keepScreenOn: Bool
  public var screenSaverEnabled: Bool

  public static let keepScreenOnKey = "backup.screen.keepScreenOn"
  public static let screenSaverKey = "backup.screen.screenSaver"

  public init(keepScreenOn: Bool, screenSaverEnabled: Bool) {
    self.keepScreenOn = keepScreenOn
    self.screenSaverEnabled = screenSaverEnabled
  }

  /// Read from this device's own defaults, never synced: a screen saver
  /// suits a plugged-in iPad on a desk, not necessarily the user's phone.
  public static func load(from defaults: UserDefaults = .standard) -> BackupScreenPreferences {
    BackupScreenPreferences(
      keepScreenOn: defaults.object(forKey: keepScreenOnKey) as? Bool ?? true,
      screenSaverEnabled: defaults.object(forKey: screenSaverKey) as? Bool ?? true)
  }
}

public enum DevicePower: Equatable, Sendable {
  case battery
  case pluggedIn
}

public struct BackupScreenState: Equatable, Sendable {
  /// The backup engine is running (not stopped, not starting up).
  public let backupRunning: Bool
  /// Seconds since a photo was last being read or uploaded in this run, or
  /// nil when nothing has uploaded since the engine started.
  public let secondsSinceUpload: TimeInterval?
  public let power: DevicePower
  public let secondsSinceInteraction: TimeInterval
  /// VoiceOver, Switch Control or the keyboard is in use.
  public let assistedInputActive: Bool
  public let preferences: BackupScreenPreferences

  public init(
    backupRunning: Bool, secondsSinceUpload: TimeInterval?, power: DevicePower,
    secondsSinceInteraction: TimeInterval, assistedInputActive: Bool = false,
    preferences: BackupScreenPreferences
  ) {
    self.backupRunning = backupRunning
    self.secondsSinceUpload = secondsSinceUpload
    self.power = power
    self.secondsSinceInteraction = secondsSinceInteraction
    self.assistedInputActive = assistedInputActive
    self.preferences = preferences
  }
}

public struct BackupScreenDecision: Equatable, Sendable {
  public let keepScreenAwake: Bool
  public let showScreenSaver: Bool

  public init(keepScreenAwake: Bool, showScreenSaver: Bool) {
    self.keepScreenAwake = keepScreenAwake
    self.showScreenSaver = showScreenSaver
  }

  public static let released = BackupScreenDecision(keepScreenAwake: false, showScreenSaver: false)
}

public enum BackupScreenPolicy {
  /// The gap between one photo finishing and the next starting still counts
  /// as uploading, so the screen doesn't flicker toward auto-lock between
  /// photos. A retry backoff or a Wi-Fi wait longer than this releases it.
  public static let uploadGrace: TimeInterval = 30
  public static let screenSaverDelay: TimeInterval = 120
  public static let batteryAwakeLimit: TimeInterval = 600

  public static func isUploading(_ state: BackupScreenState) -> Bool {
    guard state.backupRunning, let since = state.secondsSinceUpload else { return false }
    return since <= uploadGrace
  }

  public static func decide(_ state: BackupScreenState) -> BackupScreenDecision {
    guard state.preferences.keepScreenOn, isUploading(state) else { return .released }
    let pluggedIn = state.power == .pluggedIn
    return BackupScreenDecision(
      keepScreenAwake: pluggedIn || state.secondsSinceInteraction < batteryAwakeLimit,
      showScreenSaver: pluggedIn && state.preferences.screenSaverEnabled
        && !state.assistedInputActive && state.secondsSinceInteraction >= screenSaverDelay)
  }
}
