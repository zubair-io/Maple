// LocalNetworkResolverTests.swift
//
// Covers `LocalNetworkResolving.resolveEffectiveURL`'s fallback contract
// (report unavailable / probe fails / fetch fails all fall back to the
// identity URL) and `LocalNetworkResolver`'s default-state / cache behavior.

import XCTest
@testable import MapleCore

final class LocalNetworkResolverTests: XCTestCase {
  private let identity = URL(string: "https://public.example.com")!

  func test_resolveEffectiveURL_returnsIdentity_whenReportUnavailable() async {
    let session = URLSession.stubbedSequence { req in
      (Data(#"{"available":false}"#.utf8), Self.okResponse(for: req))
    }
    let effective = await LocalNetworkResolving.resolveEffectiveURL(identity: identity, session: session)
    XCTAssertEqual(effective, identity)
  }

  func test_resolveEffectiveURL_returnsCandidate_whenReachable() async {
    let session = URLSession.stubbedSequence { req in
      // The reachability probe (against the candidate) only checks the
      // HTTP status, not the body — a single "available" response for
      // every request (report fetch + probe) is sufficient here.
      let body = #"{"available":true,"ip":"192.168.1.42","port":3000,"scheme":"http"}"#
      return (Data(body.utf8), Self.okResponse(for: req))
    }
    let effective = await LocalNetworkResolving.resolveEffectiveURL(identity: identity, session: session)
    XCTAssertEqual(effective, URL(string: "http://192.168.1.42:3000")!)
  }

  func test_resolveEffectiveURL_returnsIdentity_whenProbeUnreachable() async {
    nonisolated(unsafe) var callCount = 0
    let session = URLSession.stubbedSequence { req in
      callCount += 1
      if callCount == 1 {
        // Report fetch (against identity) succeeds with a candidate.
        let body = #"{"available":true,"ip":"192.168.1.42","port":3000,"scheme":"http"}"#
        return (Data(body.utf8), Self.okResponse(for: req))
      }
      // Reachability probe against the candidate fails (503).
      return (Data(), HTTPURLResponse(url: req.url!, statusCode: 503, httpVersion: "HTTP/1.1", headerFields: [:])!)
    }
    let effective = await LocalNetworkResolving.resolveEffectiveURL(identity: identity, session: session)
    XCTAssertEqual(effective, identity)
  }

  func test_resolveEffectiveURL_returnsIdentity_whenReportFetchFails() async {
    let session = URLSession.stubbedSequence { req in
      (Data(), HTTPURLResponse(url: req.url!, statusCode: 500, httpVersion: "HTTP/1.1", headerFields: [:])!)
    }
    let effective = await LocalNetworkResolving.resolveEffectiveURL(identity: identity, session: session)
    XCTAssertEqual(effective, identity)
  }

  func test_resolveEffectiveURL_returnsIdentity_whenReportBodyUndecodable() async {
    let session = URLSession.stubbedSequence { req in
      (Data("not json".utf8), Self.okResponse(for: req))
    }
    let effective = await LocalNetworkResolving.resolveEffectiveURL(identity: identity, session: session)
    XCTAssertEqual(effective, identity)
  }

  @MainActor
  func test_localNetworkResolver_effectiveURL_returnsIdentity_beforeAnyResolveCall() {
    let resolver = LocalNetworkResolver()
    XCTAssertEqual(resolver.effectiveURL(for: identity), identity)
  }

  @MainActor
  func test_localNetworkResolver_effectiveURL_returnsCachedResultAfterResolve() async {
    let session = URLSession.stubbedSequence { req in
      let body = #"{"available":true,"ip":"10.0.0.5","port":3000,"scheme":"http"}"#
      return (Data(body.utf8), Self.okResponse(for: req))
    }
    let resolver = LocalNetworkResolver()
    await resolver.resolve(identity: identity, session: session)
    XCTAssertEqual(resolver.effectiveURL(for: identity), URL(string: "http://10.0.0.5:3000")!)
  }

  @MainActor
  func test_localNetworkResolver_effectiveURL_fallsBackToIdentity_whenUnreachable() async {
    let session = URLSession.stubbedSequence { req in
      (Data(#"{"available":false}"#.utf8), Self.okResponse(for: req))
    }
    let resolver = LocalNetworkResolver()
    await resolver.resolve(identity: identity, session: session)
    XCTAssertEqual(resolver.effectiveURL(for: identity), identity)
  }

  private static func okResponse(for req: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
      url: req.url!, statusCode: 200,
      httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
  }
}
