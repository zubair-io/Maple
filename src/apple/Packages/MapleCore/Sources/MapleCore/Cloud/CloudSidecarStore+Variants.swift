import Foundation

/// Remote branch decoding reads a session-owned copy of confirmed XMP. It
/// never modifies the original or creates a synthetic server-side sibling.
final class WorkflowRenderSidecar: Sendable {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "maple-workflow-\(UUID().uuidString)", isDirectory: true)
  var url: URL { directory.appendingPathComponent("selected.xmp") }
  func write(_ xml: String) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(xml.utf8).write(to: url, options: .atomic)
  }
  deinit { try? FileManager.default.removeItem(at: directory) }
}

extension CloudSidecarStore: WorkflowVariantSidecarStoreProtocol {
  public func listWorkflowVariants() async throws -> [WorkflowVariantSidecar] {
    let path = try await resolvedWorkflowPath()
    let (data, response) = try await httpClient.data(for: URLRequest(url: variantsURL(path)))
    try requireSuccess(response, data: data)
    let values = try JSONDecoder().decode([WireVariant].self, from: data)
    return try values.map { value in
      _ = try WorkflowSidecarCore.variantFilename(
        primaryName: "photo.xmp", variantId: value.variantId)
      if let record = value.workflow {
        try WorkflowSidecarCore.validate(record)
        guard record.variantId == value.variantId else {
          throw WorkflowSidecarError(message: "Variant identity does not match its sidecar.")
        }
      }
      return WorkflowVariantSidecar(
        variantId: value.variantId, filename: value.filename,
        workflow: value.workflow, exists: value.exists)
    }
  }

  public func createWorkflowVariant(_ record: SidecarWorkflow, sourceVariantId: String) async throws
  {
    try WorkflowSidecarCore.validate(record)
    let path = try await resolvedWorkflowPath()
    var request = URLRequest(url: try variantsURL(path, sourceVariantId: sourceVariantId))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(record)
    let (data, response) = try await httpClient.data(for: request)
    try requireSuccess(response, data: data)
  }

  public func bindWorkflowVariant(_ variantId: String) async throws -> WorkflowVariantBinding {
    let writer = try await variantWriter(variantId: variantId)
    return WorkflowVariantBinding(writer: writer, sidecarURL: writer.renderSidecar.url)
  }

  private struct WireVariant: Decodable {
    let variantId: String
    let filename: String
    let workflow: SidecarWorkflow?
    let exists: Bool
  }
  private func variantsURL(_ path: String, sourceVariantId: String? = nil) throws -> URL {
    var parts = URLComponents(
      url: server.appending(path: "/api/xmp/variants"),
      resolvingAgainstBaseURL: false)
    parts?.queryItems = [URLQueryItem(name: "path", value: path)]
    if let sourceVariantId {
      parts?.queryItems?.append(URLQueryItem(name: "sourceVariantId", value: sourceVariantId))
    }
    guard let url = parts?.url else { throw URLError(.badURL) }
    return url
  }
  private func requireSuccess(_ response: URLResponse, data: Data) throws {
    guard let status = response as? HTTPURLResponse, (200..<300).contains(status.statusCode) else {
      throw WorkflowSidecarError(message: String(decoding: data, as: UTF8.self))
    }
  }
}
