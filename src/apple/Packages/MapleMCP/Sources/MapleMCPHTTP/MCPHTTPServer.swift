import Foundation
import MapleAgentWire
import NIOCore
import NIOHTTP1
import NIOPosix

/// The app-owned, stateless Streamable HTTP endpoint. No LAN interfaces,
/// subprocesses, photo state, or independent editing implementation.
public actor MCPHTTPServer {
  public static let defaultPort: UInt16 = 49157
  public typealias Forward = @Sendable (AgentRequest) async throws -> AgentResponse

  private let forward: Forward
  private var group: MultiThreadedEventLoopGroup?
  private var listener: Channel?
  private var clients: MCPHTTPClients?

  public init(forward: @escaping Forward) { self.forward = forward }

  public func start(port: UInt16 = defaultPort, token: String) async throws -> URL {
    guard group == nil, !token.isEmpty else { throw ServerError.invalidStart }
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    let clients = MCPHTTPClients()
    self.group = group
    self.clients = clients
    let forward = forward
    do {
      let channel = try await ServerBootstrap(group: group)
        .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
        .childChannelInitializer { channel in
          guard clients.insert(channel) else { return channel.close() }
          channel.closeFuture.whenComplete { _ in clients.remove(channel) }
          return channel.pipeline.configureHTTPServerPipeline(withPipeliningAssistance: false)
            .flatMap {
              channel.pipeline.addHandler(
                MCPHTTPChannelHandler(token: token, forward: forward))
            }
        }
        .bind(host: "127.0.0.1", port: Int(port)).get()
      guard self.group === group else {
        try? await channel.close().get()
        throw CancellationError()
      }
      listener = channel
      guard let boundPort = channel.localAddress?.port,
        let url = URL(string: "http://127.0.0.1:\(boundPort)/mcp")
      else { throw ServerError.missingPort }
      return url
    } catch {
      if self.group === group { await stop() }
      throw error
    }
  }

  /// Close idle, reading, and responding connections as well as the listener.
  public func stop() async {
    let listener = listener
    let clients = clients
    let group = group
    self.listener = nil
    self.clients = nil
    self.group = nil
    try? await listener?.close().get()
    for channel in clients?.closeAll() ?? [] { try? await channel.close().get() }
    try? await group?.shutdownGracefully()
  }

  public enum ServerError: Error {
    case invalidStart, missingPort
  }
}

/// Channel initializers and close callbacks execute on NIO event loops,
/// independently of the server actor. Lock only the ownership registry.
private final class MCPHTTPClients: @unchecked Sendable {
  private let lock = NSLock()
  private var channels: [ObjectIdentifier: Channel] = [:]
  private var stopped = false

  func insert(_ channel: Channel) -> Bool {
    lock.withLock {
      guard !stopped, channels.count < 32 else { return false }
      channels[ObjectIdentifier(channel)] = channel
      return true
    }
  }

  func remove(_ channel: Channel) {
    _ = lock.withLock { channels.removeValue(forKey: ObjectIdentifier(channel)) }
  }

  func closeAll() -> [Channel] {
    lock.withLock {
      stopped = true
      let owned = Array(channels.values)
      channels.removeAll()
      return owned
    }
  }
}
