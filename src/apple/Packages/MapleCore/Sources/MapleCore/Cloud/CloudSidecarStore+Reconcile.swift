// CloudSidecarStore+Reconcile.swift — ordinary saves and semantic commits that
// merge onto a sidecar another writer changed, instead of replacing it (#4983).

import Foundation

extension CloudSidecarStore {
  /// Attempts at one save when another writer wins the conditional publication.
  static let maxConflictRetries = 4

  func send(model: AdjustmentModel, culling: CullingState) async throws {
    try await publishSemanticEdits()
    var attempt = 0
    while true {
      attempt += 1
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
      let current: String? = absent ? nil : String(decoding: bytes, as: UTF8.self)
      var savedModel = model
      savedModel.inpaintRemovals = try RemovalXMPRecords.ordinaryWriteRecords(absent ? nil : bytes)
      if let current {
        _ = try XMPParser.parse(data: bytes)
        _ = try selectedWorkflow(current)
        cachedMetadata = XMPParser.parseMetadata(current)
        cachedPassthrough = XMPParser.parsePassthrough(data: bytes)
      }
      let incoming = XMPSerializer.serialize(
        model: savedModel, culling: culling, metadata: cachedMetadata,
        passthrough: cachedPassthrough)
      let (output, merged) = try reconcile(incoming: incoming, current: current)
      if merged, let current, try Self.isSameDocument(output, current) {
        if stagedAdoption?.published != current {
          try observe(
            current,
            merging: PendingAdoption(
              represented: incoming,
              document: ReconciledSidecar(xml: current, model: model, culling: culling)))
        }
        return
      }
      var request = URLRequest(url: try sidecarURL)
      request.httpMethod =
        variantId == WorkflowContract.primaryVariantID && assetID.hasPrefix("fs:") ? "POST" : "PUT"
      request.setValue("application/xml", forHTTPHeaderField: "Content-Type")
      if let precondition = Self.precondition(response, absent: absent) {
        request.setValue(precondition.value, forHTTPHeaderField: precondition.name)
      }
      request.httpBody = Data(output.utf8)
      let (data, resp) = try await httpClient.data(for: request)
      if (resp as? HTTPURLResponse)?.statusCode == 412, attempt < Self.maxConflictRetries {
        continue
      }
      try Self.checkOK(resp, data: data)
      // Path writes return their preserved XMP; catalog writes acknowledge in JSON.
      let body = String(data: data, encoding: .utf8)
      let published = body?.hasPrefix("<") == true ? body! : output
      try renderSidecar.write(published)
      try observe(
        published,
        merging: merged
          ? PendingAdoption(
            represented: incoming,
            document: ReconciledSidecar(xml: published, model: model, culling: culling)) : nil)
      if cached?.0 == model, cached?.1 == culling { cached = (savedModel, culling) }
      return
    }
  }

  /// `incoming` over `current`: a current document that is not the observed one is
  /// captured and merged by the shared core; one that vanished is replaced as before.
  private func reconcile(incoming: String, current: String?) throws -> (String, Bool) {
    guard hasObservedSidecar, let current, try hasDrifted(from: current) else {
      return (incoming, false)
    }
    return (
      try WorkflowSidecarCore.reconcile(
        base: observedSidecarXML ?? "", current: current, incoming: incoming,
        nowMs: UInt64(Date().timeIntervalSince1970 * 1000)), true
    )
  }

  /// Whether `current` holds adjustments the editor's observed document does not.
  func hasDrifted(from current: String) throws -> Bool {
    try current != observedSidecarXML
      && !WorkflowSidecarCore.holdSameAdjustments(current, observedSidecarXML)
  }

