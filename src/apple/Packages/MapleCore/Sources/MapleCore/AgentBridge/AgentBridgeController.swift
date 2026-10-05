import Foundation
import MapleAgentWire
import Observation

#if os(macOS)
  import MapleMCPHTTP
#endif

/// Owns the app's local agent transports. Off by default: the photographer
/// opts in from Settings. Disabling access immediately invalidates queued
/// HTTP calls and closes listeners and connections.
@MainActor
@Observable
public final class AgentBridgeController {
  public static let shared = AgentBridgeController()
  public static let enabledDefaultsKey = "agentBridge.enabled"

  public private(set) var isListening = false
  public private(set) var lastError: String?
  public private(set) var socketPath: String?
  #if os(macOS)
    public static let httpPortDefaultsKey = "agentBridge.httpPort"
    public private(set) var httpURL: URL?
    public private(set) var httpError: String?
    public private(set) var isHTTPStarting = false
    public private(set) var authorizationToken: String?
    @ObservationIgnored private var httpServer: MCPHTTPServer?
    @ObservationIgnored private var httpStartTask: Task<Void, Never>?
    @ObservationIgnored private var httpStopTask: Task<Void, Never>?
    @ObservationIgnored private var httpGeneration = 0

    public var httpPort: Int {
      let value = UserDefaults.standard.integer(forKey: Self.httpPortDefaultsKey)
      return (1024...65535).contains(value) ? value : Int(MCPHTTPServer.defaultPort)
    }

    public static var claudeExtensionURL: URL? { MCPClientSetup.claudeExtensionURL }

    public func codexConfiguration() -> String? {
      guard let httpURL, let authorizationToken else { return nil }
      return MCPClientSetup.codex(url: httpURL, token: authorizationToken)
    }

    public func cursorConfiguration() throws -> String? {
      guard let httpURL, let authorizationToken else { return nil }
      return try MCPClientSetup.cursor(url: httpURL, token: authorizationToken)
    }

    public func updateHTTPPort(_ port: Int) {
      guard (1024...65535).contains(port), port != httpPort else { return }
      UserDefaults.standard.set(port, forKey: Self.httpPortDefaultsKey)
      if Self.isEnabled {
        stop()
        setEnabled(true)
      }
    }
  #endif

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
    #if os(macOS)
      if enabled { startHTTP() }
    #endif
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
    #if os(macOS)
      httpGeneration &+= 1
      httpStartTask?.cancel()
      httpStartTask = nil
      let previousStop = httpStopTask
      let httpServer = httpServer
      httpStopTask = Task {
        await previousStop?.value
        await httpServer?.stop()
      }
      self.httpServer = nil
      httpURL = nil
      httpError = nil
      authorizationToken = nil
      isHTTPStarting = false
    #endif
    server?.stop()
    server = nil
    isListening = false
  }

  #if os(macOS)
    private func startHTTP() {
      guard httpServer == nil, !isHTTPStarting else { return }
      httpGeneration &+= 1
      let generation = httpGeneration
      let port = UInt16(httpPort)
      let previousStop = httpStopTask
      isHTTPStarting = true
      httpError = nil
      httpStartTask = Task {
        await previousStop?.value
        guard generation == httpGeneration else { return }
        do {
          let token = try await AgentMCPTokenStore.shared.loadOrCreate()
          guard generation == httpGeneration else { return }
          let httpServer = MCPHTTPServer { [weak self] request in
            guard let self else {
              return AgentResponse(
                id: request.id,
                outcome: .failure(
                  AgentError(code: "agent_access_disabled", message: "MCP access is off.")))
            }
            return await self.handleHTTP(request, generation: generation)
          }
          self.httpServer = httpServer
          let url = try await httpServer.start(port: port, token: token)
          guard generation == httpGeneration else {
            await httpServer.stop()
            return
          }
          authorizationToken = token
          httpURL = url
          isHTTPStarting = false
        } catch {
          guard generation == httpGeneration else { return }
          httpServer = nil
          isHTTPStarting = false
          httpError =
            "Could not start MCP on port \(port): \(error.localizedDescription). Check the port and try again."
        }
      }
    }

    private func handleHTTP(_ request: AgentRequest, generation: Int) async -> AgentResponse {
      guard generation == httpGeneration, Self.isEnabled else {
        return AgentResponse(
          id: request.id,
          outcome: .failure(
            AgentError(code: "agent_access_disabled", message: "MCP access is off.")))
      }
      return await service.handle(request)
    }
  #endif

  private static func defaultSocketPath() -> String? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: AgentSocketLocation.appGroup)
      .map(AgentSocketLocation.path(inGroupContainer:))
  }
}
