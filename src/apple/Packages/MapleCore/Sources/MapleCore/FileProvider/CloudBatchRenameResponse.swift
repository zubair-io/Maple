import Foundation

/// One item of `POST /api/assets/batch-rename`'s response — `kind`
/// discriminates the shape the other fields carry (mirrors
/// `BatchRenameItemResult` in `batch-rename.ts`): `"relocated"` carries
/// `newFilename`; `"skipped"` carries `reason`; `"invalid"`/`"error"` carry
/// `error`; `"not-found"` carries neither. An item sent with a companion
/// (#5929) adds `companionNewFilename` when the pair was renamed and
/// `collisionFilename`, the RAW's or the JPEG's taken name, when it was skipped.
public struct CloudBatchRenameResultItem: Decodable, Equatable, Sendable {
  public let id: String
  public let kind: String
  public let newFilename: String?
  public let reason: String?
  public let error: String?
  public let companionNewFilename: String?
  public let collisionFilename: String?

  enum CodingKeys: String, CodingKey {
    case id, kind, reason, error
    case newFilename = "new_filename"
    case companionNewFilename = "companion_new_filename"
    case collisionFilename = "collision_filename"
  }
}

public struct CloudBatchRenameSummary: Decodable, Equatable, Sendable {
  public let total: Int
  public let relocated: Int
  public let skipped: Int
  public let failed: Int
}

public struct CloudBatchRenameResponse: Decodable, Equatable, Sendable {
  public let summary: CloudBatchRenameSummary
  public let results: [CloudBatchRenameResultItem]
}
