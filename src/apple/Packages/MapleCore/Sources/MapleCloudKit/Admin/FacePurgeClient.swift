// FacePurgeClient.swift — POST /api/admin/faces/purge-subthreshold (T5b,
// #2772).
//
// Audit-first, mirroring FacePurgePanelComponent (workers.component.ts /
// bun-api-backend.service.ts): a dry-run scan reports the sub-threshold-face
// breakdown WITHOUT writing anything; Apply removes them (default:
// unassigned only). Hidden faces are always preserved server-side. This does
// NOT re-detect — it only removes faces whose bbox already fell below the
// configured `face_min_detection_size`, without touching any other face's
// person_id.

import Foundation

/// Per-category counts of faces below the configured threshold.
public struct SubthresholdFaceCounts: Decodable, Sendable, Equatable {
  public let unassigned: Int
  public let assigned: Int
  public let hidden: Int
  public let total: Int
}

/// What this run would do (dry-run) or did (apply) to each category.
public struct SubthresholdFacePolicy: Decodable, Sendable, Equatable {
  public let removesUnassigned: Bool
  public let removesAssigned: Bool
  public let preservesHidden: Bool
}

/// A person who would lose (or lost) manually-assigned sub-threshold faces.
public struct SubthresholdAffectedPerson: Decodable, Sendable, Equatable, Identifiable {
  public let personId: String
  public let subThresholdFaces: Int
  public var id: String { personId }
}

/// Realised stats — present only when `mode` starts with `apply:`.
public struct SubthresholdFaceApplyResult: Decodable, Sendable, Equatable {
  public let facesRemoved: Int
  public let assetsUpdated: Int
  public let personCountsRecomputed: Int
}

/// One audit or apply response. `applied` is `nil` for a dry-run.
public struct SubthresholdFaceResult: Decodable, Sendable, Equatable {
  public let threshold: Double
  public let mode: String
  public let assetsScanned: Int
  public let assetsAffected: Int
  public let subThresholdFaces: SubthresholdFaceCounts
  public let policy: SubthresholdFacePolicy
  public let affectedPeople: [SubthresholdAffectedPerson]
  public let applied: SubthresholdFaceApplyResult?

  /// Faces the current opt-in state would remove: unassigned always, plus
  /// assigned when the operator opted in. Drives the panel's "Apply"
  /// enablement and confirmation copy — mirrors
  /// `FacePurgePanelComponent.removableCount`.
  public func removableCount(includeAssigned: Bool) -> Int {
    subThresholdFaces.unassigned + (includeAssigned ? subThresholdFaces.assigned : 0)
  }
}

public actor FacePurgeClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var purgeURL: URL { server.appending(path: "/api/admin/faces/purge-subthreshold") }

  /// Read-only dry-run scan. Safe to call repeatedly.
  public func audit() async throws -> SubthresholdFaceResult {
    try await run(apply: false, includeAssigned: false)
  }

  /// Remove sub-threshold faces. `includeAssigned` also removes faces
  /// carrying a `person_id` (hand-labeled or auto-grouping — indistinguishable);
  /// default removes only unassigned faces. Hidden faces are always kept.
  public func apply(includeAssigned: Bool) async throws -> SubthresholdFaceResult {
    try await run(apply: true, includeAssigned: includeAssigned)
  }

  private func run(apply: Bool, includeAssigned: Bool) async throws -> SubthresholdFaceResult {
    var components = URLComponents(url: purgeURL, resolvingAgainstBaseURL: false)!
    var items: [URLQueryItem] = []
    if apply { items.append(URLQueryItem(name: "apply", value: "true")) }
    if includeAssigned { items.append(URLQueryItem(name: "includeAssigned", value: "true")) }
    if !items.isEmpty { components.queryItems = items }

    var request = URLRequest(url: components.url!)
    request.httpMethod = "POST"
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(SubthresholdFaceResult.self, from: data)
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> FacePurgeClient {
    FacePurgeClient(server: server, httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
