import Foundation

/// #3617: immediate WatchConnectivity messages, never queued credential transfers.
/// The Watch generates the request ID; only its current request may install a grant.
public struct WatchPairingMessage: Codable, Sendable {
  public let kind: String
  public let requestID: UUID

  public init(kind: String, requestID: UUID) {
    self.kind = kind
    self.requestID = requestID
  }
}

public struct WatchPairingGrant: Codable, Sendable {
  public let id: UUID
  public let server: URL
  public let tokens: AuthTokens

  public init(id: UUID, server: URL, tokens: AuthTokens) {
    self.id = id
    self.server = server
    self.tokens = tokens
  }

  public var isValid: Bool {
    ["http", "https"].contains(server.scheme?.lowercased() ?? "")
      && server.host != nil && server.user == nil && server.password == nil
      && !tokens.access.isEmpty && !tokens.refresh.isEmpty
  }
}

public struct WatchPairingReply: Codable, Sendable {
  public let grant: WatchPairingGrant?
  public let error: String?

  public init(grant: WatchPairingGrant? = nil, error: String? = nil) {
    self.grant = grant
    self.error = error
  }
}

/// A reply is eligible only for the most recent, still-active local attempt.
/// Retrying the same wire ID still advances the generation to reject older callbacks.
public struct WatchPairingAttempt: Sendable {
  public private(set) var requestID: UUID?
  public private(set) var generation = 0

  public init() {}

  public mutating func begin(id: UUID) {
    generation &+= 1
    requestID = id
  }

  public mutating func cancel() {
    generation &+= 1
    requestID = nil
  }

  public func accepts(id: UUID, generation expected: Int) -> Bool {
    requestID == id && generation == expected
  }
}
