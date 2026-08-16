// EnrichmentConfigClient.swift — GET/PUT /api/enrichment/config, plus the
// three POST /test* probes (T5a, #2771).
//
// GET and the probes are `requireAuth`-only (member-readable); PUT is
// additionally `requireOwnerBeforeHandle` (src/api/src/routes/enrichment.ts)
// — a member genuinely gets 403 from `save`, same as CloudflareConfigClient.

import Foundation

public actor EnrichmentConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var configURL: URL { server.appending(path: "/api/enrichment/config") }
  private var testGeocodeURL: URL { server.appending(path: "/api/enrichment/test") }
  private var testMeiliURL: URL { server.appending(path: "/api/enrichment/test-meili") }
  private var testDescribeURL: URL { server.appending(path: "/api/enrichment/test-describe") }

  public func fetch() async throws -> EnrichmentConfig {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: configURL))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(EnrichmentConfig.self, from: data)
  }

  /// Persist one row's patch. Generic over the four patch types
  /// (`DescribeConfigPatch`, `TranscribeConfigPatch`, `GeocodeConfigPatch`,
  /// `MeilisearchConfigPatch`) since all four PUT the same endpoint and
  /// decode the same response — the row-scoping that keeps this safe lives
  /// in each patch type's `Encodable` conformance, not here.
  public func save<Patch: Encodable>(_ patch: Patch) async throws -> EnrichmentConfig {
    var request = URLRequest(url: configURL)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(EnrichmentConfig.self, from: data)
  }

  /// Probe a Nominatim URL without saving. `nominatimURL` must be non-empty
  /// — the server 400s an empty string (`TestBody` requires `minLength: 1`).
  public func testGeocode(nominatimURL: String) async throws {
    struct Body: Encodable { let nominatim_url: String }
    try await postTest(testGeocodeURL, body: Body(nominatim_url: nominatimURL))
  }

  /// Probe a Meilisearch URL without saving. `apiKey` is optional and
  /// write-only: pass a freshly-typed key to probe with it, or omit it to
  /// let the server fall back to the saved key / env var.
  public func testMeilisearch(url: String, apiKey: String?) async throws {
    struct Body: Encodable { let meilisearch_url: String; let api_key: String? }
    try await postTest(testMeiliURL, body: Body(meilisearch_url: url, api_key: apiKey))
  }

  /// Probe the Describe provider without saving. Provider is always
  /// `"ollama"` and model is always the locked `EnrichmentModels
  /// .describeModel` — this row has no provider picker (mirrors the
  /// hard-coded body in `workers.component.ts`'s `testConnection`). Unlike
  /// `testGeocode` / `testMeilisearch`, there is no blank-URL guard here —
  /// an empty URL is valid input and lets the server fall back to its own
  /// default Ollama endpoint.
  public func testDescribe(providerURL: String?) async throws {
    struct Body: Encodable { let provider: String; let url: String?; let model: String; let api_key: String? }
    try await postTest(
      testDescribeURL,
      body: Body(provider: "ollama", url: providerURL, model: EnrichmentModels.describeModel, api_key: nil))
  }

  /// Shared POST + decode + `ok`-check for the three probes above. A
  /// non-2xx status still throws via `ServerAdminError.from` first (request
  /// validation failures use 4xx); a 2xx with `ok: false` is the health
  /// check itself failing, which the endpoints report without an error
  /// status — see `EnrichmentTestResult`'s doc comment.
  private func postTest<Body: Encodable>(_ url: URL, body: Body) async throws {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    let result = try JSONDecoder().decode(EnrichmentTestResult.self, from: data)
    guard result.ok else {
      let statusCode = (resp as? HTTPURLResponse)?.statusCode ?? 200
      throw ServerAdminError(statusCode: statusCode, message: result.error ?? "Health check failed.")
    }
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> EnrichmentConfigClient {
    EnrichmentConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
