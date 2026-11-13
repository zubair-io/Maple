// ServerPanoStitcherTests.swift — the merge sheet's server stitch (#5488).

import Foundation
import MapleCloudKit
import Testing
import XCTest
import os
@testable import MapleCore

/// Scripted pano API: each `job(_:)` call answers with the next scripted reply.
private final class FakePanoJobs: PanoServerJobs {
    enum Reply {
        case job(PanoServerJob)
        case offline
    }

    private struct Calls {
        var replies: [Reply]
        var stitchRequests: [PanoServerRequest] = []
        var cancelled: [String] = []
        var previewRequests = 0
        var polls = 0
    }

    private let calls: OSAllocatedUnfairLock<Calls>
    /// Runs while a job is being created, before its id comes back.
    private let whileCreating: @Sendable () -> Void
    private let previewSupported: Bool

    init(
        _ replies: [Reply], previewSupported: Bool = true,
        whileCreating: @escaping @Sendable () -> Void = {}
    ) {
        calls = OSAllocatedUnfairLock(initialState: Calls(replies: replies))
        self.previewSupported = previewSupported
        self.whileCreating = whileCreating
    }

    var stitchRequests: [PanoServerRequest] { calls.withLock { $0.stitchRequests } }
    var cancelled: [String] { calls.withLock { $0.cancelled } }
    var previewRequests: Int { calls.withLock { $0.previewRequests } }
    var polls: Int { calls.withLock { $0.polls } }
    func script(_ replies: [Reply]) { calls.withLock { $0.replies = replies } }

    func stitch(_ body: PanoServerRequest) async throws -> String {
        calls.withLock { $0.stitchRequests.append(body) }
        whileCreating()
        if Task.isCancelled { throw URLError(.cancelled) }
        return "job-\(stitchRequests.count)"
    }

    func preview(_ body: PanoServerRequest) async throws -> String {
        calls.withLock { $0.previewRequests += 1 }
        whileCreating()
        return "preview-1"
    }

    func config() async throws -> PanoServerConfig {
        PanoServerConfig(enabled: false, mapleCliPath: nil, previewSupported: previewSupported)
    }

    func job(_ id: String) async throws -> PanoServerJob {
        let reply = calls.withLock { calls in
            calls.polls += 1
            return calls.replies.isEmpty ? Reply.offline : calls.replies.removeFirst()
        }
        switch reply {
        case .job(let job): return job
        case .offline: throw URLError(.notConnectedToInternet)
        }
    }

    func cancel(_ id: String) async throws { calls.withLock { $0.cancelled.append(id) } }

    func previewImage(_ id: String) async throws -> Data { Data() }
}

private func job(
    _ status: PanoServerJob.Status, progress: Int = 0, result: PanoServerJob.Result? = nil
) -> FakePanoJobs.Reply {
    .job(PanoServerJob(
        id: "job-1", status: status, progress: .init(current: progress, total: 600),
        result: result, error: status == .failed ? "maple-cli exited" : nil))
}

private let server = URL(string: "https://maple.example")!

private func cloudFrame(_ name: String, server: URL = server) -> AssetRef {
    AssetRef(
        displayName: name, hintExtension: "dng",
        catalog: CatalogRef(serverID: server, folderID: "lib-1", absPath: "/photos/\(name)", address: nil),
        bytesProvider: { Data() })
}

private let frames = [cloudFrame("a.dng"), cloudFrame("b.dng")]

private func stitcher(_ jobs: FakePanoJobs) -> ServerPanoStitcher {
    ServerPanoStitcher(jobs: jobs, pollInterval: .milliseconds(1), pollAttempts: 3)
}

private func stitch(_ stitcher: ServerPanoStitcher, _ options: PanoOptions = .default) async throws -> PanoResult {
    try await stitcher.stitch(
        assets: frames, options: options, alignment: nil, maxCanvasPixels: nil, progress: { _, _ in })
}

/// Waits for the stitcher's fire-and-forget DELETEs to land.
private func cancelled(_ jobs: FakePanoJobs, count: Int) async throws -> [String] {
    for _ in 0..<100 where jobs.cancelled.count < count { try await Task.sleep(for: .milliseconds(5)) }
    return jobs.cancelled
}

