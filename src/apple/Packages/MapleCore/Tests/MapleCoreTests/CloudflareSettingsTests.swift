// CloudflareSettingsTests.swift
//
// Wire shapes and form rules for the Cloudflare R2 page (#2767).
//
// The rule that carries real risk is the three-state secret. The API
// distinguishes omit (keep the stored key), explicit null (clear it), and a
// string (replace it). Collapsing blank-means-keep into blank-means-clear
// would wipe a working key every time the operator saved an unrelated
// change, and nothing in the UI would show it until uploads started failing.

import XCTest

@testable import MapleCore

final class CloudflareConfigTypesTests: XCTestCase {

  func test_decode_configWithStoredSecret() throws {
    let json = """
      {"enabled":true,"account_id":"a1b2","bucket":"maple-thumbs",
       "access_key_id":"AKIA1","secret_access_key_set":true}
      """
    let cfg = try JSONDecoder().decode(CloudflareConfig.self, from: Data(json.utf8))
    XCTAssertTrue(cfg.enabled)
    XCTAssertEqual(cfg.accountID, "a1b2")
    XCTAssertEqual(cfg.bucket, "maple-thumbs")
    XCTAssertEqual(cfg.accessKeyID, "AKIA1")
    XCTAssertTrue(cfg.secretAccessKeySet)
  }

  func test_decode_unconfigured() throws {
    let json = """
      {"enabled":false,"account_id":null,"bucket":null,
       "access_key_id":null,"secret_access_key_set":false}
      """
    let cfg = try JSONDecoder().decode(CloudflareConfig.self, from: Data(json.utf8))
    XCTAssertNil(cfg.accountID)
    XCTAssertFalse(cfg.secretAccessKeySet)
  }

  func test_decode_ignoresUnknownFields() throws {
    // The server also returns `updated_at`; an unmodelled key must not
    // fail the decode.
    let json = """
      {"enabled":false,"account_id":null,"bucket":null,"access_key_id":null,
       "secret_access_key_set":false,"updated_at":1786737637}
      """
    XCTAssertNoThrow(try JSONDecoder().decode(CloudflareConfig.self, from: Data(json.utf8)))
  }

  // MARK: - Secret tri-state

  private func encoded(_ patch: CloudflareConfigPatch) throws -> [String: Any] {
    let data = try JSONEncoder().encode(patch)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_encode_keepOmitsSecretKeyEntirely() throws {
    let obj = try encoded(
      CloudflareConfigPatch(
        enabled: true, accountID: "a", bucket: "b", accessKeyID: "k", secret: .keep))
    XCTAssertFalse(
      obj.keys.contains("secret_access_key"),
      "keep must omit the key — present-but-null would clear the stored secret")
  }

  func test_encode_clearSendsExplicitNull() throws {
    let obj = try encoded(
      CloudflareConfigPatch(
        enabled: false, accountID: "a", bucket: "b", accessKeyID: "k", secret: .clear))
    XCTAssertTrue(obj.keys.contains("secret_access_key"))
    XCTAssertTrue(obj["secret_access_key"] is NSNull)
  }

  func test_encode_setSendsTheValue() throws {
    let obj = try encoded(
      CloudflareConfigPatch(
        enabled: true, accountID: "a", bucket: "b", accessKeyID: "k", secret: .set("s3cret")))
    XCTAssertEqual(obj["secret_access_key"] as? String, "s3cret")
  }

  func test_encode_blankIdentityFieldsSendExplicitNulls() throws {
    let obj = try encoded(
      CloudflareConfigPatch(
        enabled: false, accountID: nil, bucket: nil, accessKeyID: nil, secret: .keep))
    for key in ["account_id", "bucket", "access_key_id"] {
      XCTAssertTrue(obj[key] is NSNull, "\(key) should serialize as null")
    }
  }
}

final class CloudflareSettingsFormTests: XCTestCase {

  private func config(
    enabled: Bool = true, account: String? = "a1b2", bucket: String? = "maple-thumbs",
    keyID: String? = "AKIA1", secretSet: Bool = true
  ) -> CloudflareConfig {
    CloudflareConfig(
      enabled: enabled, accountID: account, bucket: bucket, accessKeyID: keyID,
      secretAccessKeySet: secretSet)
  }

  // MARK: - Seeding

  func test_seed_populatesIdentityButNeverTheSecret() {
    let form = CloudflareSettingsForm.seeded(from: config())
    XCTAssertEqual(form.accountID, "a1b2")
    XCTAssertEqual(form.bucket, "maple-thumbs")
    XCTAssertEqual(form.accessKeyID, "AKIA1")
    XCTAssertTrue(form.enabled)
    XCTAssertEqual(form.secretAccessKey, "", "the secret is never echoed, so it can't be seeded")
  }

  func test_seed_nullsBecomeEmptyStrings() {
    let form = CloudflareSettingsForm.seeded(
      from: config(enabled: false, account: nil, bucket: nil, keyID: nil, secretSet: false))
    XCTAssertEqual(form.accountID, "")
    XCTAssertEqual(form.bucket, "")
    XCTAssertEqual(form.accessKeyID, "")
  }

  // MARK: - Patch

  func test_patch_blankSecretKeepsStoredKey() {
    var form = CloudflareSettingsForm.seeded(from: config())
    form.enabled = false
    XCTAssertEqual(form.patch().secret, .keep)
  }

