// PanoServerClient.swift — the self-hosted server's panorama API (#5488):
// POST /api/pano/stitch and /api/pano/preview, GET/DELETE /api/pano/jobs/:id,
// GET /api/pano/jobs/:id/preview and GET /api/pano/config. The request body
// matches the web client's (maple-common pano.service.ts).

import Foundation

public struct PanoServerOptions: Codable, Sendable, Equatable {
  public let retention: String
  public let localAlign: String
  public let strategy: String?

  public init(retention: String, localAlign: String, strategy: String?) {
    self.retention = retention
    self.localAlign = localAlign
    self.strategy = strategy
  }
}

public struct PanoServerRequest: Codable, Sendable, Equatable {
  /// Server-side absolute paths, the reference the server prefers.
  public let assetPaths: [String]
  public let libraryId: String
  public let options: PanoServerOptions
  /// A finished preview job whose alignment the run starts from.
  public let alignmentFrom: String?

  public init(
    assetPaths: [String], libraryId: String, options: PanoServerOptions, alignmentFrom: String?
  ) {
    self.assetPaths = assetPaths
    self.libraryId = libraryId
    self.options = options
    self.alignmentFrom = alignmentFrom
  }
}

public struct PanoServerConfig: Decodable, Sendable, Equatable {
  public let enabled: Bool
  public let mapleCliPath: String?
  public let previewSupported: Bool

  enum CodingKeys: String, CodingKey {
    case enabled
    case mapleCliPath = "maple_cli_path"
    case previewSupported = "preview_supported"
  }

  public init(enabled: Bool, mapleCliPath: String?, previewSupported: Bool) {
    self.enabled = enabled
    self.mapleCliPath = mapleCliPath
    self.previewSupported = previewSupported
  }

  public var provisioned: Bool { enabled && mapleCliPath != nil }
}

public struct PanoServerJob: Decodable, Sendable, Equatable {
  public enum Status: String, Decodable, Sendable {
    case queued, running, done, failed, cancelled
  }

  public struct Progress: Decodable, Sendable, Equatable {
    public let current: Int
    public let total: Int

    public init(current: Int, total: Int) {
      self.current = current
      self.total = total
    }
  }

  public struct Alignment: Decodable, Sendable, Equatable {
    public let status: String
    public let staleReason: String?

    enum CodingKeys: String, CodingKey {
      case status
      case staleReason = "stale_reason"
    }

    public init(status: String, staleReason: String? = nil) {
      self.status = status
      self.staleReason = staleReason
    }
  }

  public struct Result: Decodable, Sendable, Equatable {
    public let outputAssetId: String?
    public let outputPath: String?
    public let alignment: Alignment?
    public let matcher: String?
    public let matcherNote: String?

    public init(
      outputAssetId: String? = nil, outputPath: String? = nil, alignment: Alignment? = nil,
      matcher: String? = nil, matcherNote: String? = nil
    ) {
      self.outputAssetId = outputAssetId
      self.outputPath = outputPath
      self.alignment = alignment
      self.matcher = matcher
      self.matcherNote = matcherNote
    }
  }

  public let id: String
  public let status: Status
  public let progress: Progress
  public let result: Result?
  public let error: String?

  public init(id: String, status: Status, progress: Progress, result: Result?, error: String?) {
    self.id = id
    self.status = status
    self.progress = progress
    self.result = result
    self.error = error
  }
}

/// A refusal from the pano API: `{ error: <code>, message }`.
public struct PanoServerError: Error, LocalizedError, Equatable, Sendable {
  public let statusCode: Int
  public let code: String?
  public let message: String

  public init(statusCode: Int, code: String?, message: String) {
    self.statusCode = statusCode
    self.code = code
    self.message = message
  }

  public var errorDescription: String? { message }

  private struct Envelope: Decodable {
    let error: String?
    let message: String?
  }

  static func from(data: Data, response: URLResponse) -> PanoServerError? {
    guard let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) else {
      return nil
    }
    let envelope = try? JSONDecoder().decode(Envelope.self, from: data)
    let message = envelope?.message ?? envelope?.error
      ?? "The server couldn’t make the panorama (status \(http.statusCode))."
    return PanoServerError(statusCode: http.statusCode, code: envelope?.error, message: message)
  }
}

/// The calls a server-side stitch makes, so the stitcher can be driven by a
/// fake in tests.
public protocol PanoServerJobs: Sendable {
  func config() async throws -> PanoServerConfig
  func stitch(_ body: PanoServerRequest) async throws -> String
  func preview(_ body: PanoServerRequest) async throws -> String
  func job(_ id: String) async throws -> PanoServerJob
  func cancel(_ id: String) async throws
  func previewImage(_ id: String) async throws -> Data
}

public actor PanoServerClient: PanoServerJobs {
  /// The server's registry identity; requests go to its best known address
  /// and fall back to the identity when that address stops answering.
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func config() async throws -> PanoServerConfig {
    try await decoded("/api/pano/config")
  }

  /// Creates a stitch job and returns its id.
  public func stitch(_ body: PanoServerRequest) async throws -> String {
    try await create("/api/pano/stitch", body)
  }

  /// Creates a preview job and returns its id; a newer one supersedes it.
  public func preview(_ body: PanoServerRequest) async throws -> String {
    try await create("/api/pano/preview", body)
  }

  public func job(_ id: String) async throws -> PanoServerJob {
    try await decoded(Self.jobPath(id))
  }

  public func cancel(_ id: String) async throws {
    _ = try await send(Self.jobPath(id), method: "DELETE")
  }

  /// The finished preview job's PNG.
  public func previewImage(_ id: String) async throws -> Data {
    try await send(Self.jobPath(id) + "/preview")
  }

  private func create(_ path: String, _ body: PanoServerRequest) async throws -> String {
    struct Created: Decodable { let id: String }
    let created: Created = try await decoded(path, method: "POST", body: try JSONEncoder().encode(body))
    return created.id
  }

  private func decoded<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil)
    async throws -> T
  {
    try JSONDecoder().decode(T.self, from: try await send(path, method: method, body: body))
  }

  /// A LAN address that has gone away (the device left home) falls back to
  /// the identity URL, so Try Again can reach the server from anywhere.
  private func send(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
    let identity = server
    let effective = await MainActor.run { LocalNetworkResolver.shared.effectiveURL(for: identity) }
    do {
      return try await send(path, method: method, body: body, base: effective)
    } catch is URLError where effective != identity {
      return try await send(path, method: method, body: body, base: identity)
    }
  }

  private func send(_ path: String, method: String, body: Data?, base: URL) async throws -> Data {
    var request = URLRequest(url: base.appending(path: path))
    request.httpMethod = method
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    let (data, response) = try await httpClient.data(for: request)
    if let error = PanoServerError.from(data: data, response: response) { throw error }
    return data
  }

  private static func jobPath(_ id: String) -> String { "/api/pano/jobs/\(id)" }
}
