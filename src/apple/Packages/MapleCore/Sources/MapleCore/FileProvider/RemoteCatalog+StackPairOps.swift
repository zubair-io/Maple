import Foundation

/// Why a RAW+JPEG pair request left both files where they were, beyond the outcomes a single
/// asset has.
public enum StackPairError: Error, Equatable, Sendable {
  /// The JPEG is gone, trashed or no longer beside the RAW (404 `missing: 'companion'`).
  case companionMissing
  /// The JPEG's destination name, carried here, is taken.
  case companionNameTaken(String)
}

/// A server that reports `stack_pair_ops_supported` on `/api/display/config` (#5929, #5930) moves,
/// renames and trashes a RAW+JPEG stack in one request: the RAW, the JPEG and their sidecar land
/// together or not at all, and what a Replace displaced comes back if the pair cannot finish
/// (docs/api.md "RAW+JPEG stacks"). An older server ignores the pair fields and would act on the
/// RAW alone, so its stacks keep the two-call path in `RemoteCatalog+Stack.swift`.
extension RemoteCatalog {
  /// Whether this server takes the pair requests below; false for an older server and for one that
  /// cannot be asked.
  public func supportsStackPairOps() async -> Bool {
    let client = DisplayConfigClient(server: server, httpClient: http)
    return (try? await client.fetch())?.stackPairOpsSupported ?? false
  }

  /// The RAW `assetID` and its JPEG `companionID` moved or copied as one pair. The JPEG replaces a
  /// file at its name only when its own prompt chose Replace (`companionCollision`); otherwise a
  /// taken `companionName`, the JPEG's destination name, skips the pair and throws
  /// `companionNameTaken`.
  public func relocatePair(
    assetID: String, companionID: String, mode: RelocateMode, collision: CollisionPolicy,
    companionCollision: CollisionPolicy, destinationPath: String, sourceAddress: String?,
    companionName: String
  ) async throws -> RelocateAssetResult {
    let replacesCompanion = companionCollision == .replace && collision != .autoSuffix
    var body: [String: Any] = [
      "mode": mode == .move ? "move" : "copy", "collision": Self.wireCollision(collision),
      "destination_path": destinationPath,
      "companion_collision": replacesCompanion ? "replace" : "skip",
    ]
    if let sourceAddress { body["source_address"] = sourceAddress }
    let answer = try await sendPair(
      post(assetID: assetID, action: "relocate", companionID: companionID, body: body))
    switch answer.status {
    case 200:
      if let reason = try Self.skipReason(
        answer.data, companionName: replacesCompanion ? nil : companionName)
      {
        return .skipped(reason: reason)
      }
      return .ok(try JSONDecoder().decode(RelocateAssetResponse.self, from: answer.data))
    case 400:
      return .invalid(Self.errorMessage(answer.data) ?? "Invalid destination")
    case 404:
      return .notFound
    default:
      throw Self.mapHTTPError(status: answer.status)
    }
  }

  /// The RAW `assetID` renamed to `newFilename` and its JPEG `companionID` to `companionName`, as
  /// one pair. A taken `companionName` skips the pair and throws `companionNameTaken`.
  public func renamePair(
    assetID: String, companionID: String, newFilename: String, companionName: String
  ) async throws -> RenameAssetResult {
    let body: [String: Any] = [
      "new_filename": newFilename, "collision": "skip", "companion_collision": "skip",
    ]
    let answer = try await sendPair(
      post(assetID: assetID, action: "rename", companionID: companionID, body: body))
    switch answer.status {
    case 200:
      if let reason = try Self.skipReason(answer.data, companionName: companionName) {
        return .skipped(reason: reason)
      }
      return .ok(try JSONDecoder().decode(RenameAssetResponse.self, from: answer.data))
    case 400:
      return .invalid(Self.errorMessage(answer.data) ?? "Invalid filename")
    case 404:
      return .notFound
    default:
      throw Self.mapHTTPError(status: answer.status)
    }
  }

  /// The RAW `assetID` and its JPEG `companionID` sent to the server's Trash under one stem.
  public func trashPair(assetID: String, companionID: String) async throws -> DeleteAssetResult {
    try Self.validateAssetID(assetID)
    try Self.validateAssetID(companionID)
    var comps = URLComponents(
      url: server.appending(path: "/api/assets/\(assetID)"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [
      URLQueryItem(name: "intent", value: DeleteAssetIntent.trash.rawValue),
      URLQueryItem(name: "companion", value: companionID),
    ]
    var req = URLRequest(url: comps.url!)
    req.httpMethod = "DELETE"
    let answer = try await sendPair(req)
    if answer.status == 409 {
      let body = try? JSONDecoder().decode(DeleteAssetConflictBody.self, from: answer.data)
      return .stateMismatch(state: body?.state ?? "unknown")
    }
    try Self.check2xx(answer.response, data: answer.data, url: req.url)
    return .ok
  }

  private func post(
    assetID: String, action: String, companionID: String, body: [String: Any]
  ) throws -> URLRequest {
    try Self.validateAssetID(assetID)
    try Self.validateAssetID(companionID)
    var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/\(action)"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(
      withJSONObject: body.merging(["companion_id": companionID]) { $1 })
    return req
  }

  private func sendPair(_ request: URLRequest) async throws -> (
    data: Data, response: URLResponse, status: Int
  ) {
    let (data, response) = try await http.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? -1
    if status == 404,
      (try? JSONDecoder().decode(PairErrorBody.self, from: data))?.missing == "companion"
    {
      throw StackPairError.companionMissing
    }
    return (data, response, status)
  }

  /// The reason of a 200 `skipped` answer, nil when the pair landed. Throws `companionNameTaken`
  /// when the taken name was `companionName`.
  private static func skipReason(_ data: Data, companionName: String?) throws -> String? {
    guard let skipped = try? JSONDecoder().decode(PairSkippedBody.self, from: data),
      skipped.skipped
    else { return nil }
    if let companionName,
      skipped.collisionFilename?.caseInsensitiveCompare(companionName) == .orderedSame
    {
      throw StackPairError.companionNameTaken(companionName)
    }
    return skipped.reason ?? "collision"
  }

  private static func errorMessage(_ data: Data) -> String? {
    (try? JSONDecoder().decode(PairErrorBody.self, from: data))?.error
  }
}

private struct PairSkippedBody: Decodable {
  let skipped: Bool
  let reason: String?
  let collisionFilename: String?

  enum CodingKeys: String, CodingKey {
    case skipped, reason
    case collisionFilename = "collision_filename"
  }
}

private struct PairErrorBody: Decodable {
  let error: String?
  let missing: String?
}
