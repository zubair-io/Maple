import Foundation

#if canImport(UIKit) && !os(watchOS)
  import UIKit
#elseif os(watchOS)
  import WatchKit
#endif

// Notification-only because this package is also linked by app extensions,
// which have no shared application object.
enum AppActivity {
  static var initiallyActive: Bool {
    guard !isExtension(bundlePath: Bundle.main.bundlePath) else { return false }
    #if canImport(UIKit) && !os(watchOS) && !os(macOS)
      // A background launch (a backup task) has no activation notification until the user opens the app.
      return Thread.isMainThread
        ? MainActor.assumeIsolated { UIApplication.shared.applicationState == .active } : true
    #else
      return true
    #endif
  }

  static func isExtension(bundlePath: String) -> Bool {
    bundlePath.hasSuffix(".appex")
  }

  // macOS stays active: a Mac whose app is not frontmost is still on its
  // network, and it has no background state that gates the Local Network prompt.
  static var trackedChanges: (@Sendable () -> AsyncStream<Bool>)? {
    #if os(macOS)
      return nil
    #else
      guard initiallyActive else { return nil }
      return { changes() }
    #endif
  }

  // One observer per notification, all yielding into a single stream, so
  // background and active arrive in the order they were posted.
  static func changes() -> AsyncStream<Bool> {
    AsyncStream { continuation in
      let center = NotificationCenter.default
      nonisolated(unsafe) let tokens = signals.map { name, isActive in
        center.addObserver(forName: name, object: nil, queue: nil) { _ in
          continuation.yield(isActive)
        }
      }
      continuation.onTermination = { _ in
        for token in tokens { center.removeObserver(token) }
      }
    }
  }

  private static var signals: [(Notification.Name, Bool)] {
    #if canImport(UIKit) && !os(watchOS)
      [
        (UIApplication.didBecomeActiveNotification, true),
        (UIApplication.didEnterBackgroundNotification, false),
      ]
    #elseif os(watchOS)
      [
        (WKApplication.didBecomeActiveNotification, true),
        (WKApplication.didEnterBackgroundNotification, false),
      ]
    #else
      []
    #endif
  }
}
