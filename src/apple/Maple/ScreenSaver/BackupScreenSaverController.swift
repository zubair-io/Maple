// BackupScreenSaverController.swift — applies `BackupScreenPolicy` on iPhone
// and iPad (#5457): holds the screen awake while a Photos backup uploads, and
// raises the Light Table screen saver in its own window above the app once a
// plugged-in device has been left alone. Runs only while the app is in the
// foreground; leaving it releases the screen and closes the screen saver.

#if os(iOS)
  import MapleBackup
  import MapleCore
  import SwiftUI
  import UIKit

  @MainActor
  final class BackupScreenSaverController {
    static let shared = BackupScreenSaverController()

    private var loop: Task<Void, Never>?
    private var lastInteraction = Date()
    private var holdsIdleTimer = false
    private var keyboardVisible = false
    private var visibleEditors: Set<UUID> = []
    private var saverWindow: UIWindow?
    private weak var windowBeforeSaver: UIWindow?
    #if DEBUG
      /// `MAPLE_SCREENSAVER_PREVIEW=1` shows the screen saver straight away,
      /// regardless of backup or power state, for visual checks on a
      /// simulator (which never reports a charging battery).
      private var previewRequested =
        ProcessInfo.processInfo.environment["MAPLE_SCREENSAVER_PREVIEW"] == "1"
    #endif

    private init() {
      NotificationCenter.default.addObserver(
        forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main
      ) { _ in
        MainActor.assumeIsolated { BackupScreenSaverController.shared.keyboardVisible = true }
      }
      NotificationCenter.default.addObserver(
        forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main
      ) { _ in
        MainActor.assumeIsolated { BackupScreenSaverController.shared.keyboardVisible = false }
      }
    }

    func setActive(_ active: Bool) {
      loop?.cancel()
      loop = nil
      guard active else {
        apply(.released)
        return
      }
      UIDevice.current.isBatteryMonitoringEnabled = true
      lastInteraction = Date()
      loop = Task { [weak self] in
        while !Task.isCancelled {
          self?.evaluate(now: Date())
          try? await Task.sleep(for: .seconds(1))
        }
      }
    }

    func editorAppeared(_ editor: UUID) {
      visibleEditors.insert(editor)
    }

    func editorDisappeared(_ editor: UUID) {
      visibleEditors.remove(editor)
    }

    private func recordInteraction() {
      lastInteraction = Date()
    }

    private func evaluate(now: Date) {
      trackTouches()
      let progress = EngineHost.shared.progress
      let state = BackupScreenState(
        backupRunning: progress.phase == .running,
        secondsSinceUpload: progress.lastUploadActivity.map { now.timeIntervalSince($0) },
        secondsSinceBytesSent: backupTransfers.secondsSinceBytesSent(at: now),
        power: Self.currentPower(),
        secondsSinceInteraction: now.timeIntervalSince(lastInteraction),
        assistedInputActive: keyboardVisible || UIAccessibility.isVoiceOverRunning
          || UIAccessibility.isSwitchControlRunning,
        editorVisible: !visibleEditors.isEmpty,
        preferences: .load())
      apply(previewDecision ?? BackupScreenPolicy.decide(state))
    }

    private var previewDecision: BackupScreenDecision? {
      #if DEBUG
        previewRequested ? BackupScreenDecision(keepScreenAwake: true, showScreenSaver: true) : nil
      #else
        nil
      #endif
    }

    private static func currentPower() -> DevicePower {
      switch UIDevice.current.batteryState {
      case .charging, .full: return .pluggedIn
      case .unplugged, .unknown: return .battery
      @unknown default: return .battery
      }
    }

    private func apply(_ decision: BackupScreenDecision) {
      if decision.keepScreenAwake != holdsIdleTimer {
        UIApplication.shared.isIdleTimerDisabled = decision.keepScreenAwake
        holdsIdleTimer = decision.keepScreenAwake
      }
      if decision.showScreenSaver {
        presentSaver()
      } else {
        dismissSaver()
      }
    }

    // MARK: - Touch tracking

    /// Attaches a touch observer to every app window in every foreground
    /// scene, including windows a new iPad scene brought along since the last
    /// check, so working in either half of Split View counts.
    private func trackTouches() {
      let untracked =
        foregroundScenes
        .flatMap(\.windows)
        .filter { window in
          window !== saverWindow
            && !(window.gestureRecognizers ?? []).contains { $0 is TouchActivityRecognizer }
        }
      for window in untracked {
        window.addGestureRecognizer(
          TouchActivityRecognizer { [weak self] in self?.recordInteraction() })
      }
    }

    private var foregroundScenes: [UIWindowScene] {
      UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .filter { $0.activationState == .foregroundActive }
    }

    // MARK: - Presentation

    private func presentSaver() {
      guard saverWindow == nil, let scene = foregroundScenes.first,
        let settings = EngineHost.shared.activeSettings ?? previewSettings,
        let source = BackupScreenSaverSource(settings: settings)
      else { return }
      let host = ScreenSaverHostingController(
        rootView: BackupScreenSaverView(
          source: source, progress: EngineHost.shared.progress,
          dismiss: { [weak self] in self?.dismissFromTouch() }))
      let window = UIWindow(windowScene: scene)
      window.windowLevel = .alert + 1
      window.rootViewController = host
      window.addGestureRecognizer(
        TouchActivityRecognizer { [weak self] in self?.dismissFromTouch() })
      window.alpha = 0
      windowBeforeSaver = scene.keyWindow
      window.makeKeyAndVisible()
      saverWindow = window
      UIView.animate(withDuration: 0.6) { window.alpha = 1 }
      UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    private var previewSettings: BackupSettings? {
      previewDecision == nil ? nil : BackupSettings.load()
    }

    private func dismissFromTouch() {
      #if DEBUG
        previewRequested = false
      #endif
      recordInteraction()
      dismissSaver()
    }

    private func dismissSaver() {
      guard let window = saverWindow else { return }
      saverWindow = nil
      windowBeforeSaver?.makeKey()
      UIView.animate(
        withDuration: 0.25, animations: { window.alpha = 0 },
        completion: { _ in
          // Detaching the hosting controller is what reliably ends the Light
          // Table's cycle; hiding the window alone may not disappear it.
          window.rootViewController = nil
          window.isHidden = true
        })
      UIAccessibility.post(notification: .screenChanged, argument: nil)
    }
  }

  /// Hides the status bar and home indicator while the screen saver shows.
  private final class ScreenSaverHostingController<Content: View>: UIHostingController<Content> {
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
  }
#endif
