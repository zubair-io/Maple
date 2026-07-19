import CryptoKit
import Network
import XCTest

@testable import MapleCloudKit

/// Milestone C, Task C2: the pairing transport — TV-side `NWListener`
/// (`TVPairingListener`), phone-side delivery client (`PairingClient`), and
/// the device-session mint API call (`AuthClient.mintDeviceSession`). Builds
/// on C1's protocol core (`TVPairingSession`, `PairingCrypto`,
/// `PairingQRPayload`) — see `PairingProtocolTests.swift`.
final class PairingTransportTests: XCTestCase {
  private func sampleGrant(
    serverURL: String = "https://maple.local:8443",
    accessToken: String = "access-token-123",
    refreshToken: String = "refresh-token-456",
    deviceName: String = "Living Room TV"
  ) -> SealedPairingGrant {
    SealedPairingGrant(
      serverURL: URL(string: serverURL)!,
      accessToken: accessToken,
      refreshToken: refreshToken,
      deviceName: deviceName
    )
  }

  /// A real-network `URLSession` that is guaranteed to reach the loopback
  /// listener rather than `StubURLProtocol` — `URLProtocol.registerClass`
  /// (used by `AuthClientMintDeviceSessionTests` below, in the same test
  /// process) registers globally and intercepts `URLSession.shared` process-
  /// wide for the rest of the run. An explicit non-nil `protocolClasses`
  /// bypasses that global registration for this session only, so these
  /// loopback tests behave the same in isolation or interleaved with the
  /// stub-based AuthClient tests.
  private static func realNetworkSession() -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = []
    return URLSession(configuration: cfg)
  }

  /// Builds a payload pointed at the listener's actual bound loopback port —
  /// the listener binds to `.any` and reports the real port back from
  /// `start()`, so the QR payload used to deliver to it must be rebuilt with
  /// that resolved port (the session's own `qrPayload.port` is decorative
  /// metadata the app layer fills in separately; the listener never reads it).
  private func loopbackPayload(session: TVPairingSession, port: UInt16) -> PairingQRPayload {
    PairingQRPayload(
      v: session.qrPayload.v,
      ip: "127.0.0.1",
      port: port,
      token: session.qrPayload.token,
      tvPublicKey: session.qrPayload.tvPublicKey
    )
  }

  // MARK: 1. End-to-end loopback handshake

  func test_endToEnd_deliverThenOnPaired_secondDeliveryDoesNotRePair() throws {
    let session = TVPairingSession(ip: "192.168.1.20", port: 5443)
    let grant = sampleGrant()

    let pairedExpectation = expectation(description: "onPaired fires once")
    let receivedBox = LockedBox<SealedPairingGrant?>(nil)
    let listener = TVPairingListener(session: session) { received in
      receivedBox.value = received
      pairedExpectation.fulfill()
    }
    let port = try listener.start()
    defer { listener.stop() }

    let payload = loopbackPayload(session: session, port: port)

    let deliverExpectation = expectation(description: "first deliver succeeds")
    Task {
      try await PairingClient.deliver(grant: grant, to: payload, urlSession: Self.realNetworkSession())
      deliverExpectation.fulfill()
    }
    wait(for: [deliverExpectation, pairedExpectation], timeout: 5)
    XCTAssertEqual(receivedBox.value, grant)

    // Second delivery attempt: the listener has stopped itself after the
    // first successful redeem, so this must NOT re-invoke onPaired. Either
    // outcome (connection refused because the listener is down, or a 403
    // from a connection that slipped in before shutdown and hit
    // `alreadyUsed`) is acceptable — what matters is no second pairing.
    // If onPaired fired a second time, XCTestExpectation's built-in
    // over-fulfillment check fails the test on its own — no separate
    // assertion needed here.
    let secondAttemptExpectation = expectation(description: "second delivery fails")
    Task {
      do {
        try await PairingClient.deliver(grant: grant, to: payload, urlSession: Self.realNetworkSession())
        XCTFail("expected the second delivery to fail (listener stopped)")
      } catch {
        // Expected: connection refused (URLError) or PairingDeliveryError.rejected.
      }
      secondAttemptExpectation.fulfill()
    }
    wait(for: [secondAttemptExpectation], timeout: 5)
  }

  // MARK: 2. Wrong token doesn't burn the session

  func test_deliver_wrongToken_rejectedBadToken_thenCorrectTokenStillSucceeds() throws {
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000)
    let grant = sampleGrant()

    let pairedExpectation = expectation(description: "onPaired fires on the correct attempt")
    let receivedBox = LockedBox<SealedPairingGrant?>(nil)
    let listener = TVPairingListener(session: session) { received in
      receivedBox.value = received
      pairedExpectation.fulfill()
    }
    let port = try listener.start()
    defer { listener.stop() }

    let correctPayload = loopbackPayload(session: session, port: port)
    let wrongPayload = PairingQRPayload(
      v: correctPayload.v,
      ip: correctPayload.ip,
      port: correctPayload.port,
      token: "totally-wrong-token",
      tvPublicKey: correctPayload.tvPublicKey
    )

    let rejectedExpectation = expectation(description: "wrong token rejected")
    Task {
      do {
        try await PairingClient.deliver(grant: grant, to: wrongPayload, urlSession: Self.realNetworkSession())
        XCTFail("expected .rejected(\"badToken\")")
      } catch let error as PairingDeliveryError {
        XCTAssertEqual(error, .rejected("badToken"))
      } catch {
        XCTFail("expected PairingDeliveryError, got \(error)")
      }
      rejectedExpectation.fulfill()
    }
    wait(for: [rejectedExpectation], timeout: 5)
    XCTAssertNil(receivedBox.value, "onPaired must NOT fire on a bad-token attempt")

    let deliverExpectation = expectation(description: "correct token still succeeds")
    Task {
      try await PairingClient.deliver(grant: grant, to: correctPayload, urlSession: Self.realNetworkSession())
      deliverExpectation.fulfill()
    }
    wait(for: [deliverExpectation, pairedExpectation], timeout: 5)
    XCTAssertEqual(receivedBox.value, grant)
  }

  // MARK: 3. Malformed JSON — listener stays up

  func test_malformedJSON_rejected_listenerStaysUp() throws {
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000)
    let pairedCallCount = LockedBox<Int>(0)
    let listener = TVPairingListener(session: session) { _ in
      pairedCallCount.value += 1
    }
    let port = try listener.start()
    defer { listener.stop() }

    let malformedResponse = try sendRawHTTPRequest(
      port: port,
      method: "POST",
      path: "/pair",
      body: Data("{ this is not valid json".utf8)
    )
    XCTAssertTrue(
      malformedResponse.status == 403 || malformedResponse.status == 404,
      "expected 403 or 404 for malformed JSON, got \(malformedResponse.status)")
    XCTAssertEqual(pairedCallCount.value, 0, "onPaired must NOT fire on a malformed request")

    // Listener must still be up: a well-formed follow-up request gets a real
    // HTTP response (not a connection failure) and DOES redeem.
    let grant = sampleGrant()
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      grant, to: session.qrPayload.tvPublicKey, pairingToken: session.qrPayload.token)

    let goodBody = try JSONSerialization.data(withJSONObject: [
      "token": session.qrPayload.token,
      "senderPublicKey": senderPublicKey.base64EncodedString(),
      "ciphertext": ciphertext.base64EncodedString(),
    ])
    let goodResponse = try sendRawHTTPRequest(port: port, method: "POST", path: "/pair", body: goodBody)
    XCTAssertEqual(goodResponse.status, 200)
    XCTAssertEqual(pairedCallCount.value, 1, "the well-formed follow-up must redeem successfully")
  }

  // MARK: 3b. Negative / non-numeric Content-Length — listener stays up (C2 review)

  /// `Content-Length: -1` on a raw hand-built request. The parser used to do
  /// `Int(...) ?? length` with no non-negative check, so `bodyStart +
  /// contentLength < bodyStart` and `parseCompleteRequest` formed an inverted
  /// `Range` (`bodyStart..<(bodyStart - 1)`) — a Swift Range with lowerBound
  /// > upperBound traps the process (SIGTRAP / exit 133). This is an
  /// unauthenticated LAN DoS: any device on the network that can reach the
  /// pairing port can kill the TV app by sending one malformed header.
  func test_negativeContentLength_rejected_listenerStaysUp() throws {
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000)
    let pairedCallCount = LockedBox<Int>(0)
    let listener = TVPairingListener(session: session) { _ in
      pairedCallCount.value += 1
    }
    let port = try listener.start()
    defer { listener.stop() }

    let negativeResponse = try sendRawHTTPRequestWithExplicitContentLength(
      port: port, method: "POST", path: "/pair", body: Data("{}".utf8), contentLength: "-1")
    XCTAssertTrue(
      negativeResponse.status == 403 || negativeResponse.status == 404,
      "expected 403 or 404 for a negative Content-Length, got \(negativeResponse.status)")
    XCTAssertEqual(pairedCallCount.value, 0, "onPaired must NOT fire on a malformed Content-Length")

    // Listener must still be up — proves liveness, not just "didn't crash
    // this one connection."
    let grant = sampleGrant()
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      grant, to: session.qrPayload.tvPublicKey, pairingToken: session.qrPayload.token)
    let goodBody = try JSONSerialization.data(withJSONObject: [
      "token": session.qrPayload.token,
      "senderPublicKey": senderPublicKey.base64EncodedString(),
      "ciphertext": ciphertext.base64EncodedString(),
    ])
    let goodResponse = try sendRawHTTPRequest(port: port, method: "POST", path: "/pair", body: goodBody)
    XCTAssertEqual(goodResponse.status, 200)
    XCTAssertEqual(pairedCallCount.value, 1, "the well-formed follow-up must redeem successfully")
  }

  /// Non-numeric `Content-Length` (e.g. `Content-Length: banana`) — the old
  /// `Int(...) ?? length` fallback silently treated this as "no header seen"
  /// (falling back to the running accumulator, which starts at 0), so this
  /// case did not itself trap. Covered anyway as a malformed-input sibling
  /// of the negative case, to lock in "reject, don't guess" behavior.
  func test_nonNumericContentLength_rejected_listenerStaysUp() throws {
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000)
    let pairedCallCount = LockedBox<Int>(0)
    let listener = TVPairingListener(session: session) { _ in
      pairedCallCount.value += 1
    }
    let port = try listener.start()
    defer { listener.stop() }

    let badResponse = try sendRawHTTPRequestWithExplicitContentLength(
      port: port, method: "POST", path: "/pair", body: Data("{}".utf8), contentLength: "banana")
    XCTAssertTrue(
      badResponse.status == 403 || badResponse.status == 404,
      "expected 403 or 404 for a non-numeric Content-Length, got \(badResponse.status)")
    XCTAssertEqual(pairedCallCount.value, 0, "onPaired must NOT fire on a malformed Content-Length")

    let grant = sampleGrant()
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      grant, to: session.qrPayload.tvPublicKey, pairingToken: session.qrPayload.token)
    let goodBody = try JSONSerialization.data(withJSONObject: [
      "token": session.qrPayload.token,
      "senderPublicKey": senderPublicKey.base64EncodedString(),
      "ciphertext": ciphertext.base64EncodedString(),
    ])
    let goodResponse = try sendRawHTTPRequest(port: port, method: "POST", path: "/pair", body: goodBody)
    XCTAssertEqual(goodResponse.status, 200)
    XCTAssertEqual(pairedCallCount.value, 1, "the well-formed follow-up must redeem successfully")
  }

  /// Also exercises the 404 branch and confirms unknown paths don't crash
  /// or hang the listener.
  func test_unknownPath_returns404_listenerStaysUp() throws {
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000)
    let listener = TVPairingListener(session: session) { _ in }
    let port = try listener.start()
    defer { listener.stop() }

    let response = try sendRawHTTPRequest(port: port, method: "GET", path: "/", body: Data())
    XCTAssertEqual(response.status, 404)
  }

  // MARK: 4. stop() teardown must not depend on wrapper lifetime (C3 review)
  //
  // A regression test was attempted here — call `stop()` then immediately
  // drop the last strong reference (the exact `PairingViewModel` regenerate
  // pattern: `listener?.stop(); listener = nil`), then assert a brand-new
  // `NWListener` can rebind the same port once the original is torn down.
  // Investigated empirically and abandoned: even a completely vanilla
  // `NWListener().cancel()` with zero connections ever made does not make
  // its bound wildcard port rebindable within two minutes on this platform
  // (verified standalone, outside any `TVPairingListener` code) — a
  // Network.framework/NECP quirk unrelated to this fix, not a signal this
  // test could actually key off. A flaky-in-the-literal-sense test wasn't
  // the failure mode; the port-rebind probe never once succeeded, so no
  // timeout would make it a meaningful assertion. Per the "do not ship a
  // flaky test" guidance, this is intentionally not covered by an
  // automated test — correctness rests on the strong-local-capture
  // reasoning documented on `TVPairingListener.stop()` and `deinit`
  // (capture the `NWListener` into the queued closure by value, so
  // cancellation never depends on `self` still being alive when the
  // closure runs).

  // MARK: Carry-forward from C1 review — wrong-length tvPublicKey

  func test_deliver_wrongLengthTVPublicKey_throwsCleanClientError() async throws {
    let grant = sampleGrant()
    let payload = PairingQRPayload(
      v: 1,
      ip: "127.0.0.1",
      port: 12345,
      token: "some-token",
      tvPublicKey: Data([0x01, 0x02, 0x03])  // not 32 bytes
    )

    do {
      try await PairingClient.deliver(grant: grant, to: payload, urlSession: Self.realNetworkSession())
      XCTFail("expected a clean PairingDeliveryError")
    } catch let error as PairingDeliveryError {
      XCTAssertEqual(error, .invalidTVPublicKey)
    } catch {
      XCTFail("wrong-length tvPublicKey must surface as PairingDeliveryError, not \(type(of: error)): \(error)")
    }
  }

  // MARK: - Raw HTTP helper (for malformed-body / wrong-method cases PairingClient can't express)

  private struct RawHTTPResponse {
    let status: Int
    let body: Data
  }

  private func sendRawHTTPRequest(port: UInt16, method: String, path: String, body: Data) throws -> RawHTTPResponse {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!, timeoutInterval: 5)
    request.httpMethod = method
    request.httpBody = body.isEmpty ? nil : body
    if !body.isEmpty {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    let semaphore = DispatchSemaphore(value: 0)
    let resultBox = LockedBox<Result<RawHTTPResponse, Error>?>(nil)
    let task = Self.realNetworkSession().dataTask(with: request) { data, response, error in
      if let error {
        resultBox.value = .failure(error)
      } else if let http = response as? HTTPURLResponse {
        resultBox.value = .success(RawHTTPResponse(status: http.statusCode, body: data ?? Data()))
      } else {
        resultBox.value = .failure(URLError(.badServerResponse))
      }
      semaphore.signal()
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + 5)
    return try XCTUnwrap(resultBox.value).get()
  }

  /// Sends a raw HTTP request over a bare TCP socket with a hand-written
  /// `Content-Length` header value of our choosing (`"-1"`, `"banana"`, …).
  /// `URLRequest`/`URLSession` treat `Content-Length` as a reserved header —
  /// they always recompute it from the real body — so there is no way to get
  /// an invalid value onto the wire through `sendRawHTTPRequest` above. This
  /// bypasses `URLSession` entirely and speaks HTTP/1.1 by hand over
  /// `NWConnection`, the same transport the listener itself uses.
  private func sendRawHTTPRequestWithExplicitContentLength(
    port: UInt16, method: String, path: String, body: Data, contentLength: String
  ) throws -> RawHTTPResponse {
    var head = "\(method) \(path) HTTP/1.1\r\n"
    head += "Host: 127.0.0.1:\(port)\r\n"
    head += "Content-Type: application/json\r\n"
    head += "Content-Length: \(contentLength)\r\n"
    head += "Connection: close\r\n\r\n"
    var requestData = Data(head.utf8)
    requestData.append(body)

    let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    let queue = DispatchQueue(label: "pairing-listener-test-raw-socket")
    let resultBox = LockedBox<Result<RawHTTPResponse, Error>?>(nil)
    let doneSemaphore = DispatchSemaphore(value: 0)
    var received = Data()

    func receiveLoop() {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
        if let data, !data.isEmpty {
          received.append(data)
        }
        if isComplete || error != nil {
          resultBox.value = Self.parseRawResponse(received)
          connection.cancel()
          doneSemaphore.signal()
          return
        }
        receiveLoop()
      }
    }

    connection.stateUpdateHandler = { state in
      switch state {
      case .ready:
        connection.send(
          content: requestData,
          completion: .contentProcessed { _ in
            receiveLoop()
          })
      case .failed(let error):
        resultBox.value = .failure(error)
        doneSemaphore.signal()
      default:
        break
      }
    }
    connection.start(queue: queue)
    _ = doneSemaphore.wait(timeout: .now() + 5)
    connection.cancel()
    return try XCTUnwrap(resultBox.value).get()
  }

  private static func parseRawResponse(_ data: Data) -> Result<RawHTTPResponse, Error> {
    let separator = Data("\r\n\r\n".utf8)
    guard let separatorRange = data.range(of: separator),
      let headerString = String(data: data[..<separatorRange.lowerBound], encoding: .utf8),
      let statusLine = headerString.components(separatedBy: "\r\n").first
    else {
      return .failure(URLError(.badServerResponse))
    }
    let statusParts = statusLine.split(separator: " ")
    guard statusParts.count >= 2, let status = Int(statusParts[1]) else {
      return .failure(URLError(.badServerResponse))
    }
    let body = data[separatorRange.upperBound...]
    return .success(RawHTTPResponse(status: status, body: Data(body)))
  }
}