/// The stitcher under test, reachable from the fake's create hook.
private final class Box: @unchecked Sendable { var stitcher: ServerPanoStitcher? }

/// The stitcher and the task running it, reachable from the create hook.
private final class RunBox: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: ())
    private var storedStitcher: ServerPanoStitcher?
    private var storedRun: Task<PanoResult, any Error>?
    var stitcher: ServerPanoStitcher? {
        get { lock.withLock { storedStitcher } }
        set { lock.withLock { storedStitcher = newValue } }
    }
    var run: Task<PanoResult, any Error>? {
        get {
            while true {
                if let run = lock.withLock({ storedRun }) { return run }
                Thread.sleep(forTimeInterval: 0.001)
            }
        }
        set { lock.withLock { storedRun = newValue } }
    }
}

@Suite("ServerPanoStitcher (#5488)")
struct ServerPanoStitcherTests {
    @Test("sends the frames' server paths and library, and starts from a server preview")
    func requestShape() throws {
        let request = try ServerPanoStitcher.request(
            frames, PanoOptions(retention: .strict, localAlign: .off, strategy: .tile),
            PanoAlignment(json: Data(), serverPreviewJobID: "preview-9"))
        #expect(request == PanoServerRequest(
            assetPaths: ["/photos/a.dng", "/photos/b.dng"], libraryId: "lib-1",
            options: PanoServerOptions(retention: "strict", localAlign: "off", strategy: "tile"),
            alignmentFrom: "preview-9"))
    }

    @Test("refuses frames that are not all on one server")
    func framesOnOneServer() {
        let elsewhere = [cloudFrame("a.dng"), cloudFrame("b.dng", server: URL(string: "https://other.example")!)]
        #expect(ServerPanoStitcher.server(for: elsewhere) == nil)
        #expect(throws: ServerPanoStitchError.framesNotOnOneServer) {
            try ServerPanoStitcher.request(elsewhere, .default, nil)
        }
    }

    @Test("maps the server's progress units onto the stitch stages")
    func stages() {
        #expect(ServerPanoStitcher.stage(.init(current: 0, total: 600)) == (.decoding, 0))
        #expect(ServerPanoStitcher.stage(.init(current: 150, total: 600)) == (.matching, 0.5))
        #expect(ServerPanoStitcher.stage(.init(current: 600, total: 600)) == (.compositing, 1))
    }

    @Test("returns the server asset the finished job imported")
    func finishedJob() async throws {
        let jobs = FakePanoJobs([
            job(.queued), job(.running, progress: 320),
            job(.done, progress: 600, result: .init(
                outputAssetId: "asset-7", outputPath: "/photos/Panoramas/a-pano-1.png",
                alignment: .init(status: "reused"), matcher: "classical",
                matcherNote: "Used the classical matcher because the ML matcher’s models aren’t installed on the server.")),
        ])
        let result = try await stitch(stitcher(jobs))
        #expect(result.serverAssetID == "asset-7")
        #expect(result.outputURL.path == "/photos/Panoramas/a-pano-1.png")
        #expect(result.alignmentOutcome == .reused)
        #expect(result.matcher.note?.contains("on the server") == true)
    }

    @Test("reports a failed job's message")
    func failedJob() async {
        let jobs = FakePanoJobs([job(.failed)])
        await #expect(throws: ServerPanoStitchError.jobFailed("maple-cli exited")) {
            try await stitch(stitcher(jobs))
        }
    }

    @Test("gives up on a server it cannot reach, then follows the same job on retry")
    func lostContactResumes() async throws {
        let jobs = FakePanoJobs([job(.running, progress: 100), .offline, .offline, .offline])
        let stitcher = stitcher(jobs)
        await #expect(throws: ServerPanoStitchError.lostContact) { try await stitch(stitcher) }
        // Try Again goes through the session's start, which cancels first.
        stitcher.cancel()
        #expect(jobs.cancelled.isEmpty)

        jobs.script([job(.running, progress: 400), job(.done, result: .init(outputAssetId: "asset-7", outputPath: "/p.png"))])
        let result = try await stitch(stitcher)
        #expect(result.serverAssetID == "asset-7")
        #expect(jobs.stitchRequests.count == 1)
    }

    @Test("explains a server that hasn't turned stitching on")
    func unprovisionedServer() async {
        let reason = await stitcher(FakePanoJobs([])).unavailableReason()
        #expect(reason?.contains("isn’t set up on this server") == true)
    }

    @Test("cancel stops watching and cancels the job on the server")
    func cancelStopsTheJob() async throws {
        let jobs = FakePanoJobs(Array(repeating: job(.running, progress: 100), count: 10_000))
        let stitcher = ServerPanoStitcher(jobs: jobs, pollInterval: .milliseconds(5), pollAttempts: 3)
        let run = Task { try await stitch(stitcher) }
        try await Task.sleep(for: .milliseconds(30))
        stitcher.cancel()
        await #expect(throws: CancellationError.self) { try await run.value }
        #expect(try await cancelled(jobs, count: 1) == ["job-1"])
    }

    @Test("a cancel while the job is being created still stops it on the server")
    func cancelWhileCreating() async throws {
        let box = Box()
        let jobs = FakePanoJobs([job(.running)], whileCreating: { box.stitcher?.cancel() })
        box.stitcher = stitcher(jobs)
        await #expect(throws: CancellationError.self) { try await stitch(box.stitcher!) }
        #expect(try await cancelled(jobs, count: 1) == ["job-1"])
    }

    @Test("a cancel while a preview is being created stops the preview on the server")
    func cancelPreviewWhileCreating() async throws {
        let box = Box()
        let jobs = FakePanoJobs([], whileCreating: { box.stitcher?.cancel() })
        box.stitcher = stitcher(jobs)
        await #expect(throws: CancellationError.self) {
            try await box.stitcher!.preview(assets: frames, options: .default, alignment: nil, progress: { _, _ in })
        }
        #expect(try await cancelled(jobs, count: 1) == ["preview-1"])
    }

    @Test("a job stopped on the server is reported, not taken for the user's cancel")
    func stoppedOnServer() async {
        let jobs = FakePanoJobs([job(.running), job(.cancelled)])
        await #expect(throws: ServerPanoStitchError.stoppedOnServer) { try await stitch(stitcher(jobs)) }
    }

    @Test("new settings after a lost connection replace the stale job")
    func changedSettingsReplaceStaleJob() async throws {
        let jobs = FakePanoJobs([.offline, .offline, .offline])
        let stitcher = stitcher(jobs)
        await #expect(throws: ServerPanoStitchError.lostContact) { try await stitch(stitcher) }
        stitcher.cancel()

        jobs.script([job(.running), job(.done, result: .init(outputAssetId: "asset-8", outputPath: "/p.png"))])
        let result = try await stitch(stitcher, PanoOptions(retention: .strict, localAlign: .off, strategy: .tile))
        #expect(result.serverAssetID == "asset-8")
        #expect(jobs.stitchRequests.count == 2)
        #expect(jobs.cancelled == ["job-1"])
    }

    @Test("closing the sheet stops a job a lost connection left running")
    func abandonStopsOrphan() async throws {
        let jobs = FakePanoJobs([.offline, .offline, .offline])
        let stitcher = stitcher(jobs)
        await #expect(throws: ServerPanoStitchError.lostContact) { try await stitch(stitcher) }
        stitcher.abandon()
        #expect(try await cancelled(jobs, count: 1) == ["job-1"])
    }

    @Test("Try Again rejoins the job even when the server can't answer the first check")
    func rejoinSurvivesTransientLookup() async throws {
        let jobs = FakePanoJobs([.offline, .offline, .offline])
        let stitcher = stitcher(jobs)
        await #expect(throws: ServerPanoStitchError.lostContact) { try await stitch(stitcher) }
        stitcher.cancel()

        jobs.script([.offline, job(.running), job(.done, result: .init(outputAssetId: "asset-7", outputPath: "/p.png"))])
        let result = try await stitch(stitcher)
        #expect(result.serverAssetID == "asset-7")
        #expect(jobs.stitchRequests.count == 1)
        #expect(jobs.cancelled.isEmpty)
    }

    @Test("a server without quick previews says so instead of asking for one")
    func previewUnsupported() async {
        let jobs = FakePanoJobs([], previewSupported: false)
        await #expect(throws: ServerPanoStitchError.previewUnsupported) {
            try await stitcher(jobs).preview(assets: frames, options: .default, alignment: nil, progress: { _, _ in })
        }
        #expect(jobs.previewRequests == 0)
    }

    @Test("on a memory-limited device, a server stitch starts without a preview's memory fit")
    @MainActor
    func serverStitchSkipsDeviceMemoryFit() async throws {
        let jobs = FakePanoJobs(
            [job(.done, result: .init(outputAssetId: "asset-7", outputPath: "/p.png"))], previewSupported: false)
        let session = PanoMergeSession(
            stitcher: stitcher(jobs), previewDebounce: .seconds(60), availableMemory: { 4 << 30 })
        session.start(assets: frames)
        let deadline = ContinuousClock.now + .seconds(5)
        func finished() -> Bool {
            switch session.state {
            case .done, .error: return true
            default: return false
            }
        }
        while !finished(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        guard case .done(let result) = session.state else {
            Issue.record("expected the stitch to finish, got \(session.state)")
            return
        }
        #expect(result.serverAssetID == "asset-7")
        #expect(jobs.previewRequests == 0)
    }
}

