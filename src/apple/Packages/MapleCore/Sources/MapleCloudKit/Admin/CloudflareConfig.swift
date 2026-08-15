// CloudflareConfig.swift — wire types for /api/cloudflare/config.
//
// Configures the R2 edge mirror for thumbnails (src/api/src/routes/
// cloudflare.ts). Unlike the network routes, these are genuinely
// owner-gated server-side — a member receives 403, not a hidden nav item.
//
// The secret is write-only: the server strips it from every response and
// reports only whether one is stored (`secret_access_key_set`). There is no
// endpoint that reveals it, so nothing here ever needs to hold it at rest.

import Foundation

public struct CloudflareConfig: Decodable, Sendable, Equatable {
  public let enabled: Bool
  public let accountID: String?
  public let bucket: String?
  public let accessKeyID: String?
  /// Whether a secret is stored server-side. The secret itself is never sent.
  public let secretAccessKeySet: Bool

  public init(
    enabled: Bool, accountID: String?, bucket: String?, accessKeyID: String?,
    secretAccessKeySet: Bool
  ) {
    self.enabled = enabled
    self.accountID = accountID
    self.bucket = bucket
    self.accessKeyID = accessKeyID
    self.secretAccessKeySet = secretAccessKeySet
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case accountID = "account_id"
    case bucket
    case accessKeyID = "access_key_id"
    case secretAccessKeySet = "secret_access_key_set"
  }
}

/// What a save should do with the stored secret.
///
/// Three states, because the API distinguishes all three and collapsing any
/// two loses a real operation: omitting the key keeps what's stored, an
/// explicit null clears it, and a string replaces it. A blank field means
/// `keep` — that's what makes "save without retyping the secret" work.
public enum CloudflareSecretUpdate: Equatable, Sendable {
  case keep
  case clear
  case set(String)
}

public struct CloudflareConfigPatch: Encodable, Sendable, Equatable {
  public let enabled: Bool
  public let accountID: String?
  public let bucket: String?
  public let accessKeyID: String?
  public let secret: CloudflareSecretUpdate

  public init(
    enabled: Bool, accountID: String?, bucket: String?, accessKeyID: String?,
    secret: CloudflareSecretUpdate
  ) {
    self.enabled = enabled
    self.accountID = accountID
    self.bucket = bucket
    self.accessKeyID = accessKeyID
    self.secret = secret
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case accountID = "account_id"
    case bucket
    case accessKeyID = "access_key_id"
    case secretAccessKey = "secret_access_key"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(enabled, forKey: .enabled)
    try encodeNullable(accountID, forKey: .accountID, into: &c)
    try encodeNullable(bucket, forKey: .bucket, into: &c)
    try encodeNullable(accessKeyID, forKey: .accessKeyID, into: &c)
    switch secret {
    case .keep:
      break  // omit the key entirely — server keeps the stored secret
    case .clear:
      try c.encodeNil(forKey: .secretAccessKey)
    case .set(let value):
      try c.encode(value, forKey: .secretAccessKey)
    }
  }

  private func encodeNullable(
    _ value: String?, forKey key: CodingKeys,
    into container: inout KeyedEncodingContainer<CodingKeys>
  ) throws {
    if let value {
      try container.encode(value, forKey: key)
    } else {
      try container.encodeNil(forKey: key)
    }
  }
}

/// Body for `POST /api/cloudflare/test`. Every field is required and
/// non-empty server-side, including the secret — the stored one can't be
/// probed because it's never echoed back.
public struct CloudflareTestCredentials: Encodable, Sendable, Equatable {
  public let accountID: String
  public let bucket: String
  public let accessKeyID: String
  public let secretAccessKey: String

  public init(accountID: String, bucket: String, accessKeyID: String, secretAccessKey: String) {
    self.accountID = accountID
    self.bucket = bucket
    self.accessKeyID = accessKeyID
    self.secretAccessKey = secretAccessKey
  }

  enum CodingKeys: String, CodingKey {
    case accountID = "account_id"
    case bucket
    case accessKeyID = "access_key_id"
    case secretAccessKey = "secret_access_key"
  }
}
