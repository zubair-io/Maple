// CloudSource.swift
//
// `ImageSource` that talks to a Maple Cloud server scoped to one library
// (folder). Uses the canonical `/api/assets/*` and
// `/api/folders/:id/assets` paths. Replaces the broken SelfHostedSource.

import Foundation

public actor CloudSource {
  public let server: URL
  public let folderID: String
  private let httpClient: AuthenticatedHTTPClient
  private let session: URLSession

  public init(server: URL,
              folderID: String,
              httpClient: AuthenticatedHTTPClient,
              session: URLSession = .shared) {
    self.server = server
    self.folderID = folderID
    self.httpClient = httpClient
    self.session = session
  }

  // MARK: - URL helpers

  func url(_ path: String, query: [URLQueryItem] = []) -> URL {
    var c = URLComponents(url: server.appending(path: path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { c.queryItems = query }
    return c.url!
  }
}

extension CloudSource: ImageSource {
  public func images() async throws -> [ImageRef] {
    var refs: [ImageRef] = []
    var page = 1
    let limit = 200
    while true {
      let pageURL = url("/api/folders/\(folderID)/assets",
                        query: [URLQueryItem(name: "page", value: "\(page)"),
                                URLQueryItem(name: "limit", value: "\(limit)")])
      let req = URLRequest(url: pageURL)
      let (data, resp) = try await httpClient.data(for: req)
      try Self.checkOK(resp, data: data)
      let parsed: CloudAssetsPage
      do {
        parsed = try JSONDecoder().decode(CloudAssetsPage.self, from: data)
      } catch {
        let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
        cloudHTTPLogger.error("decode CloudAssetsPage failed (page \(page, privacy: .public), folder \(self.folderID, privacy: .public)): \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
        throw error
      }
      refs.append(contentsOf: parsed.assets.map { dto in
        ImageRef(id: dto.id, displayName: dto.filename, url: nil)
      })
      if parsed.assets.count < limit { break }
      page += 1
    }
    return refs
  }

  public func thumb(for ref: ImageRef) async throws -> Data? {
    try await getOrNilOn404(url("/api/assets/\(ref.id)/thumb"))
  }

  public func preview(for ref: ImageRef) async throws -> Data? {
    try await getOrNilOn404(url("/api/assets/\(ref.id)/preview"))
  }

  public func rawBytes(for ref: ImageRef) async throws -> Data {
    let req = URLRequest(url: url("/api/assets/\(ref.id)/raw"))
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    return data
  }

  public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
    let xml = XMPSerializer.serialize(model: sidecar.model, culling: sidecar.culling)
    var req = URLRequest(url: url("/api/assets/\(ref.id)/xmp"))
    req.httpMethod = "PUT"
    req.setValue("application/xml", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data(xml.utf8)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
  }

  public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }

  // MARK: - Helpers

  private func getOrNilOn404(_ url: URL) async throws -> Data? {
    let req = URLRequest(url: url)
    let (data, resp) = try await httpClient.data(for: req)
    if let http = resp as? HTTPURLResponse, http.statusCode == 404 { return nil }
    try Self.checkOK(resp, data: data)
    return data
  }

  static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudSource",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
