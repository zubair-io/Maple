// RenderConfig.swift — wire types + client for GET/PUT /api/render/config
// (T5b, #2772).
//
// The web GPU live-render ramp/kill switch (#1062). Config lives entirely in
// the database, no env-var fallback: the operator must be able to flip it
// without a restart. The Apple app's OWN GPU-live path is a separate,
// build-time/env kill switch (`GpuLiveFlag`, `MAPLE_GPU_LIVE`) — this saved
// value governs the web client, but the ServerAdmin panel surfaces it here so
// an operator managing a server from Maple Exposure has the same control the
// web Settings → Workers page does. The panel shows Apple's own
// `GpuLiveFlag.isEnabled` alongside it as "what this app is actually doing",
// mirroring the web panel's local-vs-saved split
// (gpu-live-render-settings.component.ts).

import Foundation

public struct RenderConfig: Decodable, Sendable, Equatable {
  public let gpuLiveRenderEnabled: Bool
  public let source: Source

  public struct Source: Decodable, Sendable, Equatable {
    public let gpuLiveRenderEnabled: SourceKind

    enum CodingKeys: String, CodingKey {
      case gpuLiveRenderEnabled = "gpu_live_render_enabled"
    }
  }

  public enum SourceKind: String, Decodable, Sendable {
    case db, `default`
  }

  enum CodingKeys: String, CodingKey {
    case gpuLiveRenderEnabled = "gpu_live_render_enabled"
    case source
  }
}

public struct RenderConfigPatch: Encodable, Sendable, Equatable {
  public let gpuLiveRenderEnabled: Bool?

  public init(gpuLiveRenderEnabled: Bool?) {
    self.gpuLiveRenderEnabled = gpuLiveRenderEnabled
  }

  enum CodingKeys: String, CodingKey {
    case gpuLiveRenderEnabled = "gpu_live_render_enabled"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(gpuLiveRenderEnabled, forKey: .gpuLiveRenderEnabled)
  }
}

public actor RenderConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var configURL: URL { server.appending(path: "/api/render/config") }

  public func fetch() async throws -> RenderConfig {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: configURL))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(RenderConfig.self, from: data)
  }

  public func save(_ patch: RenderConfigPatch) async throws -> RenderConfig {
    var request = URLRequest(url: configURL)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(RenderConfig.self, from: data)
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> RenderConfigClient {
    RenderConfigClient(server: server, httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
