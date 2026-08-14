// NetworkConfigClientTests.swift
//
// Wire-shape coverage for the Network settings API (#2766). The
// resolution logic lives server-side in network-config.repo.ts — this
// client is "fetch JSON, decode, surface errors", plus one encoding rule
// that matters: an explicit null clears an override, so the PUT body must
// carry nulls rather than omitting the keys.

import XCTest
@testable import MapleCore

final class NetworkConfigTypesTests: XCTestCase {

  func test_decode_autoDetectedConfig() throws {
    let json = """
    {"enabled":true,"local_ip":"192.168.1.42","local_port":3000,
     "source":{"local_ip":"auto_detected","local_port":"default"}}
    """
    let cfg = try JSONDecoder().decode(NetworkConfig.self, from: Data(json.utf8))
    XCTAssertTrue(cfg.enabled)
    XCTAssertEqual(cfg.localIP, "192.168.1.42")
    XCTAssertEqual(cfg.localPort, 3000)
    XCTAssertEqual(cfg.source.localIP, .autoDetected)
    XCTAssertEqual(cfg.source.localPort, .defaultValue)
  }

  func test_decode_nullIPAndUnavailableSource() throws {
    let json = """
    {"enabled":false,"local_ip":null,"local_port":3000,
     "source":{"local_ip":"unavailable","local_port":"default"}}
    """
    let cfg = try JSONDecoder().decode(NetworkConfig.self, from: Data(json.utf8))
    XCTAssertNil(cfg.localIP)
    XCTAssertEqual(cfg.source.localIP, .unavailable)
  }

  func test_decode_unknownSourceDoesNotThrow() throws {
    // Server-side version skew must degrade to a neutral label rather
    // than failing the whole page.
    let json = """
    {"enabled":true,"local_ip":"10.0.0.5","local_port":3000,
     "source":{"local_ip":"something_new","local_port":"default"}}
    """
    let cfg = try JSONDecoder().decode(NetworkConfig.self, from: Data(json.utf8))
    XCTAssertEqual(cfg.source.localIP, .unknown)
  }

  func test_encode_patchEmitsExplicitNulls() throws {
    // Omitting the key leaves the stored override in place server-side,
    // so "clear the override" MUST serialize as null, not as absence.
    let patch = NetworkConfigPatch(enabled: true, localIPOverride: nil, localPortOverride: nil)
    let data = try JSONEncoder().encode(patch)
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertTrue(obj.keys.contains("local_ip_override"))
    XCTAssertTrue(obj.keys.contains("local_port_override"))
    XCTAssertTrue(obj["local_ip_override"] is NSNull)
    XCTAssertTrue(obj["local_port_override"] is NSNull)
    XCTAssertEqual(obj["enabled"] as? Bool, true)
  }

  func test_encode_patchEmitsValues() throws {
    let patch = NetworkConfigPatch(
      enabled: true, localIPOverride: "192.168.1.9", localPortOverride: 8080)
    let data = try JSONEncoder().encode(patch)
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(obj["local_ip_override"] as? String, "192.168.1.9")
    XCTAssertEqual(obj["local_port_override"] as? Int, 8080)
  }
}

final class NetworkConfigClientTests: XCTestCase {

  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> NetworkConfigClient {
    NetworkConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_fetch_targetsConfigPathAndDecodes() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    nonisolated(unsafe) var capturedMethod: String?
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      capturedMethod = req.httpMethod
      let json = """
      {"enabled":true,"local_ip":"192.168.1.42","local_port":3000,
       "source":{"local_ip":"db_override","local_port":"db_override"}}
      """
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let cfg = try await client(session).fetch()
    XCTAssertEqual(capturedURL?.path, "/api/network/config")
    XCTAssertEqual(capturedMethod, "GET")
    XCTAssertEqual(cfg.localIP, "192.168.1.42")
    XCTAssertEqual(cfg.source.localIP, .dbOverride)
  }

  func test_save_sendsPutWithJSONBody() async throws {
    nonisolated(unsafe) var capturedMethod: String?
    nonisolated(unsafe) var capturedContentType: String?
    let session = URLSession.stubbedSequence { req in
      capturedMethod = req.httpMethod
      capturedContentType = req.value(forHTTPHeaderField: "Content-Type")
      let json = """
      {"enabled":true,"local_ip":"10.0.0.5","local_port":8080,
       "source":{"local_ip":"db_override","local_port":"db_override"}}
      """
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let cfg = try await client(session).save(
      NetworkConfigPatch(enabled: true, localIPOverride: "10.0.0.5", localPortOverride: 8080))
    XCTAssertEqual(capturedMethod, "PUT")
    XCTAssertEqual(capturedContentType, "application/json")
    // URLProtocol strips the body off the request once the loader takes
    // it; URLProtocolStub captures it for us, keyed on the URL string.
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/network/config"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(obj["local_ip_override"] as? String, "10.0.0.5")
    XCTAssertEqual(obj["local_port_override"] as? Int, 8080)
    XCTAssertEqual(cfg.localPort, 8080)
  }

  func test_save_400SurfacesServerMessage() async {
    let session = URLSession.stubbed(
      response: #"{"error":"Invalid local_port_override: must be an integer between 1 and 65535"}"#,
      contentType: "application/json",
      status: 400)
    do {
      _ = try await client(session).save(
        NetworkConfigPatch(enabled: true, localIPOverride: nil, localPortOverride: 99999))
      XCTFail("expected throw on 400")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 400)
      XCTAssertTrue(error.message.contains("must be an integer between 1 and 65535"))
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }

  func test_fetch_nonJSONErrorBodyStillSurfaces() async {
    let session = URLSession.stubbed(
      response: "<html>502 Bad Gateway</html>", contentType: "text/html", status: 502)
    do {
      _ = try await client(session).fetch()
      XCTFail("expected throw on 502")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 502)
      XCTAssertFalse(error.message.isEmpty)
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }
}
