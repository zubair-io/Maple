// DisplayConfigClient.swift — GET/PUT /api/display/config: how the server's Library listing is
// presented. The Apple Settings control 'Show one image for RAW+JPEG pairs' (#5050) is
// `stack_raw_jpeg` here, default on.

import Foundation

public struct DisplayConfig: Decodable, Equatable, Sendable {
  public let showHiddenImages: Bool
  /// On when the server omits it: a server older than the RAW+JPEG stack feature has no setting,
  /// and the preference defaults to on (#5050).
  public let stackRawJpeg: Bool

  public init(showHiddenImages: Bool, stackRawJpeg: Bool) {
    self.showHiddenImages = showHiddenImages
    self.stackRawJpeg = stackRawJpeg
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    showHiddenImages =
      try container.decodeIfPresent(Bool.self, forKey: .showHiddenImages) ?? false
    stackRawJpeg = try container.decodeIfPresent(Bool.self, forKey: .stackRawJpeg) ?? true
  }

  private enum CodingKeys: String, CodingKey {
    case showHiddenImages = "show_hidden_images"
    case stackRawJpeg = "stack_raw_jpeg"
  }
}

/// The PUT body. Every field is optional server-side; an absent one keeps its stored value.
public struct DisplayConfigPatch: Encodable, Equatable, Sendable {
  public var showHiddenImages: Bool?
  public var stackRawJpeg: Bool?

  public init(showHiddenImages: Bool? = nil, stackRawJpeg: Bool? = nil) {
    self.showHiddenImages = showHiddenImages
    self.stackRawJpeg = stackRawJpeg
  }

  private enum CodingKeys: String, CodingKey {
    case showHiddenImages = "show_hidden_images"
    case stackRawJpeg = "stack_raw_jpeg"
  }
}

public actor DisplayConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var configURL: URL { server.appending(path: "/api/display/config") }

  public func fetch() async throws -> DisplayConfig {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: configURL))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(DisplayConfig.self, from: data)
  }

  public func save(_ patch: DisplayConfigPatch) async throws {
    var request = URLRequest(url: configURL)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
  }
}
