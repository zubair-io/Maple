// EnrichmentConfigClientTests.swift
//
// Wire-shape coverage for `EnrichmentConfigClient` (#2771). The generic
// `save` path is exercised once per patch type to confirm each row really
// does put only its own keys on the wire (the form-level tests in
// EnrichmentSettingsTests.swift cover the same rule at the encoding layer;
// these confirm the client doesn't add anything on top). The `ok: false`
// probe tests are the other load-bearing case here: all three test* routes
// report a failed health check on a 2xx status, so a client that only
// checks the HTTP status would read a failure as success.

import XCTest

@testable import MapleCore

final class EnrichmentConfigClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> EnrichmentConfigClient {
    EnrichmentConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  private func okConfigResponse(_ req: URLRequest) -> (Data, HTTPURLResponse) {
    let json = """
      {"nominatim_url":"https://nominatim.example","geocode_worker_enabled":true,
       "nominatim_rate_limit_per_sec":10,"describe_provider_url":null,
       "transcribe_model_tier":"medium.en","meilisearch_url":null,
       "meilisearch_api_key_set":false,"meilisearch_task_timeout_seconds":600,
       "meilisearch_semantic_enabled":false,"meilisearch_embedder_url":"http://x",
       "meilisearch_embedder_model":"bge-m3","meilisearch_semantic_ratio":0.5,
       "service_search_rate_limit_per_minute":60}
      """
    let resp = HTTPURLResponse(
      url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    return (Data(json.utf8), resp)
  }

  // MARK: - fetch

  func test_fetch_targetsConfigPath() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      return self.okConfigResponse(req)
    }
    let cfg = try await client(session).fetch()
    XCTAssertEqual(capturedURL?.path, "/api/enrichment/config")
    XCTAssertEqual(cfg.transcribeModelTier, .mediumEn)
  }

  func test_fetch_403ForNonOwnerIsNotThrownHere() async {
    // GET is member-readable — only PUT is owner-gated — but the client
    // must still surface whatever the server returns.
    let session = URLSession.stubbed(
      response: #"{"error":"not signed in"}"#, contentType: "application/json", status: 401)
    do {
      _ = try await client(session).fetch()
      XCTFail("expected throw on 401")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 401)
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  // MARK: - save: PUT + no-foreign-keys per row

  func test_save_describePatch_putsOnlyOwnFields() async throws {
    let session = URLSession.stubbedSequence { self.okConfigResponse($0) }
    _ = try await client(session).save(
      DescribeConfigPatch(
        nominatimURL: "https://nominatim.example", geocodeWorkerEnabled: true,
        describeProviderURL: "http://ollama.internal:11434"))
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/enrichment/config"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(
      Set(obj.keys), ["nominatim_url", "geocode_worker_enabled", "describe_provider_url"])
  }

  func test_save_meilisearchPatch_putsOnlyOwnFieldsAndOmitsBlankKey() async throws {
    let session = URLSession.stubbedSequence { self.okConfigResponse($0) }
    _ = try await client(session).save(
      MeilisearchConfigPatch(
        nominatimURL: "https://nominatim.example", geocodeWorkerEnabled: true,
        meilisearchURL: "http://meili.example", meilisearchAPIKey: nil,
        meilisearchSemanticEnabled: false, meilisearchEmbedderModel: "bge-m3",
        meilisearchTaskTimeoutSeconds: 600, meilisearchSemanticRatio: 0.5,
        serviceSearchRateLimitPerMinute: 60))
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/enrichment/config"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertFalse(obj.keys.contains("meilisearch_api_key"))
    XCTAssertFalse(
      obj.keys.contains("describe_provider_url"), "meili save must not touch the describe row")
    XCTAssertFalse(
      obj.keys.contains("transcribe_model_tier"), "meili save must not touch the transcribe row")
  }

  func test_save_403ForNonOwner() async {
    let session = URLSession.stubbed(
      response: #"{"error":"owner role required"}"#, contentType: "application/json", status: 403)
    do {
      _ = try await client(session).save(
        TranscribeConfigPatch(
          nominatimURL: nil, geocodeWorkerEnabled: true, transcribeModelTier: .baseEn))
      XCTFail("expected throw on 403")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 403)
      XCTAssertEqual(error.message, "owner role required")
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  // MARK: - test probes: ok:false on a 2xx status must still throw

  func test_testGeocode_targetsPathAndSucceedsOnOkTrue() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"ok":true,"url":"https://nominatim.example"}"#.utf8), resp)
    }
    try await client(session).testGeocode(nominatimURL: "https://nominatim.example")
    XCTAssertEqual(capturedURL?.path, "/api/enrichment/test")
    // URLProtocol strips the body off the request once the loader takes it;
    // URLProtocolStub captures it separately, keyed on the URL string.
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/enrichment/test"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(obj["nominatim_url"] as? String, "https://nominatim.example")
  }

  func test_testGeocode_okFalseOn200StillThrows() async {
    // The route returns 200 with {ok:false, error} for a failed health
    // check — only request-shape problems (empty URL) use 4xx. A client
    // that only checked the HTTP status would read this as success.
    let session = URLSession.stubbed(
      response: #"{"ok":false,"error":"connect ECONNREFUSED"}"#, contentType: "application/json",
      status: 200)
    do {
      try await client(session).testGeocode(nominatimURL: "https://dead.example")
      XCTFail("expected throw on ok:false")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 200)
      XCTAssertEqual(error.message, "connect ECONNREFUSED")
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_testMeilisearch_omitsAPIKeyWhenNil() async throws {
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"ok":true}"#.utf8), resp)
    }
    try await client(session).testMeilisearch(url: "http://meili.example", apiKey: nil)
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/enrichment/test-meili"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertFalse(obj.keys.contains("api_key"))
  }

  func test_testMeilisearch_okFalseOn200StillThrows() async {
    let session = URLSession.stubbed(
      response: #"{"ok":false,"error":"Meilisearch health check failed"}"#,
      contentType: "application/json", status: 200)
    do {
      try await client(session).testMeilisearch(url: "http://dead.example", apiKey: nil)
      XCTFail("expected throw on ok:false")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.message, "Meilisearch health check failed")
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_testDescribe_sendsLockedProviderAndModel() async throws {
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"ok":true,"info":{"provider":"ollama","model":"gemma4:12b"}}"#.utf8), resp)
    }
    try await client(session).testDescribe(providerURL: "http://ollama.internal:11434")
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/enrichment/test-describe"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(obj["provider"] as? String, "ollama")
    XCTAssertEqual(obj["model"] as? String, "gemma4:12b")
    XCTAssertEqual(obj["url"] as? String, "http://ollama.internal:11434")
  }

  func test_testDescribe_worksWithNilURL() async throws {
    // No blank-URL guard on this row — a nil URL is valid input that lets
    // the server fall back to its own default Ollama endpoint.
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"ok":true}"#.utf8), resp)
    }
    try await client(session).testDescribe(providerURL: nil)
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/enrichment/test-describe"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertFalse(obj.keys.contains("url"))
  }

  func test_testDescribe_okFalseOn200StillThrows() async {
    let session = URLSession.stubbed(
      response: #"{"ok":false,"error":"model not found"}"#, contentType: "application/json",
      status: 200)
    do {
      try await client(session).testDescribe(providerURL: "http://dead.example")
      XCTFail("expected throw on ok:false")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.message, "model not found")
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }
}
