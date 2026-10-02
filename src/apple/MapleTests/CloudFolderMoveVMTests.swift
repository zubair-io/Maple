import Foundation
import MapleCore
import XCTest

@testable import Maple

@MainActor
final class CloudFolderMoveVMTests: XCTestCase {
  private let server = URL(string: "https://example.test")!
  private var gate: MoveReplyGate!
  private var session: URLSession!

  override func setUp() async throws {
    gate = MoveReplyGate()
    MoveReplyProtocol.gate = gate
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MoveReplyProtocol.self]
    session = URLSession(configuration: config)
  }

  override func tearDown() async throws {
    gate.reply(500)
    session.invalidateAndCancel()
  }

  func testSuccessReopensTheBrowsedDescendantAndSendsRelativePaths() async throws {
    let vm = CloudFolderMoveVM()
    let navigation = CloudFolderMoveNavigation(
      selection: .cloudLibrary(serverID: server, folderID: "f1"), path: "/photos/Trips/day 1")
    var refreshed = 0
    var reopened: String?
    var failure: Error?
    XCTAssertTrue(
      vm.move(
        plan: try plan(), server: server, libraryID: "f1", catalog: catalog(),
        navigation: { navigation }, refresh: { refreshed += 1 }, reopen: { reopened = $0 },
        onFailure: { failure = $0 }))
    XCTAssertTrue(vm.isMoving)
    try await settle { self.gate.request != nil }
    XCTAssertEqual(gate.request?.url?.path, "/api/folders/f1/move")
    XCTAssertEqual(gate.request?.httpMethod, "POST")
    XCTAssertEqual(gate.request?.value(forHTTPHeaderField: "Authorization"), "Bearer qa-token")
    XCTAssertEqual(gate.request?.value(forHTTPHeaderField: "X-Maple-Source-Path"), "Trips")
    XCTAssertEqual(gate.request?.value(forHTTPHeaderField: "X-Maple-Target-Path"), "Archive/Trips")
    gate.reply(200)
    try await settle { !vm.isMoving }
    XCTAssertEqual(refreshed, 1)
    XCTAssertEqual(reopened, "/photos/Archive/Trips/day 1")
    XCTAssertNil(failure)
  }

  func testNavigationDuringRequestRefreshesTreeWithoutRedirecting() async throws {
    for destination in [
      CloudFolderMoveNavigation(
        selection: .cloudLibrary(serverID: server, folderID: "f1"), path: "/photos/Other"),
      CloudFolderMoveNavigation(
        selection: .cloudLibrary(serverID: server, folderID: "f2"), path: "/photos/Trips"),
      CloudFolderMoveNavigation(
        selection: .cloudLibrary(serverID: URL(string: "https://other.test")!, folderID: "f1"),
        path: "/photos/Trips"),
      CloudFolderMoveNavigation(selection: .allSources, path: nil),
    ] {
      let vm = CloudFolderMoveVM()
      var current = CloudFolderMoveNavigation(
        selection: .cloudLibrary(serverID: server, folderID: "f1"), path: "/photos/Trips")
      var refreshes = 0
      var reopened: String?
      vm.move(
        plan: try plan(), server: server, libraryID: "f1", catalog: catalog(),
        navigation: { current }, refresh: { refreshes += 1 }, reopen: { reopened = $0 },
        onFailure: { _ in XCTFail("unexpected error") })
      try await settle { self.gate.request != nil }
      current = destination
      gate.reply(200)
      try await settle { !vm.isMoving }
      XCTAssertEqual(refreshes, 1)
      XCTAssertNil(reopened)
    }
  }

  func testMovingAnUnselectedFolderDoesNotRedirectTheGrid() async throws {
    let vm = CloudFolderMoveVM()
    var refreshes = 0
    vm.move(
      plan: try plan(), server: server, libraryID: "f1", catalog: catalog(),
      navigation: {
        CloudFolderMoveNavigation(
          selection: .cloudLibrary(serverID: self.server, folderID: "f1"),
          path: "/photos/Trips-more")
      }, refresh: { refreshes += 1 }, reopen: { _ in XCTFail("sibling must remain open") },
      onFailure: { _ in XCTFail("unexpected error") })
    try await settle { self.gate.request != nil }
    gate.reply(200)
    try await settle { !vm.isMoving }
    XCTAssertEqual(refreshes, 1)
  }

  func testCollisionAndServerFailureReportErrorsWithoutReopeningOrRefreshing() async throws {
    for status in [409, 500] {
      let vm = CloudFolderMoveVM()
      var failure: Error?
      vm.move(
        plan: try plan(), server: server, libraryID: "f1", catalog: catalog(),
        navigation: {
          CloudFolderMoveNavigation(
            selection: .cloudLibrary(serverID: self.server, folderID: "f1"), path: "/photos/Trips")
        }, refresh: { XCTFail("failed move must not refresh") },
        reopen: { _ in XCTFail("failed move must not reopen") }, onFailure: { failure = $0 })
      try await settle { self.gate.request != nil }
      gate.reply(status)
      try await settle { !vm.isMoving }
      XCTAssertNotNil(failure)
      if status == 409 {
        XCTAssertEqual(failure as? FileOperationError, .destinationExists("/photos/Archive/Trips"))
      }
    }
  }

  func testLateFailureCannotOverwriteANewNavigation() async throws {
    let vm = CloudFolderMoveVM()
    var current = CloudFolderMoveNavigation(
      selection: .cloudLibrary(serverID: server, folderID: "f1"), path: "/photos/Trips")
    vm.move(
      plan: try plan(), server: server, libraryID: "f1", catalog: catalog(),
      navigation: { current }, refresh: {}, reopen: { _ in XCTFail("failed move") },
      onFailure: { _ in XCTFail("obsolete error must not overwrite the new view") })
    try await settle { self.gate.request != nil }
    current = CloudFolderMoveNavigation(selection: .allSources, path: nil)
    gate.reply(500)
    try await settle { !vm.isMoving }
  }

  func testSameParentAndSecondTriggerDoNotSendExtraMutations() async throws {
    let vm = CloudFolderMoveVM()
    let navigation = CloudFolderMoveNavigation(
      selection: .cloudLibrary(serverID: server, folderID: "f1"), path: "/photos/Trips")
    let same = try CloudFolderMovePlan(
      root: "/photos", source: "/photos/Trips", destination: "/photos")
    XCTAssertFalse(
      vm.move(
        plan: same, server: server, libraryID: "f1", catalog: catalog(), navigation: { navigation },
        refresh: {}, reopen: { _ in }, onFailure: { _ in }))
    XCTAssertFalse(vm.isMoving)
    XCTAssertNil(gate.request)
    XCTAssertTrue(
      vm.move(
        plan: try plan(), server: server, libraryID: "f1", catalog: catalog(),
        navigation: { navigation }, refresh: {}, reopen: { _ in }, onFailure: { _ in }))
    XCTAssertFalse(
      vm.move(
        plan: try plan(), server: server, libraryID: "f1", catalog: catalog(),
        navigation: { navigation }, refresh: {}, reopen: { _ in }, onFailure: { _ in }))
    try await settle { self.gate.request != nil }
    XCTAssertEqual(gate.count, 1)
    gate.reply(200)
    try await settle { !vm.isMoving }
  }

  private func plan() throws -> CloudFolderMovePlan {
    try CloudFolderMovePlan(
      root: "/photos", source: "/photos/Trips", destination: "/photos/Archive")
  }

  private func catalog() -> RemoteCatalog {
    RemoteCatalog(
      http: AuthenticatedHTTPClient(
        server: server, urlSession: session,
        tokensProvider: { AuthTokens(access: "qa-token", refresh: "qa-refresh") },
        onTokensRefreshed: { _ in }, onSignOut: {}), server: server)
  }

  private func settle(_ condition: () -> Bool) async throws {
    for _ in 0..<500 {
      if condition() { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("timed out waiting for controlled HTTP completion")
    throw URLError(.timedOut)
  }
}

private final class MoveReplyGate: @unchecked Sendable {
  private let lock = NSLock()
  private var waiting: MoveReplyProtocol?
  private var calls = 0
  var request: URLRequest? {
    lock.lock()
    defer { lock.unlock() }
    return waiting?.request
  }
  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return calls
  }
  func record(_ transport: MoveReplyProtocol) {
    lock.lock()
    defer { lock.unlock() }
    waiting = transport
    calls += 1
  }
  func reply(_ status: Int) {
    lock.lock()
    let transport = waiting
    waiting = nil
    lock.unlock()
    guard let transport else { return }
    transport.client?.urlProtocol(
      transport,
      didReceive: HTTPURLResponse(
        url: transport.request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    transport.client?.urlProtocol(
      transport, didLoad: Data(#"{"abs_path":"/photos/Archive/Trips"}"#.utf8))
    transport.client?.urlProtocolDidFinishLoading(transport)
  }
}

private final class MoveReplyProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var gate: MoveReplyGate!
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() { Self.gate.record(self) }
  override func stopLoading() {}
}
