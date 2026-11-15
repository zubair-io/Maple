public struct PanoSourceFrame: Codable, Sendable, Equatable, Identifiable {
  public let assetId: String
  public let path: String
  public var id: String { assetId }

  public init(assetId: String, path: String) {
    self.assetId = assetId
    self.path = path
  }
}