  func test_patch_whitespaceOnlySecretAlsoKeeps() {
    // A stray space must not be read as "replace the key with a space",
    // and must not clear it either.
    var form = CloudflareSettingsForm.seeded(from: config())
    form.secretAccessKey = "   "
    XCTAssertEqual(form.patch().secret, .keep)
  }

  func test_patch_typedSecretIsTrimmedAndSet() {
    var form = CloudflareSettingsForm.seeded(from: config())
    form.secretAccessKey = "  s3cret  "
    XCTAssertEqual(form.patch().secret, .set("s3cret"))
  }

  func test_patch_blankIdentityFieldsBecomeNil() {
    var form = CloudflareSettingsForm.seeded(from: config())
    form.accountID = "   "
    form.bucket = ""
    let patch = form.patch()
    XCTAssertNil(patch.accountID)
    XCTAssertNil(patch.bucket)
    XCTAssertEqual(patch.accessKeyID, "AKIA1")
  }

  // MARK: - Test credentials

  func test_testCredentials_nilWithoutAFreshSecret() {
    // All identity fields present and a secret IS stored server-side — but
    // it can't be probed, so Test must stay unavailable.
    let form = CloudflareSettingsForm.seeded(from: config(secretSet: true))
    XCTAssertNil(form.testCredentials())
  }

  func test_testCredentials_nilWhenAnyIdentityFieldMissing() {
    var form = CloudflareSettingsForm.seeded(from: config())
    form.secretAccessKey = "s3cret"
    form.bucket = "  "
    XCTAssertNil(form.testCredentials())
  }

  func test_testCredentials_builtFromTrimmedValues() {
    var form = CloudflareSettingsForm.seeded(from: config())
    form.accountID = " a1b2 "
    form.secretAccessKey = " s3cret "
    let creds = form.testCredentials()
    XCTAssertEqual(creds?.accountID, "a1b2")
    XCTAssertEqual(creds?.secretAccessKey, "s3cret")
    XCTAssertEqual(creds?.bucket, "maple-thumbs")
  }
}

final class CloudflareConfigClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> CloudflareConfigClient {
    CloudflareConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  private func okConfigResponse(_ req: URLRequest) -> (Data, HTTPURLResponse) {
    let json = """
      {"enabled":true,"account_id":"a1b2","bucket":"maple-thumbs",
       "access_key_id":"AKIA1","secret_access_key_set":true}
      """
    let resp = HTTPURLResponse(
      url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    return (Data(json.utf8), resp)
  }

  func test_fetch_targetsConfigPath() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      return self.okConfigResponse(req)
    }
    let cfg = try await client(session).fetch()
    XCTAssertEqual(capturedURL?.path, "/api/cloudflare/config")
    XCTAssertTrue(cfg.secretAccessKeySet)
  }

  func test_save_putsPatchBody() async throws {
    nonisolated(unsafe) var capturedMethod: String?
    let session = URLSession.stubbedSequence { req in
      capturedMethod = req.httpMethod
      return self.okConfigResponse(req)
    }
    _ = try await client(session).save(
      CloudflareConfigPatch(
        enabled: true, accountID: "a1b2", bucket: "maple-thumbs", accessKeyID: "AKIA1",
        secret: .keep))
    XCTAssertEqual(capturedMethod, "PUT")
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/cloudflare/config"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertFalse(obj.keys.contains("secret_access_key"))
    XCTAssertEqual(obj["account_id"] as? String, "a1b2")
  }

  func test_save_502LeavesConfigUnsavedAndSurfacesReason() async {
    // Enabling with bad credentials: the server round-trips R2 first and
    // returns 502 having written nothing.
    let session = URLSession.stubbed(
      response: #"{"error":"R2 credential check failed: InvalidAccessKeyId"}"#,
      contentType: "application/json", status: 502)
    do {
      _ = try await client(session).save(
        CloudflareConfigPatch(
          enabled: true, accountID: "a", bucket: "b", accessKeyID: "k", secret: .set("bad")))
      XCTFail("expected throw on 502")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 502)
      XCTAssertTrue(error.message.contains("R2 credential check failed"))
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_save_403ForNonOwner() async {
    let session = URLSession.stubbed(
      response: #"{"error":"owner role required"}"#, contentType: "application/json", status: 403)
    do {
      _ = try await client(session).save(
        CloudflareConfigPatch(
          enabled: false, accountID: nil, bucket: nil, accessKeyID: nil, secret: .keep))
      XCTFail("expected throw on 403")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 403)
      XCTAssertEqual(error.message, "owner role required")
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_test_postsCredentialsAndSucceedsOn200() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"ok":true}"#.utf8), resp)
    }
    try await client(session).test(
      CloudflareTestCredentials(
        accountID: "a", bucket: "b", accessKeyID: "k", secretAccessKey: "s"))
    XCTAssertEqual(capturedURL?.path, "/api/cloudflare/test")
  }

  func test_test_502CarriesReasonInErrorKey() async {
    // The failure body is `{ok:false, error}` with a 502 status, so the
    // reason must be read from the body rather than only on success.
    let session = URLSession.stubbed(
      response: #"{"ok":false,"error":"NoSuchBucket"}"#, contentType: "application/json",
      status: 502)
    do {
      try await client(session).test(
        CloudflareTestCredentials(
          accountID: "a", bucket: "nope", accessKeyID: "k", secretAccessKey: "s"))
      XCTFail("expected throw on 502")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.message, "NoSuchBucket")
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }
}
