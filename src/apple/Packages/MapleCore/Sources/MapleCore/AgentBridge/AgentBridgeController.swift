import Foundation
import MapleAgentWire
import Observation

/// Owns the agent socket for the app's lifetime. Off by default: the
/// photographer opts in from Settings, and turning it off closes the socket
/// immediately.
@MainActor
@Observable
public final class AgentBridgeController {
  public static let shared = AgentBridgeController()
  public static let enabledDefaultsKey = "agentBridge.enabled"

  public private(set) var isListening = false
  public private(set) var lastError: String?
  public private(set) var socketPath: String?

  @ObservationIgnored private var server: AgentSocketServer?
  @ObservationIgnored private let service: AgentEditService

  public init(service: AgentEditService = .shared) {
    self.service = service
  }

  public static var isEnabled: Bool {
    UserDefaults.standard.bool(forKey: enabledDefaultsKey)
  }

  /// Start or stop to match the stored preference.
  public func syncWithPreference() {
    setEnabled(Self.isEnabled)
  }

  public func setEnabled(_ enabled: Bool) {
    UserDefaults.standard.set(enabled, forKey: Self.enabledDefaultsKey)
    enabled ? start() : stop()
  }

  func start(path: String? = nil) {
    guard server == nil else { return }
    guard let path = path ?? Self.defaultSocketPath() else {
      lastError = "The Maple app-group container is unavailable."
      return
    }
    let service = service
    let server = AgentSocketServer(path: path) { request in
      await service.handle(request)
    }
    do {
      try server.start()
      self.server = server
      socketPath = path
      isListening = true
      lastError = nil
    } catch {
      lastError = String(describing: error)
      isListening = false
    }
  }

  func stop() {
    server?.stop()
    server = nil
    isListening = false
  }

  private static func defaultSocketPath() -> String? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: AgentSocketLocation.appGroup)
      .map(AgentSocketLocation.path(inGroupContainer:))
  }
}
