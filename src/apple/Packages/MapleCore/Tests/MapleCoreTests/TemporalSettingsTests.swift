// TemporalSettingsTests.swift
//
// GET/PUT /api/workers/temporal (#5826): the status wire shape, the PUT
// request and its error mapping, and the form rules the Workers page relies
// on — seed the draft once, discard responses issued before a save, and poll
// faster while the worker tier has not reported.

import XCTest

@testable import MapleCloudKit
@testable import MapleCore

private func jsonResponse(_ req: URLRequest, _ json: String, status: Int = 200) -> (
  Data, HTTPURLResponse
) {
  let resp = HTTPURLResponse(
    url: req.url!, statusCode: status, httpVersion: "HTTP/1.1",
    headerFields: ["Content-Type": "application/json"])!
  return (Data(json.utf8), resp)
}

private func settings(
  address: String = "127.0.0.1:7233", namespace: String = "default",
  state: TemporalConnectionState = .connected, error: String? = nil
) -> TemporalSettings {
  TemporalSettings(
    address: address, namespace: namespace,
    connection: TemporalConnection(state: state, error: error))
}

final class TemporalSettingsDecodingTests: XCTestCase {

  func test_decode_connected_convertsEpochMillisToDate() throws {
    let json = """
      {"address":"temporal:7233","namespace":"maple",
       "connection":{"state":"connected","error":null,"checkedAt":1700000000500}}
      """
    let s = try JSONDecoder().decode(TemporalSettings.self, from: Data(json.utf8))
    XCTAssertEqual(s.address, "temporal:7233")
    XCTAssertEqual(s.namespace, "maple")
    XCTAssertEqual(s.connection.state, .connected)
    XCTAssertNil(s.connection.error)
    XCTAssertEqual(s.connection.checkedAt, Date(timeIntervalSince1970: 1_700_000_000.5))
    XCTAssertEqual(s.connection.label, "Connected")
    XCTAssertTrue(s.connection.detail?.hasPrefix("Last checked ") ?? false)
  }

  func test_decode_unknownWithNullCheckedAt() throws {
    let json = """
      {"address":"127.0.0.1:7233","namespace":"default",
       "connection":{"state":"unknown","error":null,"checkedAt":null}}
      """
    let s = try JSONDecoder().decode(TemporalSettings.self, from: Data(json.utf8))
    XCTAssertEqual(s.connection.state, .unknown)
    XCTAssertNil(s.connection.checkedAt)
    XCTAssertEqual(s.connection.label, "Connecting")
  }

  func test_decode_unrecognisedStateFallsBackToUnknown() throws {
    let json = """
      {"address":"a:1","namespace":"n",
       "connection":{"state":"degraded","error":null,"checkedAt":null}}
      """
    let s = try JSONDecoder().decode(TemporalSettings.self, from: Data(json.utf8))
    XCTAssertEqual(s.connection.state, .unknown)
  }

  func test_unreachable_detailIsTheServerError() {
    let s = settings(state: .unreachable, error: "connect ECONNREFUSED 127.0.0.1:7233")
    XCTAssertEqual(s.connection.label, "Unreachable")
    XCTAssertEqual(s.connection.detail, "connect ECONNREFUSED 127.0.0.1:7233")
  }

  func test_unreachable_withoutErrorFallsBackToGenericDetail() {
    XCTAssertEqual(
      settings(state: .unreachable).connection.detail,
      "Maple could not reach this Temporal server.")
  }

  func test_connected_withoutCheckedAtHasNoDetail() {
    XCTAssertNil(settings(state: .connected).connection.detail)
  }

  func test_connectionDetail_namesTheSavedTarget() {
    XCTAssertEqual(
      settings(address: "temporal:7233", namespace: "maple", state: .connected).connectionDetail,
      "temporal:7233 · maple")
    XCTAssertEqual(
      settings(address: "temporal:7233", namespace: "maple", state: .unreachable, error: "refused")
        .connectionDetail,
      "temporal:7233 · maple — refused")
  }

  func test_pollDelay_fastWhileUnreported_slowOnceSettled() {
    XCTAssertEqual(settings(state: .unknown).nextPollDelay, .seconds(2))
    XCTAssertEqual(settings(state: .connected).nextPollDelay, .seconds(10))
    XCTAssertEqual(settings(state: .unreachable).nextPollDelay, .seconds(10))
  }

  func test_target_trimsAndRejectsBlankFields() {
    XCTAssertEqual(
      TemporalTarget(address: "  temporal:7233 ", namespace: "\tmaple\n")?.address,
      "temporal:7233")
    XCTAssertEqual(
      TemporalTarget(address: "  temporal:7233 ", namespace: "\tmaple\n")?.namespace, "maple")
    XCTAssertNil(TemporalTarget(address: "   ", namespace: "maple"))
    XCTAssertNil(TemporalTarget(address: "temporal:7233", namespace: ""))
  }
}

