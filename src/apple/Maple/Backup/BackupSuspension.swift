import MapleBackup

#if os(iOS)
  /// The app is leaving the foreground: stop the backup and quiesce its state
  /// DB while a short background assertion keeps the process alive, so iOS
  /// never suspends it mid-commit (#5652).
  @MainActor
  enum BackupSuspension {
    static func enterBackground() async {
      let assertion = BackgroundTaskAssertion()
      let granted = assertion.begin(name: "app.justmaple.aperture.backup-suspend") {
        BackupStateSuspension.suspend()
        assertion.end()
      }
      if !granted { BackupStateSuspension.suspend() }
      await EngineHost.shared.suspendStateStore()
      assertion.end()
    }

    static func enterForeground() async {
      await EngineHost.shared.resumeStateStore()
      await MapleApp.startBackupIfAuthorized()
    }
  }
#endif
