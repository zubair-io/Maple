// CloudflareSettingsForm.swift — editable state for the Cloudflare page.
//
// Free of SwiftUI so the rules below are unit-testable; XCUITest is
// unavailable on the primary dev machine (#2525), so anything left in the
// view is effectively unverifiable.

import Foundation

public struct CloudflareSettingsForm: Equatable, Sendable {
  public var enabled: Bool
  public var accountID: String
  public var bucket: String
  public var accessKeyID: String
  /// Always starts blank, even when a secret is stored — the server never
  /// echoes it, so there is nothing to seed and a blank field is what makes
  /// "keep the saved key" expressible.
  public var secretAccessKey: String

  public init(
    enabled: Bool = false, accountID: String = "", bucket: String = "",
    accessKeyID: String = "", secretAccessKey: String = ""
  ) {
    self.enabled = enabled
    self.accountID = accountID
    self.bucket = bucket
    self.accessKeyID = accessKeyID
    self.secretAccessKey = secretAccessKey
  }

  public static func seeded(from config: CloudflareConfig) -> CloudflareSettingsForm {
    CloudflareSettingsForm(
      enabled: config.enabled,
      accountID: config.accountID ?? "",
      bucket: config.bucket ?? "",
      accessKeyID: config.accessKeyID ?? "",
      secretAccessKey: "")
  }

  /// Build the PUT body.
  ///
  /// A blank secret field means `.keep`, never `.clear`. Sending an explicit
  /// null there would wipe a working key every time the operator saved an
  /// unrelated change — e.g. toggling `enabled` off.
  public func patch() -> CloudflareConfigPatch {
    let trimmedSecret = secretAccessKey.trimmingCharacters(in: .whitespacesAndNewlines)
    return CloudflareConfigPatch(
      enabled: enabled,
      accountID: Self.nilIfBlank(accountID),
      bucket: Self.nilIfBlank(bucket),
      accessKeyID: Self.nilIfBlank(accessKeyID),
      secret: trimmedSecret.isEmpty ? .keep : .set(trimmedSecret))
  }

  /// Credentials for the Test button, or nil when the form can't be probed.
  ///
  /// Requires a *freshly typed* secret: the stored one is never echoed, so
  /// there is no way to probe it client-side. That's why Test stays disabled
  /// even when a secret is saved and the other three fields are filled.
  public func testCredentials() -> CloudflareTestCredentials? {
    let account = accountID.trimmingCharacters(in: .whitespacesAndNewlines)
    let bucketName = bucket.trimmingCharacters(in: .whitespacesAndNewlines)
    let keyID = accessKeyID.trimmingCharacters(in: .whitespacesAndNewlines)
    let secret = secretAccessKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !account.isEmpty, !bucketName.isEmpty, !keyID.isEmpty, !secret.isEmpty else {
      return nil
    }
    return CloudflareTestCredentials(
      accountID: account, bucket: bucketName, accessKeyID: keyID, secretAccessKey: secret)
  }

  private static func nilIfBlank(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