  /// The exact-content precondition the server advertises for path-keyed saves (#4317).
  private static func precondition(_ response: URLResponse, absent: Bool) -> (
    name: String, value: String
  )? {
    guard let http = response as? HTTPURLResponse,
      http.value(forHTTPHeaderField: "X-Maple-Xmp-Preconditions") == "content-etag-v1"
    else { return nil }
    if absent { return ("If-None-Match", "*") }
    guard let etag = http.value(forHTTPHeaderField: "ETag"),
      etag.range(of: #"^"[0-9a-f]{40}"$"#, options: .regularExpression) != nil
    else { return nil }
    return ("If-Match", etag)
  }

  /// Publishing `merged` would change neither the adjustments nor the history.
  private static func isSameDocument(_ merged: String, _ current: String) throws -> Bool {
    if merged == current { return true }
    return try WorkflowSidecarCore.checkpoint(xmp: merged)
      == WorkflowSidecarCore.checkpoint(xmp: current)
      && WorkflowSidecarCore.read(xmp: merged)?.history.map(\.id)
        == WorkflowSidecarCore.read(xmp: current)?.history.map(\.id)
  }

  /// `published` is now the sidecar. With `adoption` the editor still shows the
  /// document it saved, so that stays the observed revision until it confirms.
  func observe(_ published: String?, merging adoption: PendingAdoption? = nil) throws {
    lineageHeadID =
      try published.map {
        try WorkflowSidecarCore.headId(xmp: $0, variantId: variantId)
      } ?? ""
    hasObservedSidecar = true
    guard let published, let adoption, reconciliationHub.hasSubscribers else {
      observedSidecarXML = published
      stagedAdoption = nil
      return
    }
    observedSidecarXML = adoption.represented
    stagedAdoption = StagedAdoption(published: published, document: adoption.document)
    reconciliationHub.publish(adoption.document)
  }

  func historyEntry(_ edit: CapturedCloudEdit, checkpoint: String) -> WorkflowHistoryEntry {
    WorkflowHistoryEntry(
      id: edit.id, createdAtMs: edit.createdAtMs, action: edit.action,
      label: edit.label, parentId: edit.parentId, writer: WorkflowContract.appleWriter,
      adjustmentXmp: checkpoint)
  }

  /// Each queued action is committed by its `id`; the server merges a stale base and the
  /// document it returns is authoritative.
  func publishSemanticEdits() async throws {
    guard !pendingSemanticEdits.isEmpty else { return }
    let edits = pendingSemanticEdits
    let path = try await resolvedWorkflowPath()
    var current = try await readSelected(path: path)
    var expected =
      try current.flatMap { try hasObservedSidecar && hasDrifted(from: $0) } == true
      ? observedSidecarXML : current
    var merging: PendingAdoption?
    var published = false
    for edit in edits {
      let record = try current.flatMap { try selectedWorkflow($0) }
      if record?.history.contains(where: { $0.id == edit.id }) != true {
        let stale = expected != current
        let result = try await publishSemantic(
          edit, path: path, current: current, expected: expected)
        current = result.published
        expected = result.published
        published = true
        if stale {
          merging = PendingAdoption(
            represented: result.represented,
            document: ReconciledSidecar(
              xml: result.published, model: edit.model, culling: edit.culling))
        }
      }
      pendingSemanticEdits.removeAll { $0.id == edit.id }
    }
    if published { try observe(current, merging: merging) }
  }

  private func publishSemantic(
    _ edit: CapturedCloudEdit, path: String, current: String?, expected: String?
  ) async throws -> (published: String, represented: String) {
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
      "expectedXmp": expected as Any? ?? NSNull(), "xmp": checkpoint, "entry": encodedEntry,
    ])
    let (data, response) = try await httpClient.data(for: request)
    try Self.checkOK(response, data: data)
    guard let published = String(data: data, encoding: .utf8) else {
      throw XMPStoreError.encodingError
    }
    _ = try selectedWorkflow(published)
    return (published, xml)
  }
}

extension CloudSidecarStore: ReconcilingSidecarStoreProtocol {
  public func reconciliations() -> AsyncStream<ReconciledSidecar> {
    reconciliationHub.subscribe()
  }

  public func confirmAdoption(of xml: String) {
    guard let staged = stagedAdoption, staged.published == xml else { return }
    observedSidecarXML = xml
    stagedAdoption = nil
    if pendingModel == staged.document.model, pendingCulling == staged.document.culling {
      pendingModel = nil
      pendingCulling = nil
    }
    if let adopted = try? XMPParser.parse(xml) { cached = adopted }
  }
}

extension WorkflowPublication {
  /// Restores and replays replace the editor's whole state; snapshots only add to the record.
  var replacesEditorState: Bool {
    if case .snapshot = self { return false }
    return true
  }
}
