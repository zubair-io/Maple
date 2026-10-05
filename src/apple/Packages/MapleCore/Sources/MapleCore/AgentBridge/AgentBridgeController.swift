// MCP is served by the macOS app through HTTP.
#if os(macOS)
  import Foundation
  import MapleAgentWire
  import Observation

  import MapleMCPHTTP

  /// Owns the app's local HTTP server. Off by default: the photographer
  /// opts in from Settings. Disabling access immediately invalidates queued
  /// HTTP calls and closes listeners and connections.
  @MainActor
  @Observable
  public final class AgentBridgeController {
    public static let shared = AgentBridgeController()
    public static let enabledDefaultsKey = "agentBridge.enabled"

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

    public func setupPrompt() throws -> String? {
      guard let httpURL, let authorizationToken else { return nil }
      return try MCPClientSetup.prompt(url: httpURL, token: authorizationToken)
    }

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
      enabled ? startHTTP() : stop()
    }

    func stop() {
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
    }

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
            "Could not start MCP on port \(port): \(error.localizedDescription). Close any other Maple MCP server and retry."
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

  }
#endif
