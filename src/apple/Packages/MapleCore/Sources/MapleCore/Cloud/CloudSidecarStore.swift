// CloudSidecarStore.swift
//
// Remote analog of XMPSidecarStore. Mirrors the same surface
// (load/update/flush + 750ms debounce) but routes through
// GET/PUT /api/assets/:id/xmp instead of the local filesystem.

import Foundation

public actor CloudSidecarStore: SidecarStoreProtocol {
  private let server: URL
  private let assetID: String
  private let httpClient: AuthenticatedHTTPClient

  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?

  static let debounceInterval: Duration = .milliseconds(750)

  public init(server: URL, assetID: String, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.assetID = assetID
    self.httpClient = httpClient
  }

  public func load() async throws -> (AdjustmentModel, CullingState) {
    if let cached { return cached }
    let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/xmp"))
    let (data, resp) = try await httpClient.data(for: req)
    if let http = resp as? HTTPURLResponse, http.statusCode == 404 {
      let empty: (AdjustmentModel, CullingState) = (.default, CullingState())
      cached = empty
      return empty
    }
    try Self.checkOK(resp, data: data)
    let result = try XMPParser.parse(data: data)
    cached = result
    return result
  }

  public func update(model: AdjustmentModel, culling: CullingState) {
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    pendingTask?.cancel()
    pendingTask = Task { [weak self] in
      do {
        try await Task.sleep(for: CloudSidecarStore.debounceInterval)
        await self?.writePending()
      } catch {}
    }
  }

  public func flush() async {
    pendingTask?.cancel()
    pendingTask = nil
    await writePending()
  }

  // MARK: - Private

  private func writePending() async {
    guard let model = pendingModel, let culling = pendingCulling else { return }
    pendingModel = nil
    pendingCulling = nil
    do {
      let xml = XMPSerializer.serialize(model: model, culling: culling)
      var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/xmp"))
      req.httpMethod = "PUT"
      req.setValue("application/xml", forHTTPHeaderField: "Content-Type")
      req.httpBody = Data(xml.utf8)
      let (data, resp) = try await httpClient.data(for: req)
      try Self.checkOK(resp, data: data)
    } catch {
      // Best-effort retry; surface to UI in a future iteration.
      _ = error
    }
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudSidecarStore",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
