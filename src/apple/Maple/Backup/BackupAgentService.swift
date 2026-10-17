// BackupAgentService.swift — #4718.
//
// Registers the embedded macOS backup helper with launchd through
// `SMAppService` whenever backup is configured and not stopped by the
// user, and unregisters it otherwise. The helper lives at
// `Contents/MacOS/MapleBackupAgent` with its launchd plist under
// `Contents/Library/LaunchAgents/` (both copied by the "Embed backup agent"
// build phase), which is the layout `SMAppService.agent(plistName:)`
// requires. iOS has no helper; the BGTask covers it there.

import Foundation
import MapleCore
import os

#if os(macOS)
  import ServiceManagement
#endif

enum BackupAgentService {
  static let plistName = "app.justmaple.aperture.backup.plist"

  /// The helper should be registered exactly when the app itself would run
  /// backup: configured settings and no explicit stop by the user.
  static func shouldBeRegistered(settings: BackupSettings?, stoppedByUser: Bool) -> Bool {
    guard let settings, settings.isConfigured else { return false }
    return !stoppedByUser
  }

  /// Brings launchd registration in line with the current settings. Safe to
  /// call repeatedly; both directions are idempotent in `SMAppService`.
  static func sync() {
    #if os(macOS)
      let wanted = shouldBeRegistered(
        settings: BackupSettings.load(), stoppedByUser: BackupSettings.isStoppedByUser)
      let agent = SMAppService.agent(plistName: plistName)
      do {
        if wanted, agent.status != .enabled {
          try agent.register()
        } else if !wanted, agent.status == .enabled {
          try agent.unregister()
        }
      } catch {
        let action = wanted ? "register" : "unregister"
        let reason = error.localizedDescription
        backupAgentLog.error(
          "backup helper \(action, privacy: .public): \(reason, privacy: .public)")
      }
    #endif
  }
}

private let backupAgentLog = Logger(subsystem: "app.justmaple.aperture", category: "backup-agent")