/// Minimal thread-safe box — the listener's `onPaired` callback fires on a
/// background `DispatchQueue`, and these tests read/write the captured value
/// from the XCTest main thread.
private final class LockedBox<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var _value: T
  init(_ initial: T) { self._value = initial }
  var value: T {
    get { lock.lock(); defer { lock.unlock() }; return _value }
    set { lock.lock(); defer { lock.unlock() }; _value = newValue }
  }
}

// MARK: - AuthClient.mintDeviceSession

final class AuthClientMintDeviceSessionTests: XCTestCase {
  private let server = URL(string: "https://mint-test.invalid:8443")!

  override func setUp() {
    StubURLProtocol.register()
    StubURLProtocol.reset()
  }

  override func tearDown() {
    StubURLProtocol.reset()
  }

  func test_mintDeviceSession_postsExactBody_bearerHeader_decodesResponse() async throws {
    let client = AuthClient(server: server, urlSession: TestURLSession.make())

    let capturedRequest = LockedBox<URLRequest?>(nil)
    StubURLProtocol.responder = { req in
      capturedRequest.value = req
      return .http(
        status: 200,
        body: Data(#"{"id":"ds_1","access_token":"A_TV","refresh_token":"R_TV"}"#.utf8))
    }

    let mint = try await client.mintDeviceSession(
      accessToken: "A1", refreshToken: "R1", label: "Living Room TV")

    XCTAssertEqual(mint.id, "ds_1")
    XCTAssertEqual(mint.access_token, "A_TV")
    XCTAssertEqual(mint.refresh_token, "R_TV")

    let req = try XCTUnwrap(capturedRequest.value)
    XCTAssertEqual(req.url?.path, "/api/auth/device-sessions")
    XCTAssertEqual(req.httpMethod, "POST")
    XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer A1")

    let bodyData = try XCTUnwrap(req.httpBody ?? Self.readBodyStream(req))
    let bodyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: bodyData) as? [String: String])
    XCTAssertEqual(bodyJSON["label"], "Living Room TV")
    XCTAssertEqual(bodyJSON["platform"], "tvos")
    XCTAssertEqual(bodyJSON["refresh_token"], "R1")
    XCTAssertEqual(bodyJSON.count, 3, "body must carry exactly {label, platform, refresh_token}")
  }

  func test_mintDeviceSession_403_throwsForbidden() async throws {
    let client = AuthClient(server: server, urlSession: TestURLSession.make())
    StubURLProtocol.responder = { _ in .http(status: 403, body: Data(#"{"error":"family_revoked"}"#.utf8)) }

    do {
      _ = try await client.mintDeviceSession(accessToken: "A1", refreshToken: "R1", label: "Bedroom TV")
      XCTFail("expected AuthClientError.forbidden")
    } catch let error as AuthClientError {
      guard case .forbidden = error else {
        XCTFail("expected .forbidden, got \(error)")
        return
      }
    }
  }

  /// `URLSession` sometimes hands `URLProtocol` the request body as
  /// `httpBodyStream` rather than `httpBody` — observed here even for a
  /// small in-memory `Data` body set via `postJSON`. Drains the stream into
  /// `Data` so the test can assert on the exact JSON keys regardless of
  /// which representation this URLSession version chose.
  private static func readBodyStream(_ req: URLRequest) -> Data? {
    guard let stream = req.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let bufferSize = 4096
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: bufferSize)
      if read <= 0 { break }
      data.append(buffer, count: read)
    }
    return data.isEmpty ? nil : data
  }
}