final class TemporalSettingsFormTests: XCTestCase {

  func test_firstAdoptSeedsDraft() {
    var form = TemporalSettingsForm()
    form.adopt(settings(address: "temporal:7233", namespace: "maple"), token: 0)
    XCTAssertEqual(form.address, "temporal:7233")
    XCTAssertEqual(form.namespace, "maple")
  }

  func test_laterPollRefreshesStatusButKeepsEdits() {
    var form = TemporalSettingsForm()
    form.adopt(settings(state: .unknown), token: 0)
    form.address = "edited:7233"
    form.adopt(settings(address: "server:7233", state: .connected), token: 0)
    XCTAssertEqual(form.address, "edited:7233")
    XCTAssertEqual(form.settings?.address, "server:7233")
    XCTAssertEqual(form.settings?.connection.state, .connected)
  }

  func test_readIssuedBeforeSaveIsDiscarded() {
    var form = TemporalSettingsForm()
    form.adopt(settings(state: .connected), token: 0)
    let staleToken = form.generation
    let saveToken = form.beginSave()
    form.adopt(settings(address: "old:7233", state: .connected), token: staleToken)
    XCTAssertEqual(form.settings?.address, "127.0.0.1:7233")
    form.adopt(settings(address: "new:7233", state: .unknown), token: saveToken)
    XCTAssertEqual(form.settings?.address, "new:7233")
    XCTAssertEqual(form.settings?.connection.state, .unknown)
  }

  func test_targetIsNilWhileAFieldIsBlank() {
    var form = TemporalSettingsForm()
    form.adopt(settings(), token: 0)
    XCTAssertNotNil(form.target)
    form.namespace = "  "
    XCTAssertNil(form.target)
  }
}

final class TemporalSettingsClientTests: XCTestCase {
  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> WorkersAdminClient {
    WorkersAdminClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  private let statusJSON = """
    {"address":"temporal:7233","namespace":"maple",
     "connection":{"state":"unknown","error":null,"checkedAt":null}}
    """

  func test_temporal_getsStatus() async throws {
    nonisolated(unsafe) var captured: URLRequest?
    let session = URLSession.stubbedSequence { req in
      captured = req
      return jsonResponse(req, self.statusJSON)
    }
    let result = try await client(session).temporal()
    XCTAssertEqual(captured?.url?.path, "/api/workers/temporal")
    XCTAssertEqual(captured?.httpMethod, "GET")
    XCTAssertEqual(result.address, "temporal:7233")
  }

  func test_saveTemporal_putsTrimmedTargetAsJSON() async throws {
    nonisolated(unsafe) var captured: URLRequest?
    let session = URLSession.stubbedSequence { req in
      captured = req
      return jsonResponse(req, self.statusJSON)
    }
    let target = try XCTUnwrap(TemporalTarget(address: " temporal:7233 ", namespace: "maple "))
    let result = try await client(session).saveTemporal(target)
    XCTAssertEqual(captured?.url?.path, "/api/workers/temporal")
    XCTAssertEqual(captured?.httpMethod, "PUT")
    XCTAssertEqual(captured?.value(forHTTPHeaderField: "Content-Type"), "application/json")
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/workers/temporal"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
    XCTAssertEqual(obj, ["address": "temporal:7233", "namespace": "maple"])
    XCTAssertEqual(result.connection.state, .unknown)
  }

  func test_saveTemporal_invalidAddressSurfacesServerMessage() async throws {
    let session = URLSession.stubbed(
      response: #"{"error":"The address must be host:port, for example temporal:7233"}"#,
      status: 400)
    let target = try XCTUnwrap(TemporalTarget(address: "temporal", namespace: "maple"))
    do {
      _ = try await client(session).saveTemporal(target)
      XCTFail("expected throw")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 400)
      XCTAssertEqual(error.message, "The address must be host:port, for example temporal:7233")
      XCTAssertEqual(
        error.localizedDescription, "The address must be host:port, for example temporal:7233")
    }
  }

  func test_saveTemporal_memberGetsForbidden() async throws {
    let session = URLSession.stubbed(response: #"{"error":"Forbidden"}"#, status: 403)
    let target = try XCTUnwrap(TemporalTarget(address: "temporal:7233", namespace: "maple"))
    do {
      _ = try await client(session).saveTemporal(target)
      XCTFail("expected throw")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 403)
    }
  }
}
