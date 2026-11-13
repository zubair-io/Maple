import Foundation
import XCTest

@testable import MapleCore

/// The Cloud store merges onto a sidecar another device changed instead of last-write-wins (#4983).
final class CloudSidecarReconcileTests: XCTestCase {
  private let server = URL(string: "https://reconcile.example")!
  private let assetID = "fs:/photos/a.dng"

  private func document(_ change: (inout AdjustmentModel) -> Void) -> String {
    var model = AdjustmentModel.default
    change(&model)
    return XMPSerializer.serialize(model: model, culling: CullingState())
  }

  private func store(_ remote: RemoteSidecar) -> CloudSidecarStore {
    let session = URLSession.stubbedSequence { remote.respond(to: $0) }
    return CloudSidecarStore(
      server: server, assetID: assetID,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func testSaveAfterAnotherDeviceChangedTheSidecarMergesAndIsConditional() async throws {
    let remote = RemoteSidecar(document { _ in })
    let store = store(remote)
    _ = try await store.loadIfPresent()
    remote.replace(document { $0.contrast = 30 })
    let etag = remote.etag

    var model = AdjustmentModel.default
    model.exposure = 1.5
    try await store.writeConfirmed(model: model, culling: CullingState())

    let saved = remote.text
    XCTAssertEqual(try XMPParser.parse(saved).0.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(
      try XMPParser.parse(saved).0.contrast, 30, accuracy: 1e-9, "the other device's edit")
    XCTAssertEqual(
      try WorkflowSidecarCore.read(xmp: saved)?.history.map(\.action), ["external"])
    XCTAssertEqual(remote.matches, [etag])
  }

  func testLosingTheConditionalRaceRetriesAgainstTheNewerDocument() async throws {
    let remote = RemoteSidecar(document { _ in })
    let store = store(remote)
    _ = try await store.loadIfPresent()
    remote.replace(document { $0.contrast = 30 })
    remote.beforeNextSave = {
      $0.replace(
        self.document {
          $0.contrast = 30
          $0.saturation = 20
        })
    }

    var model = AdjustmentModel.default
    model.exposure = 1.5
    try await store.writeConfirmed(model: model, culling: CullingState())

    let saved = try XMPParser.parse(remote.text).0
    XCTAssertEqual(saved.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(saved.contrast, 30, accuracy: 1e-9)
    XCTAssertEqual(saved.saturation, 20, accuracy: 1e-9, "the edit that won the race")
    XCTAssertEqual(remote.matches.count, 2)
  }

  func testMergeIsAnnouncedUntilTheEditorConfirmsIt() async throws {
    let remote = RemoteSidecar(document { _ in })
    let store = store(remote)
    _ = try await store.loadIfPresent()
    let stream = await store.reconciliations()
    var merges = stream.makeAsyncIterator()
    remote.replace(document { $0.contrast = 30 })

    var model = AdjustmentModel.default
    model.exposure = 1.5
    try await store.writeConfirmed(model: model, culling: CullingState())

    let next = await merges.next()
    let announced = try XCTUnwrap(next)
    XCTAssertEqual(announced.xml, remote.text)
    XCTAssertEqual(announced.model, model)
    await store.confirmAdoption(of: announced.xml)
    withExtendedLifetime(stream) {}
  }

  func testSemanticCommitSendsItsBaseAndAcknowledgesByIdWhateverTheServerRewrites() async throws {
    let base = document { _ in }
    let remote = RemoteSidecar(base)
    let store = store(remote)
    _ = try await store.loadIfPresent()
    remote.replace(document { $0.contrast = 30 })

    var model = AdjustmentModel.default
    model.exposure = 1.5
    try await store.commitSemantic(
      model: model, culling: CullingState(), action: "adjustment", label: "Exposure")

    let commit = try XCTUnwrap(remote.commits.first)
    XCTAssertEqual(remote.commits.count, 1)
    XCTAssertEqual(
      commit.expectedXmp, base, "the document this writer last saw, not the current one")
    XCTAssertEqual(commit.entry.writer, "apple")
    XCTAssertEqual(commit.entry.parentId, "")
    let saved = try XCTUnwrap(WorkflowSidecarCore.read(xmp: remote.text)?.history.first)
    XCTAssertEqual(saved.id, commit.entry.id)
    XCTAssertNotEqual(saved.parentId, commit.entry.parentId, "the server rewrote the stored entry")
    try await store.writeConfirmed(model: model, culling: CullingState())
    XCTAssertEqual(remote.commits.count, 1, "an acknowledged action is never resent")
  }
}

/// A path-keyed server sidecar with the exact-content preconditions of `/api/xmp` (#4317).
private final class RemoteSidecar: @unchecked Sendable {
  struct Commit {
    let expectedXmp: String?
    let entry: WorkflowHistoryEntry
  }

  private let lock = NSLock()
  private var xml: String
  private var version = 1
  private var savedMatches: [String] = []
  private var savedCommits: [Commit] = []
  var beforeNextSave: ((RemoteSidecar) -> Void)?

  init(_ xml: String) { self.xml = xml }

  var text: String { lock.withLock { xml } }
  var etag: String { lock.withLock { currentETag } }
  var matches: [String] { lock.withLock { savedMatches } }
  var commits: [Commit] { lock.withLock { savedCommits } }
  private var currentETag: String { String(format: "\"%040x\"", version) }

  func replace(_ next: String) {
    lock.withLock {
      xml = next
      version += 1
    }
  }

  func respond(to request: URLRequest) -> (Data, HTTPURLResponse) {
    let url = request.url!
    func reply(_ status: Int, _ body: String, etag: String? = nil) -> (Data, HTTPURLResponse) {
      var headers = [
        "Content-Type": "application/xml", "X-Maple-Xmp-Preconditions": "content-etag-v1",
      ]
      headers["ETag"] = etag
      return (
        Data(body.utf8),
        HTTPURLResponse(
          url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
      )
    }
    switch (request.httpMethod ?? "GET", url.path) {
    case ("GET", "/api/xmp"):
      return lock.withLock { reply(200, xml, etag: currentETag) }
    case ("GET", "/api/xmp/variant"):
      return reply(200, text)
    case ("POST", "/api/xmp"):
      let hook = lock.withLock { () -> ((RemoteSidecar) -> Void)? in
        defer { beforeNextSave = nil }
        return beforeNextSave
      }
      hook?(self)
      let body = String(
        decoding: URLProtocolStub.capturedBodies[url.absoluteString] ?? Data(), as: UTF8.self)
      return lock.withLock {
        let match = request.value(forHTTPHeaderField: "If-Match") ?? ""
        savedMatches.append(match)
        guard match == currentETag else { return reply(412, "") }
        xml =
          try! WorkflowSidecarCore.read(xmp: xml).map {
            try! WorkflowSidecarCore.embed($0, in: WorkflowSidecarCore.checkpoint(xmp: body))
          } ?? body
        version += 1
        return reply(200, xml, etag: currentETag)
      }
    case ("POST", "/api/xmp/variant/commit"):
      return commit(request)
    default:
      return reply(404, "")
    }
  }

  private func commit(_ request: URLRequest) -> (Data, HTTPURLResponse) {
    let url = request.url!
    let json =
      try! JSONSerialization.jsonObject(
        with: URLProtocolStub.capturedBodies[url.absoluteString] ?? Data()) as! [String: Any]
    let entry = try! JSONDecoder().decode(
      WorkflowHistoryEntry.self,
      from: JSONSerialization.data(withJSONObject: json["entry"] as Any))
    let rewritten = WorkflowHistoryEntry(
      id: entry.id, createdAtMs: entry.createdAtMs, action: entry.action, label: entry.label,
      parentId: UUID().uuidString.lowercased(), writer: entry.writer,
      adjustmentXmp: entry.adjustmentXmp)
    return lock.withLock {
      savedCommits.append(Commit(expectedXmp: json["expectedXmp"] as? String, entry: entry))
      let candidate =
        try! WorkflowSidecarCore.read(xmp: xml).map {
          try! WorkflowSidecarCore.embed($0, in: rewritten.adjustmentXmp)
        } ?? rewritten.adjustmentXmp
      xml = try! WorkflowSidecarCore.commit(rewritten, in: candidate)
      version += 1
      return (
        Data(xml.utf8),
        HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
      )
    }
  }
}
