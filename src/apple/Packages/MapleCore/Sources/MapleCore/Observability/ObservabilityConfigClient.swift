// ObservabilityConfigClient.swift
//
// Typed wrapper over `GET /api/observability/config`. Mirrors
// CloudFoldersClient: an actor holding an AuthenticatedHTTPClient, one method
// per endpoint, structured decode-failure logging through the shared cloud
// HTTP logger.
//
// The fetched config carries the SigNoz ingestion key (a secret), so callers
// must persist it only via ObservabilityConfigCache (the same disk-cache
// location used for the rest of the cloud DTOs) and never log it.

import Foundation
import MapleCloudKit

public actor ObservabilityConfigClient {
    public nonisolated let server: URL
    private let httpClient: AuthenticatedHTTPClient

    public init(server: URL, httpClient: AuthenticatedHTTPClient) {
        self.server = server
        self.httpClient = httpClient
    }

    /// `GET /api/observability/config` — the resolved SigNoz/OTel runtime
    /// config for authenticated direct-to-SigNoz export.
    public func fetchConfig() async throws -> ObservabilityConfig {
        let url = server.appending(path: "/api/observability/config")
        let req = URLRequest(url: url)
        let (data, resp) = try await httpClient.data(for: req)
        try Self.checkOK(resp, data: data)
        do {
            return try JSONDecoder().decode(ObservabilityConfig.self, from: data)
        } catch {
            // Do NOT log a body preview here: this payload carries the SigNoz
            // ingestion key (a secret). Log only the byte count + decode error.
            cloudHTTPLogger.error("decode ObservabilityConfig failed: \(error.localizedDescription, privacy: .public) — \(data.count, privacy: .public)B body (not logged: contains ingestion key)")
            throw error
        }
    }

    private static func checkOK(_ resp: URLResponse, data: Data) throws {
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "ObservabilityConfigClient",
                          code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                          userInfo: [NSLocalizedDescriptionKey: body])
        }
    }
}
