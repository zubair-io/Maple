// CloudSidecarStore.swift
//
// Remote analog of XMPSidecarStore. Mirrors the same surface
// (load/update/flush + 750ms debounce) but routes through
// GET/POST /api/xmp?path=… for folder refs, or GET/PUT
// /api/assets/:id/xmp for catalog refs, instead of the local filesystem.

import Foundation

public actor CloudSidecarStore: WorkflowSidecarStoreProtocol {
  let server: URL
  private let assetID: String
  let httpClient: AuthenticatedHTTPClient
  let renderSidecar = WorkflowRenderSidecar()
  private let variantId: String

  private var cacheGeneration: UInt64 = 0
  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var writeTail: Task<Void, Error>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?
  private var pendingSemanticEdits: [CapturedCloudEdit] = []
  private var workflowPath: String?

  private struct CapturedCloudEdit: Sendable {
    let id: String
    let createdAtMs: UInt64
    let action: String
    let label: String
    let model: AdjustmentModel
    let culling: CullingState
  }

  /// Fields the remote sidecar carried that Maple does not model (#2233).
  /// The local store re-reads them off disk at write time; there is no disk
  /// here, so the bucket is captured on load and held for the lifetime of the
  /// session — the same shape `cached` already has.
  private var cachedPassthrough: XMPPassthrough = .empty
  private var cachedMetadata = XmpMetadata()

  private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
  private var nextSubscriberID: UInt64 = 0

  static let debounceNanoseconds: UInt64 = 750_000_000
  static let debounceInterval: Duration = .nanoseconds(debounceNanoseconds)

  public init(server: URL, assetID: String, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.assetID = assetID
    self.httpClient = httpClient
    self.variantId = WorkflowContract.primaryVariantID
  }

  private init(
    server: URL, assetID: String, httpClient: AuthenticatedHTTPClient,
    variantId: String, workflowPath: String
  ) {
    self.server = server
    self.assetID = assetID
    self.httpClient = httpClient
    self.variantId = variantId
    self.workflowPath = workflowPath
  }

  /// A new immutable writer has its own save queue; derive the original path from this asset (#4063).
  public func variantWriter(variantId: String) async throws -> CloudSidecarStore {
    _ = try WorkflowSidecarCore.variantFilename(primaryName: "photo.xmp", variantId: variantId)
    _ = try await readWorkflowXML()
    let path = try await resolvedWorkflowPath()
    let writer = CloudSidecarStore(
      server: server, assetID: assetID, httpClient: httpClient,
      variantId: variantId, workflowPath: path)
    _ = try await writer.readWorkflowXML()
    return writer
  }

  public func load() async throws -> (AdjustmentModel, CullingState) {
    try await loadIfPresent() ?? (.default, CullingState())
  }

  public func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    if let cached { return cached }
    let generation = cacheGeneration
    let req = URLRequest(url: try sidecarURL)
    let (data, resp) = try await httpClient.data(for: req)
    if let http = resp as? HTTPURLResponse, http.statusCode == 404 {
      if generation == cacheGeneration { try requireIsPrimaryVariant() }
      return generation == cacheGeneration ? nil : cached
    }
    try Self.checkOK(resp, data: data)
    _ = try selectedWorkflow(String(decoding: data, as: UTF8.self))
    let result = try XMPParser.parse(data: data)
    guard generation == cacheGeneration else { return cached ?? result }
    try renderSidecar.write(String(decoding: data, as: UTF8.self))
    cached = result
    cachedPassthrough = XMPParser.parsePassthrough(data: data)
    cachedMetadata = XMPParser.parseMetadata(String(decoding: data, as: UTF8.self))
    return result
  }

  public func update(model: AdjustmentModel, culling: CullingState) {
    cacheGeneration &+= 1
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    pendingTask?.cancel()
    pendingTask = Task { [weak self] in
      do {
        try await Task.sleep(nanoseconds: CloudSidecarStore.debounceNanoseconds)
        await self?.writePending()
      } catch {}
    }
  }

  public func flush() async {
    let task = pendingTask
    pendingTask = nil
    task?.cancel()
    _ = await task?.result
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
    get throws {
      if variantId != WorkflowContract.primaryVariantID {
        guard let workflowPath else { throw URLError(.badURL) }
        return try workflowURL(path: workflowPath, commit: false)
      }
      guard assetID.hasPrefix("fs:") else {
        return server.appending(path: "/api/assets/\(assetID)/xmp")
      }
      var components = URLComponents(
        url: server.appending(path: "/api/xmp"), resolvingAgainstBaseURL: false)!
      components.queryItems = [URLQueryItem(name: "path", value: String(assetID.dropFirst(3)))]
      return components.url!
    }
  }

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    let task = pendingTask
    pendingTask = nil
    task?.cancel()
    _ = await task?.result
    pendingModel = nil
    pendingCulling = nil

    cacheGeneration &+= 1
    cached = (model, culling)
    try await persist(model: model, culling: culling)
  }

  /// Freeze a real edit boundary before any network suspension (#4056).
  public func commitSemantic(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) async throws {
    let captured = CapturedCloudEdit(
      id: UUID().uuidString.lowercased(),
      createdAtMs: UInt64(Date().timeIntervalSince1970 * 1000),
      action: action, label: label, model: model, culling: culling)
    let checkpoint = XMPSerializer.serialize(model: model, culling: culling)
    _ = try WorkflowSidecarCore.commit(
      historyEntry(captured, checkpoint: checkpoint), in: checkpoint)
    pendingSemanticEdits.append(captured)
    if pendingSemanticEdits.count > WorkflowContract.historyLimit {
      pendingSemanticEdits.removeFirst(pendingSemanticEdits.count - WorkflowContract.historyLimit)
    }
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = model
    pendingCulling = culling
    cacheGeneration &+= 1
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
    try await publishSemanticEdits()
    // Metadata can change independently of this editor session. Preserve
    // the current sidecar's foreign XML and IPTC fields at the write boundary.
    let (bytes, response) = try await httpClient.data(for: URLRequest(url: try sidecarURL))
    let absent = (response as? HTTPURLResponse)?.statusCode == 404
    if absent { try requireIsPrimaryVariant() }
    if !absent { try Self.checkOK(response, data: bytes) }
    if absent {
      cachedMetadata = XmpMetadata()
      cachedPassthrough = .empty
    }
    let existing: Data? = absent ? nil : bytes
    var savedModel = model
    savedModel.inpaintRemovals = try RemovalXMPRecords.ordinaryWriteRecords(existing)
    if let existing {
      let currentXML = String(decoding: existing, as: UTF8.self)
      _ = try XMPParser.parse(data: existing)
      _ = try selectedWorkflow(currentXML)
      cachedMetadata = XMPParser.parseMetadata(currentXML)
      cachedPassthrough = XMPParser.parsePassthrough(data: existing)
    }
    let xml = XMPSerializer.serialize(
      model: savedModel, culling: culling, metadata: cachedMetadata, passthrough: cachedPassthrough)
    var req = URLRequest(url: try sidecarURL)
    req.httpMethod =
      variantId == WorkflowContract.primaryVariantID && assetID.hasPrefix("fs:") ? "POST" : "PUT"
    req.setValue("application/xml", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data(xml.utf8)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    // Path writes return their preserved XMP; catalog writes acknowledge in JSON.
    let published = String(data: data, encoding: .utf8)
    try renderSidecar.write(published?.hasPrefix("<") == true ? published! : xml)
    if cached?.0 == model, cached?.1 == culling { cached = (savedModel, culling) }
  }

  private func writePending() async {
    guard let model = pendingModel, let culling = pendingCulling else { return }
    pendingModel = nil
    pendingCulling = nil
    do {
      try await persist(model: model, culling: culling)
    } catch {
      if pendingModel == nil {
        pendingModel = model
        pendingCulling = culling
      }
      for subscriber in subscribers.values {
        subscriber.yield(error)
      }
    }
  }

  public func readWorkflowXML() async throws -> String? {
    try await enqueueWorkflow(nil)
  }

  public func publishWorkflow(_ command: WorkflowPublication) async throws -> String {
    guard let xml = try await enqueueWorkflow(command) else {
      throw WorkflowSidecarError(message: "The server did not confirm the checkpoint.")
    }
    return xml
  }

  /// Actual reads and complete-XMP publication join the same tail as ordinary edits.
  private func enqueueWorkflow(_ command: WorkflowPublication?) async throws -> String? {
    pendingTask?.cancel()
    pendingTask = nil
    let model = pendingModel
    let culling = pendingCulling
    pendingModel = nil
    pendingCulling = nil
    let previous = writeTail
    let task = Task {
      _ = await previous?.result
      if let model, let culling {
        do { try await self.send(model: model, culling: culling) } catch {
          if self.pendingModel == nil {
            self.pendingModel = model
            self.pendingCulling = culling
          }
          throw error
        }
      }
      let path = try await self.resolvedWorkflowPath()
      let current = try await self.readSelected(path: path)
      guard let command else { return current }
      let output = try command.output(current: current, variantId: self.variantId)
      let published = output == current ? output : try await self.sendWorkflow(command, path: path)
      _ = try self.selectedWorkflow(published)
      guard try output == current || command.acknowledged(in: published, variantId: self.variantId)
      else {
        throw WorkflowSidecarError(message: "The server did not confirm this checkpoint action.")
      }
      let restored = try XMPParser.parse(published)
      self.cacheGeneration &+= 1
      if self.pendingModel == nil { self.cached = restored }
      self.cachedMetadata = XMPParser.parseMetadata(published)
      self.cachedPassthrough = XMPParser.parsePassthrough(published)
      try self.renderSidecar.write(published)
      return published
    }
    writeTail = Task { _ = try await task.value }
    return try await task.value
  }

  private func sendWorkflow(_ command: WorkflowPublication, path: String) async throws -> String {
    let operation: String
    let fields: [String: Any]
    switch command {
    case .snapshot(let expected, let initial, let snapshot):
      operation = "snapshot"
      fields = [
        "expectedXmp": expected as Any? ?? NSNull(),
        "initialXmp": initial as Any? ?? NSNull(),
        "snapshot": try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)),
      ]
    case .restore(let expected, let entry):
      operation = "restore"
      fields = [
        "expectedXmp": expected,
        "entry": try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)),
      ]
    case .replay(let expected, let entry):
      operation = "commit"
      fields = [
        "expectedXmp": expected, "xmp": entry.adjustmentXmp,
        "entry": try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)),
      ]
    }
    var components = URLComponents(
      url: server.appending(path: "/api/xmp/variant/\(operation)"), resolvingAgainstBaseURL: false)
    components?.queryItems = [
      URLQueryItem(name: "path", value: path),
      URLQueryItem(name: "variantId", value: variantId),
    ]
    guard let url = components?.url else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(
      withJSONObject: fields.filter { $0.key != "initialXmp" || !($0.value is NSNull) })
    let (data, response) = try await httpClient.data(for: request)
    try Self.checkOK(response, data: data)
    guard let xml = String(data: data, encoding: .utf8) else { throw XMPStoreError.encodingError }
    return xml
  }

  func resolvedWorkflowPath() async throws -> String {
    if let workflowPath { return workflowPath }
    let path: String
    if assetID.hasPrefix("fs:") {
      path = String(assetID.dropFirst(3))
    } else {
      let detail = try await CloudAssetDetailClient(server: server, httpClient: httpClient)
        .detail(assetID: assetID)
      guard let resolved = detail.absPath, !resolved.isEmpty else {
        throw WorkflowSidecarError(message: "The server asset has no writable original path.")
      }
      path = resolved
    }
    workflowPath = path
    return path
  }

  private func workflowURL(path: String, commit: Bool) throws -> URL {
    var components = URLComponents(
      url: server.appending(path: commit ? "/api/xmp/variant/commit" : "/api/xmp/variant"),
      resolvingAgainstBaseURL: false)
    components?.queryItems = [
      URLQueryItem(name: "path", value: path),
      URLQueryItem(name: "variantId", value: variantId),
    ]
    guard let url = components?.url else { throw URLError(.badURL) }
    return url
  }

  private func readSelected(path: String) async throws -> String? {
    let (data, response) = try await httpClient.data(
      for: URLRequest(url: workflowURL(path: path, commit: false)))
    if (response as? HTTPURLResponse)?.statusCode == 404 {
      try requireIsPrimaryVariant()
      return nil
    }
    try Self.checkOK(response, data: data)
    guard let xml = String(data: data, encoding: .utf8) else { throw XMPStoreError.encodingError }
    _ = try selectedWorkflow(xml)
    try renderSidecar.write(xml)
    return xml
  }

  private func selectedWorkflow(_ xml: String) throws -> SidecarWorkflow? {
    try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId)
  }

  private func requireIsPrimaryVariant() throws {
    guard variantId == WorkflowContract.primaryVariantID else {
      throw WorkflowSidecarError(
        message: "The selected variant sidecar is missing. Restore it before editing.")
    }
  }

  private func historyEntry(_ edit: CapturedCloudEdit, checkpoint: String) -> WorkflowHistoryEntry {
    WorkflowHistoryEntry(
      id: edit.id, createdAtMs: edit.createdAtMs, action: edit.action,
      label: edit.label, adjustmentXmp: checkpoint)
  }

  private func publishSemanticEdits() async throws {
    guard !pendingSemanticEdits.isEmpty else { return }
    let edits = pendingSemanticEdits
    let path = try await resolvedWorkflowPath()
    var current = try await readSelected(path: path)
    for edit in edits {
      let record = try current.flatMap { try selectedWorkflow($0) }
      if record?.history.contains(where: { $0.id == edit.id }) != true {
        current = try await publishSemantic(edit, path: path, current: current)
      }
      pendingSemanticEdits.removeAll { $0.id == edit.id }
    }
  }

  private func publishSemantic(
    _ edit: CapturedCloudEdit, path: String, current: String?
  ) async throws -> String {
    let xml = XMPSerializer.serialize(
      model: edit.model, culling: edit.culling,
      metadata: current.map(XMPParser.parseMetadata) ?? XmpMetadata(),
      passthrough: current.map { XMPParser.parsePassthrough(data: Data($0.utf8)) } ?? .empty)
    let checkpoint = try WorkflowSidecarCore.checkpoint(xmp: xml)
    let entry = historyEntry(edit, checkpoint: checkpoint)
    let encodedEntry = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry))
    var request = URLRequest(url: try workflowURL(path: path, commit: true))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "expectedXmp": current as Any? ?? NSNull(), "xmp": checkpoint, "entry": encodedEntry,
    ])
    let (data, response) = try await httpClient.data(for: request)
    try Self.checkOK(response, data: data)
    guard let published = String(data: data, encoding: .utf8) else {
      throw XMPStoreError.encodingError
    }
    _ = try selectedWorkflow(published)
    return published
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
