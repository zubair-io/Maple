// CloudSidecarStore.swift
//
// Remote analog of XMPSidecarStore. Mirrors the same surface
// (load/update/flush + 750ms debounce) but routes through
// GET/POST /api/xmp?path=… for folder refs, or GET/PUT
// /api/assets/:id/xmp for catalog refs, instead of the local filesystem.

import Foundation

public actor CloudSidecarStore: SidecarStoreProtocol {
  private let server: URL
  private let assetID: String
  private let httpClient: AuthenticatedHTTPClient

  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var writeTail: Task<Void, Error>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?

  /// Fields the remote sidecar carried that Maple does not model (#2233).
  /// The local store re-reads them off disk at write time; there is no disk
  /// here, so the bucket is captured on load and held for the lifetime of the
  /// session — the same shape `cached` already has.
  private var cachedPassthrough: XMPPassthrough = .empty
  private var cachedMetadata = XmpMetadata()

  private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
  private var nextSubscriberID: UInt64 = 0

  static let debounceInterval: Duration = .milliseconds(750)

  public init(server: URL, assetID: String, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.assetID = assetID
    self.httpClient = httpClient
  }

  public func load() async throws -> (AdjustmentModel, CullingState) {
    try await loadIfPresent() ?? (.default, CullingState())
  }

  public func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    if let cached { return cached }
    let req = URLRequest(url: sidecarURL)
    let (data, resp) = try await httpClient.data(for: req)
    if let http = resp as? HTTPURLResponse, http.statusCode == 404 {
      return nil
    }
    try Self.checkOK(resp, data: data)
    let result = try XMPParser.parse(data: data)
    cached = result
    cachedPassthrough = XMPParser.parsePassthrough(data: data)
    cachedMetadata = XMPParser.parseMetadata(String(decoding: data, as: UTF8.self))
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

  /// Returns an async stream of errors encountered during background writes.
  public func errors() -> AsyncStream<Error> {
    let id = nextSubscriberID
    nextSubscriberID &+= 1  // wrapping increment — prevents trap in long-lived processes
    return AsyncStream { continuation in
      subscribers[id] = continuation
      continuation.onTermination = { [weak self] _ in
        Task { [weak self] in
          await self?.removeSubscriber(id)
        }
      }
    }
  }

  private func removeSubscriber(_ id: UInt64) {
    subscribers.removeValue(forKey: id)
  }

  // MARK: - Private

  // Folder browsing identifies assets as fs:<absolute path>, not Mongo IDs.
  // Use the path endpoint so existing edits also work before indexing (#3357).
  private var sidecarURL: URL {
    guard assetID.hasPrefix("fs:") else {
      return server.appending(path: "/api/assets/\(assetID)/xmp")
    }
    var components = URLComponents(
      url: server.appending(path: "/api/xmp"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "path", value: String(assetID.dropFirst(3)))]
    return components.url!
  }

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = nil
    pendingCulling = nil

    cached = (model, culling)
    try await persist(model: model, culling: culling)
  }

  private func persist(model: AdjustmentModel, culling: CullingState) async throws {
    // Actor reentrancy must not let an older network write finish after a
    // confirmed batch write. Each real write waits for its predecessor.
    let previous = writeTail
    let task = Task {
      _ = await previous?.result
      try await send(model: model, culling: culling)
    }
    writeTail = task
    try await task.value
  }

  private func send(model: AdjustmentModel, culling: CullingState) async throws {
    // Metadata can change independently of this editor session. Preserve
    // the current sidecar's foreign XML and IPTC fields at the write boundary.
    let (bytes, response) = try await httpClient.data(for: URLRequest(url: sidecarURL))
    let absent = (response as? HTTPURLResponse)?.statusCode == 404
    if !absent { try Self.checkOK(response, data: bytes) }
    let existing: Data? = absent ? nil : bytes
    if let existing {
      _ = try XMPParser.parse(data: existing)
      cachedMetadata = XMPParser.parseMetadata(String(decoding: existing, as: UTF8.self))
      cachedPassthrough = XMPParser.parsePassthrough(data: existing)
    }
    let xml = XMPSerializer.serialize(
      model: model, culling: culling, metadata: cachedMetadata, passthrough: cachedPassthrough)
    var req = URLRequest(url: sidecarURL)
    req.httpMethod = assetID.hasPrefix("fs:") ? "POST" : "PUT"
    req.setValue("application/xml", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data(xml.utf8)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
  }

  private func writePending() async {
    guard let model = pendingModel, let culling = pendingCulling else { return }
    pendingModel = nil
    pendingCulling = nil
    do {
      try await persist(model: model, culling: culling)
    } catch {
      for subscriber in subscribers.values {
        subscriber.yield(error)
      }
    }
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(
        domain: "CloudSidecarStore",
        code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
        userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