/// The merge session drops a superseded preview by cancelling its task, not
/// through `cancel()`; the server must still be told to stop it.
final class ServerPanoPreviewSupersedeTests: XCTestCase {
    private func runningPreview() async throws -> (FakePanoJobs, ServerPanoStitcher, Task<PanoPreview, any Error>) {
        let jobs = FakePanoJobs(Array(repeating: job(.running, progress: 100), count: 10_000))
        let stitcher = ServerPanoStitcher(jobs: jobs, pollInterval: .milliseconds(5), pollAttempts: 3)
        let run = Task {
            try await stitcher.preview(assets: frames, options: .default, alignment: nil, progress: { _, _ in })
        }
        while jobs.polls == 0 { try await Task.sleep(for: .milliseconds(2)) }
        return (jobs, stitcher, run)
    }

    /// The server accepted the create, but the app's task was cancelled
    /// (Stop) before the reply came back: the job must still be stopped.
    func testStopWhileTheStitchIsBeingCreatedStillStopsItOnTheServer() async throws {
        let box = RunBox()
        let jobs = FakePanoJobs([job(.running)], whileCreating: {
            box.stitcher?.cancel()
            box.run?.cancel()
        })
        let stitcher = ServerPanoStitcher(jobs: jobs, pollInterval: .milliseconds(5), pollAttempts: 3)
        box.stitcher = stitcher
        let run = Task {
            try await stitcher.stitch(
                assets: frames, options: .default, alignment: nil, maxCanvasPixels: nil, progress: { _, _ in })
        }
        box.run = run

        do {
            _ = try await run.value
            XCTFail("a stopped stitch returned")
        } catch {
            XCTAssertTrue(error is CancellationError, "expected CancellationError, got \(error)")
        }
        let stopped = try await cancelled(jobs, count: 1)
        XCTAssertEqual(stopped, ["job-1"])
    }

    func testCancellingThePreviewTaskStopsThePreviewOnTheServer() async throws {
        let (jobs, _, run) = try await runningPreview()

        run.cancel()

        do {
            _ = try await run.value
            XCTFail("a cancelled preview returned")
        } catch {
            XCTAssertTrue(error is CancellationError, "expected CancellationError, got \(error)")
        }
        let stopped = try await cancelled(jobs, count: 1)
        XCTAssertEqual(stopped, ["preview-1"])
    }

    func testAPreviewStoppedThroughCancelIsStoppedOnlyOnce() async throws {
        let (jobs, stitcher, run) = try await runningPreview()

        stitcher.cancel()
        run.cancel()
        _ = try? await run.value
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(jobs.cancelled, ["preview-1"])
    }
}
