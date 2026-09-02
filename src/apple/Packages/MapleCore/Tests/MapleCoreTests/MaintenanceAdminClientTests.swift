// MaintenanceAdminClientTests.swift
//
// Wire-shape coverage for the four maintenance-panel admin clients added in
// T5b (#2772): face purge, mirror, derivative-audit, and render config. Each
// gets a focused pass — decode shape plus the one behaviour with real risk
// per client — rather than exhaustive coverage, since the request/response
// plumbing itself mirrors the already-tested EnrichmentConfigClient pattern.

import XCTest

@testable import MapleCore

private func jsonResponse(_ req: URLRequest, _ json: String, status: Int = 200) -> (
  Data, HTTPURLResponse
) {
  let resp = HTTPURLResponse(
    url: req.url!, statusCode: status, httpVersion: "HTTP/1.1",
    headerFields: ["Content-Type": "application/json"])!
  return (Data(json.utf8), resp)
}

// MARK: - FacePurgeClient

final class FacePurgeClientTests: XCTestCase {
  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> FacePurgeClient {
    FacePurgeClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  private let sampleAuditJSON = """
    {"threshold":0.06,"mode":"dry-run","assetsScanned":100,"assetsAffected":4,
     "subThresholdFaces":{"unassigned":6,"assigned":2,"hidden":1,"total":9},
     "policy":{"removesUnassigned":false,"removesAssigned":false,"preservesHidden":true},
     "affectedPeople":[{"personId":"p1","subThresholdFaces":2}]}
    """

  func test_audit_sendsNoQueryParams() async throws {
    nonisolated(unsafe) var captured: URL?
    let session = URLSession.stubbedSequence { req in
      captured = req.url
      return jsonResponse(req, self.sampleAuditJSON)
    }
    let result = try await client(session).audit()
    XCTAssertEqual(captured?.path, "/api/admin/faces/purge-subthreshold")
    XCTAssertEqual(captured?.query, nil)
    XCTAssertEqual(result.mode, "dry-run")
    XCTAssertNil(result.applied)
    XCTAssertEqual(result.subThresholdFaces.unassigned, 6)
    XCTAssertEqual(result.removableCount(includeAssigned: false), 6)
    XCTAssertEqual(result.removableCount(includeAssigned: true), 8)
  }

  func test_apply_includeAssignedTrue_setsBothQueryParams() async throws {
    nonisolated(unsafe) var captured: URL?
    let session = URLSession.stubbedSequence { req in
      captured = req.url
      let json = """
        {"threshold":0.06,"mode":"apply:all","assetsScanned":100,"assetsAffected":4,
         "subThresholdFaces":{"unassigned":6,"assigned":2,"hidden":1,"total":9},
         "policy":{"removesUnassigned":true,"removesAssigned":true,"preservesHidden":true},
         "affectedPeople":[],
         "applied":{"facesRemoved":8,"assetsUpdated":3,"personCountsRecomputed":1}}
        """
      return jsonResponse(req, json)
    }
    let result = try await client(session).apply(includeAssigned: true)
    let query = try XCTUnwrap(captured?.query)
    XCTAssertTrue(query.contains("apply=true"))
    XCTAssertTrue(query.contains("includeAssigned=true"))
    XCTAssertEqual(result.applied?.facesRemoved, 8)
  }

  func test_apply_includeAssignedFalse_omitsIncludeAssignedParam() async throws {
    nonisolated(unsafe) var captured: URL?
    let session = URLSession.stubbedSequence { req in
      captured = req.url
      let json = """
        {"threshold":0.06,"mode":"apply:unassigned-only","assetsScanned":10,"assetsAffected":1,
         "subThresholdFaces":{"unassigned":2,"assigned":0,"hidden":0,"total":2},
         "policy":{"removesUnassigned":true,"removesAssigned":false,"preservesHidden":true},
         "affectedPeople":[],
         "applied":{"facesRemoved":2,"assetsUpdated":1,"personCountsRecomputed":0}}
        """
      return jsonResponse(req, json)
    }
    _ = try await client(session).apply(includeAssigned: false)
    let query = try XCTUnwrap(captured?.query)
    XCTAssertTrue(query.contains("apply=true"))
    XCTAssertFalse(query.contains("includeAssigned"))
  }

  func test_audit_zeroThresholdErrorSurfaces() async {
    let session = URLSession.stubbed(
      response: #"{"error":"face_min_detection_size is 0 — no size gate is active."}"#,
      contentType: "application/json", status: 400)
    do {
      _ = try await client(session).audit()
      XCTFail("expected throw")
    } catch let error as ServerAdminError {
      XCTAssertEqual(error.statusCode, 400)
    } catch {
      XCTFail("expected ServerAdminError, got \(error)")
    }
  }
}

// MARK: - MirrorConfigClient

final class MirrorConfigClientTests: XCTestCase {
  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> MirrorConfigClient {
    MirrorConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_mirrors_decodesList() async throws {
    let session = URLSession.stubbedSequence { req in
      jsonResponse(req, #"{"mirrors":[{"path":"/backup/lib1","enabled":true}]}"#)
    }
    let mirrors = try await client(session).mirrors(forLibrary: "lib1")
    XCTAssertEqual(mirrors, [MirrorLocation(path: "/backup/lib1", enabled: true)])
  }

  func test_setMirrors_putsToCorrectLibraryPath() async throws {
    nonisolated(unsafe) var captured: URL?
    let session = URLSession.stubbedSequence { req in
      captured = req.url
      return jsonResponse(req, #"{"ok":true,"mirrors":[{"path":"/backup/lib1","enabled":true}]}"#)
    }
    _ = try await client(session).setMirrors(
      [MirrorLocation(path: "/backup/lib1", enabled: true)], forLibrary: "lib1")
    XCTAssertEqual(captured?.path, "/api/folders/lib1/mirror")
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/folders/lib1/mirror"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertNotNil(obj["mirrors"])
  }

  func test_testPath_failureReportsError() async throws {
    let session = URLSession.stubbedSequence { req in
      jsonResponse(req, #"{"ok":false,"error":"not a directory"}"#)
    }
    let result = try await client(session).testPath("/nope")
    XCTAssertFalse(result.ok)
    XCTAssertEqual(result.error, "not a directory")
  }

  func test_status_decodesIdlePhaseWithNoReconcileYet() async throws {
    let session = URLSession.stubbedSequence { req in
      jsonResponse(req, #"{"queue":{"pending":0,"dead":0}}"#)
    }
    let status = try await client(session).status()
    XCTAssertEqual(status.queue.pending, 0)
    XCTAssertNil(status.reconcile)
  }

  func test_status_decodesActiveReconcile() async throws {
    let json = """
      {"queue":{"pending":3,"dead":1},
       "reconcile":{"phase":"copying",
         "scan":{"scanned":10,"toCopy":5,"upToDate":5,"errors":0},
         "copy":{"total":5,"copied":2,"remaining":3,"errors":0},
         "currentPath":"/lib1/a.dng","startedAt":"2026-01-01T00:00:00.000Z","finishedAt":null,
         "errorLog":[],"copiedLog":["/lib1/a.dng"]}}
      """
    let session = URLSession.stubbedSequence { req in jsonResponse(req, json) }
    let status = try await client(session).status()
    XCTAssertEqual(status.reconcile?.phase, .copying)
    XCTAssertEqual(status.reconcile?.copy.copied, 2)
    XCTAssertEqual(status.reconcile?.copiedLog, ["/lib1/a.dng"])
  }

  func test_reconcile_decodesNotStartedReason() async throws {
    let session = URLSession.stubbedSequence { req in
      jsonResponse(req, #"{"started":false,"phase":"idle","reason":"no mirror configured"}"#)
    }
    let result = try await client(session).reconcile()
    XCTAssertFalse(result.started)
    XCTAssertEqual(result.reason, "no mirror configured")
  }
}

// MARK: - DerivativeAuditConfigClient

final class DerivativeAuditConfigClientTests: XCTestCase {
  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> DerivativeAuditConfigClient {
    DerivativeAuditConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_status_decodesConfigAndProgress() async throws {
    let json = """
      {"config":{"enabled":true,"interval_ms":21600000,"max_resets_per_pass":500,
        "concurrency":8,"deep_r2_enabled":true},
       "progress":{"scanned":0,"reArmed":0,"byStage":{},"skippedCooldown":0,"errors":0,
        "startedAt":null,"finishedAt":null,"running":false}}
      """
    let session = URLSession.stubbedSequence { req in jsonResponse(req, json) }
    let status = try await client(session).status()
    XCTAssertTrue(status.config.enabled)
    XCTAssertEqual(status.config.intervalMs, 21_600_000)
    XCTAssertFalse(status.progress.running)
  }

  func test_save_enabledOnlyPatch_omitsOtherFields() async throws {
    let session = URLSession.stubbedSequence { req in
      jsonResponse(
        req,
        #"{"ok":true,"config":{"enabled":false,"interval_ms":21600000,"max_resets_per_pass":500,"concurrency":8,"deep_r2_enabled":true}}"#
      )
    }
    let config = try await client(session).save(DerivativeAuditConfigPatch(enabled: false))
    XCTAssertFalse(config.enabled)
    let body = try XCTUnwrap(URLProtocolStub.capturedBodies["https://x/api/derivative-audit/config"])
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(Set(obj.keys), ["enabled"], "a toggle-only save must not resend the runtime knobs")
  }

  func test_run_alreadyRunningReportsReason() async throws {
    let session = URLSession.stubbedSequence { req in
      jsonResponse(req, #"{"started":false,"reason":"already-running"}"#)
    }
    let result = try await client(session).run()
    XCTAssertFalse(result.started)
    XCTAssertEqual(result.reason, "already-running")
  }
}

// MARK: - RenderConfigClient

final class RenderConfigClientTests: XCTestCase {
  private let server = URL(string: "https://x")!

  private func client(_ session: URLSession) -> RenderConfigClient {
    RenderConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }

  func test_fetch_decodesSourceProvenance() async throws {
    let session = URLSession.stubbedSequence { req in
      jsonResponse(req, #"{"gpu_live_render_enabled":true,"source":{"gpu_live_render_enabled":"default"}}"#)
    }
    let cfg = try await client(session).fetch()
    XCTAssertTrue(cfg.gpuLiveRenderEnabled)
    XCTAssertEqual(cfg.source.gpuLiveRenderEnabled, .default)
  }

  func test_save_sendsFlag() async throws {
    nonisolated(unsafe) var captured: URL?
    let session = URLSession.stubbedSequence { req in
      captured = req.url
      return jsonResponse(req, #"{"gpu_live_render_enabled":false,"source":{"gpu_live_render_enabled":"db"}}"#)
    }
    let cfg = try await client(session).save(RenderConfigPatch(gpuLiveRenderEnabled: false))
    XCTAssertEqual(captured?.path, "/api/render/config")
    XCTAssertFalse(cfg.gpuLiveRenderEnabled)
    XCTAssertEqual(cfg.source.gpuLiveRenderEnabled, .db)
  }
}
