private enum WorkflowWireError: Error { case invalid }
private struct WorkflowAnyKey: CodingKey {
  let stringValue: String
  var intValue: Int? { nil }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { return nil }
}
private func workflowIdentity(_ id: String) throws {
  guard id.utf8.count == 36,
    id.range(
      of: "^(?:" + WorkflowContract.uuidPattern + ")$",
      options: .regularExpression) != nil
  else {
    throw WorkflowWireError.invalid
  }
}
private func workflowName(_ value: String) throws {
  let asciiWhitespace = CharacterSet(charactersIn: "\t\n\u{000b}\u{000c}\r ")
  guard !value.isEmpty, !value.unicodeScalars.allSatisfy(asciiWhitespace.contains),
    !value.unicodeScalars.contains(where: { $0.value <= 31 || (127...159).contains($0.value) })
  else {
    throw WorkflowWireError.invalid
  }
}
extension WorkflowSnapshot {
  fileprivate func validateWire() throws {
    try workflowIdentity(id)
    try workflowName(name)
    guard createdAtMs <= WorkflowContract.maxTimestampMS else { throw WorkflowWireError.invalid }
  }
}
extension WorkflowHistoryEntry {
  fileprivate func validateWire() throws {
    try workflowIdentity(id)
    try workflowName(label)
    guard createdAtMs <= WorkflowContract.maxTimestampMS, WorkflowContract.actions.contains(action)
    else {
      throw WorkflowWireError.invalid
    }
  }
}
extension SidecarWorkflow {
  /// Decode/encode guards the wire shape; raw-core validates checkpoint XML before persistence.
  fileprivate func validateWire() throws {
    guard schemaVersion == WorkflowContract.version,
      history.count <= WorkflowContract.historyLimit,
      Set(snapshots.map(\.id)).count == snapshots.count,
      Set(history.map(\.id)).count == history.count
    else { throw WorkflowWireError.invalid }
    if variantId != WorkflowContract.primaryVariantID { try workflowIdentity(variantId) }
    try workflowName(variantName)
    for value in snapshots { try value.validateWire() }
    for value in history { try value.validateWire() }
    // Measure a plain wire object to avoid recursively invoking this encoder.
    let object: [String: Any] = [
      "schemaVersion": schemaVersion, "variantId": variantId, "variantName": variantName,
      "snapshots": snapshots.map {
        [
          "id": $0.id, "name": $0.name, "createdAtMs": $0.createdAtMs,
          "adjustmentXmp": $0.adjustmentXmp,
        ] as [String: Any]
      },
      "history": history.map {
        [
          "id": $0.id, "createdAtMs": $0.createdAtMs, "action": $0.action, "label": $0.label,
          "adjustmentXmp": $0.adjustmentXmp,
        ] as [String: Any]
      },
    ]
    guard
      try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]).count
        <= WorkflowContract.maxBytes
    else {
      throw WorkflowWireError.invalid
    }
  }
}
