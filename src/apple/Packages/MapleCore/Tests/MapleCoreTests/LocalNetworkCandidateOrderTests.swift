import XCTest

@testable import MapleCloudKit

final class LocalNetworkCandidateOrderTests: XCTestCase {
  private let hostname = LocalHttpsEndpoint(ip: "local.example.com", port: 3443, scheme: "https")
  private let address = LocalHttpsEndpoint(ip: "192.168.1.42", port: 3000, scheme: "http")
  private let httpIdentity = URL(string: "http://public.example.com")!
  private let httpsIdentity = URL(string: "https://public.example.com")!

  private let bothAdvertised =
    #"{"available":true,"ip":"192.168.1.42","port":3000,"scheme":"http","https":{"ip":"local.example.com","port":3443,"scheme":"https"}}"#
  private let addressOnly = #"{"available":true,"ip":"192.168.1.42","port":3000,"scheme":"http"}"#

  private func session(serving body: String) -> URLSession {
    URLSession.stubbedSequence { req in
      (
        Data(body.utf8),
        HTTPURLResponse(
          url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
      )
    }
  }

  private func resolve(
    _ identity: URL, report: String, answering answers: @escaping @Sendable (String) -> Bool
  ) async -> (result: (effectiveURL: URL, status: LocalNetworkStatus), probed: [String]) {
    let probed = LockedValue<[String]>([])
    let result = await LocalNetworkResolving.resolveStatus(
      identity: identity, session: session(serving: report)
    ) { endpoint in
      probed.mutate { $0.append(endpoint.ip) }
      return answers(endpoint.ip)
    }
    return (result, probed.value)
  }

  func test_theAddressIsNeverProbedWhileTheHostnameAnswers() async {
    let outcome = await resolve(httpIdentity, report: bothAdvertised) { _ in true }
    XCTAssertEqual(outcome.probed, [hostname.ip])
    XCTAssertEqual(outcome.result.effectiveURL, URL(string: "https://local.example.com:3443"))
  }

  func test_theAddressIsProbedOnlyAfterTheHostnameFails() async {
    let outcome = await resolve(httpIdentity, report: bothAdvertised) { $0 == "192.168.1.42" }
    XCTAssertEqual(outcome.probed, [hostname.ip, address.ip])
    XCTAssertEqual(outcome.result.effectiveURL, URL(string: "http://192.168.1.42:3000"))
    XCTAssertTrue(outcome.result.status.isConnectedLocally)
  }

  func test_theAddressIsProbedWhenThereIsNoHostnameCandidate() async {
    let outcome = await resolve(httpIdentity, report: addressOnly) { _ in true }
    XCTAssertEqual(outcome.probed, [address.ip])
    XCTAssertEqual(outcome.result.effectiveURL, URL(string: "http://192.168.1.42:3000"))
  }

  func test_bothCandidatesFailingFallsBackToTheIdentityAfterProbingEachOnce() async {
    let outcome = await resolve(httpIdentity, report: bothAdvertised) { _ in false }
    XCTAssertEqual(outcome.probed, [hostname.ip, address.ip])
    XCTAssertEqual(outcome.result.effectiveURL, httpIdentity)
    XCTAssertFalse(outcome.result.status.isConnectedLocally)
  }

  func test_anHTTPSIdentityNeverProbesTheCleartextCandidate() async {
    let outcome = await resolve(httpsIdentity, report: bothAdvertised) { $0 == "192.168.1.42" }
    XCTAssertEqual(outcome.probed, [hostname.ip])
    XCTAssertEqual(outcome.result.effectiveURL, httpsIdentity)
    XCTAssertFalse(outcome.result.status.isConnectedLocally)
  }

  func test_cancellingWhileTheHostnameIsProbedNeverStartsTheAddressProbe() async {
    let probed = LockedValue<[String]>([])
    let resolution = Task { [hostname, address] in
      await LocalNetworkResolving.firstAnsweringCandidate(of: [hostname, address]) { endpoint in
        probed.mutate { $0.append(endpoint.ip) }
        while !Task.isCancelled { await Task.yield() }
        return false
      }
    }
    let hostnameStarted = await pollUntil { probed.value.count == 1 }
    XCTAssertTrue(hostnameStarted)
    resolution.cancel()
    let result = await resolution.value
    XCTAssertNil(result)
    XCTAssertEqual(probed.value, [hostname.ip])
  }

  func test_confirmRoute_acceptsARouteTheServerStillAdvertises() async {
    let confirmed = await LocalNetworkResolving.confirmRoute(
      URL(string: "https://local.example.com:3443")!, session: session(serving: bothAdvertised))
    let confirmedAddress = await LocalNetworkResolving.confirmRoute(
      URL(string: "http://192.168.1.42:3000")!, session: session(serving: bothAdvertised))
    XCTAssertTrue(confirmed)
    XCTAssertTrue(confirmedAddress)
  }

  func test_confirmRoute_rejectsARouteTheServerNoLongerAdvertises() async {
    let moved = await LocalNetworkResolving.confirmRoute(
      URL(string: "http://192.168.1.99:3000")!, session: session(serving: bothAdvertised))
    XCTAssertFalse(moved)
  }
}
