// ServerPanoStitcher.swift — stitches on the self-hosted server (#5488).
//
// Frames that live only on a Maple server have no file on this device, so
// the merge sheet hands them to the server's pano jobs instead of the FFI.
// The job keeps running on the server whatever the app does: polling only
// watches it, so backgrounding the app or losing the network costs nothing
// but the progress bar, and Try Again picks the same job back up.

import CoreGraphics
import Foundation
import ImageIO
import MapleCloudKit
import os

public enum ServerPanoStitchError: Error, LocalizedError, Equatable {
    /// Some frame has no copy on the server, or the frames are on more than one.
    case framesNotOnOneServer
    /// Polling failed long enough to give up; the job itself may be fine.
    case lostContact
    case jobFailed(String)
    /// The job was stopped on the server — by the web app, another device,
    /// or a newer preview superseding this one.
    case stoppedOnServer
    case previewUndecodable

    public var errorDescription: String? {
        switch self {
        case .framesNotOnOneServer:
            return "Every frame has to be on the same Maple server to stitch there."
        case .lostContact:
            return "Lost contact with the server. The panorama keeps going there — try again to reconnect."
        case .jobFailed(let message):
            return message
        case .stoppedOnServer:
            return "The panorama was stopped on the server, perhaps from another device."
        case .previewUndecodable:
            return "The server’s panorama preview couldn’t be decoded."
        }
    }
}

public final class ServerPanoStitcher: PanoStitching {
    private struct State {
        /// Bumped by `cancel()`; a poll loop started under an older value stops.
        var generation: UInt64 = 0
        /// The jobs a poll loop is watching right now; `cancel()` stops them.
        var watchedStitchJob: String?
        var watchedPreviewJob: String?
        /// The last stitch asked for, kept so Try Again after a lost
        /// connection follows the same job instead of queueing another.
        var lastStitch: (request: PanoServerRequest, jobID: String)?
    }

    private let jobs: any PanoServerJobs
    private let pollInterval: Duration
    /// Consecutive failed polls before the run reports `.lostContact`.
    private let pollAttempts: Int
    private let state = OSAllocatedUnfairLock(initialState: State())

    public init(jobs: any PanoServerJobs, pollInterval: Duration = .seconds(1), pollAttempts: Int = 6) {
        self.jobs = jobs
        self.pollInterval = pollInterval
        self.pollAttempts = pollAttempts
    }

    /// Whether these frames can be stitched on a server: all of them have a
    /// copy on the same one. Returns that server's registry URL.
    public static func server(for assets: [AssetRef]) -> URL? {
        let servers = Set(assets.map { $0.catalog?.serverID })
        guard servers.count == 1, let only = servers.first else { return nil }
        return only
    }

    /// Why the server can't stitch right now, in words for the merge sheet;
    /// `nil` when it can. A stock self-hosted image ships the stitcher, so
    /// this is usually `nil` with no setup.
    public func unavailableReason() async -> String? {
        do {
            let config = try await jobs.config()
            return config.provisioned
                ? nil
                : "Panorama stitching isn’t set up on this server. An owner can turn it on in Settings → Pano."
        } catch let refusal as PanoServerError {
            return refusal.message
        } catch {
            return "Couldn’t reach the server to check whether it can stitch."
        }
    }

    public func preview(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        let generation = state.withLock { $0.generation }
        let jobID = try await jobs.preview(try Self.request(assets, options, alignment))
        try claim(jobID, generation: generation) { $0.watchedPreviewJob = jobID }
        defer { state.withLock { if $0.watchedPreviewJob == jobID { $0.watchedPreviewJob = nil } } }
        let job = try await watch(jobID, generation: generation, progress: progress)
        let png = try await jobs.previewImage(jobID)
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw ServerPanoStitchError.previewUndecodable }
        return PanoPreview(
            image: image,
            alignment: PanoAlignment(json: Data(), serverPreviewJobID: jobID),
            alignmentOutcome: Self.alignmentOutcome(job.result?.alignment),
            matcher: Self.matcher(job.result)
        )
    }

    public func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        maxCanvasPixels: Int?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        let generation = state.withLock { $0.generation }
        let request = try Self.request(assets, options, alignment)
        let jobID = try await followOrCreate(request)
        try claim(jobID, generation: generation) {
            $0.lastStitch = (request, jobID)
            $0.watchedStitchJob = jobID
        }
        defer { state.withLock { if $0.watchedStitchJob == jobID { $0.watchedStitchJob = nil } } }
        let job = try await watch(jobID, generation: generation, progress: progress)
        state.withLock { $0.lastStitch = nil }
        guard let result = job.result, let assetID = result.outputAssetId, let path = result.outputPath else {
            throw ServerPanoStitchError.jobFailed("The server finished without a panorama.")
        }
        return PanoResult(
            outputURL: URL(fileURLWithPath: path),
            reportSummary: "Stitched on the server.",
            alignmentOutcome: Self.alignmentOutcome(result.alignment),
            matcher: Self.matcher(result),
            serverAssetID: assetID
        )
    }

    /// Stops watching, and asks the server to stop the jobs being watched.
    /// A stitch left by a lost connection is not cancelled: Try Again goes
    /// through here and then resumes it. `abandon()` stops that one too.
    public func cancel() {
        let jobsToStop = state.withLock { state -> [String] in
            state.generation &+= 1
            let watched = [state.watchedStitchJob, state.watchedPreviewJob].compactMap { $0 }
            if state.watchedStitchJob != nil { state.lastStitch = nil }
            state.watchedStitchJob = nil
            state.watchedPreviewJob = nil
            return watched
        }
        jobsToStop.forEach(stop)
    }

    /// The merge sheet closed: stop the stitch a lost connection left running
    /// too, since nothing can rejoin it now.
    public func abandon() {
        cancel()
        let orphan = state.withLock { state -> String? in
            defer { state.lastStitch = nil }
            return state.lastStitch?.jobID
        }
        orphan.map(stop)
    }

    // MARK: - Private

    private func stop(_ jobID: String) {
        let jobs = self.jobs
        Task { try? await jobs.cancel(jobID) }
    }

    /// Records a just-created job as watched, unless `cancel()` ran while it
    /// was being created — then the server is told to stop it at once.
    private func claim(_ jobID: String, generation: UInt64, _ record: (inout State) -> Void) throws {
        let stillWanted = state.withLock { state -> Bool in
            guard state.generation == generation else { return false }
            record(&state)
            return true
        }
        guard stillWanted else {
            stop(jobID)
            throw CancellationError()
        }
    }

    /// Rejoins the last stitch when the request is unchanged and the job is
    /// still alive. A changed request replaces it: the server runs one stitch
    /// at a time, so the stale one would block the new one.
    private func followOrCreate(_ request: PanoServerRequest) async throws -> String {
        if let last = state.withLock({ $0.lastStitch }) {
            let job = try? await jobs.job(last.jobID)
            let alive = job.map { $0.status != .failed && $0.status != .cancelled } ?? false
            if alive && last.request == request { return last.jobID }
            if alive { try? await jobs.cancel(last.jobID) }
            state.withLock { $0.lastStitch = nil }
        }
        return try await jobs.stitch(request)
    }

    private func watch(
        _ jobID: String,
        generation: UInt64,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoServerJob {
        var failures = 0
        while true {
            try Task.checkCancellation()
            guard state.withLock({ $0.generation }) == generation else { throw CancellationError() }
            do {
                let job = try await jobs.job(jobID)
                failures = 0
                guard state.withLock({ $0.generation }) == generation else { throw CancellationError() }
                switch job.status {
                case .done:
                    return job
                case .cancelled:
                    throw ServerPanoStitchError.stoppedOnServer
                case .failed:
                    throw ServerPanoStitchError.jobFailed(
                        job.error ?? "The server couldn’t make the panorama.")
                case .queued, .running:
                    let (stage, fraction) = Self.stage(job.progress)
                    await progress(stage, fraction)
                }
            } catch let error where Self.isTransient(error) {
                failures += 1
                if failures >= pollAttempts { throw ServerPanoStitchError.lostContact }
            }
            try await Task.sleep(for: pollInterval * min(1 << max(failures - 1, 0), 8))
        }
    }

    static func request(
        _ assets: [AssetRef], _ options: PanoOptions, _ alignment: PanoAlignment?
    ) throws -> PanoServerRequest {
        let catalogs = assets.compactMap(\.catalog)
        guard catalogs.count == assets.count, server(for: assets) != nil, let first = catalogs.first else {
            throw ServerPanoStitchError.framesNotOnOneServer
        }
        return PanoServerRequest(
            assetPaths: catalogs.map(\.absPath),
            libraryId: first.folderID,
            options: PanoServerOptions(
                retention: options.retention.rawValue,
                localAlign: options.localAlign.rawValue,
                strategy: options.strategy.rawValue),
            alignmentFrom: alignment?.serverPreviewJobID)
    }

    /// The server reports 100 progress units per stage, in the FFI's order.
    static func stage(_ progress: PanoServerJob.Progress) -> (PanoStage, Double) {
        let units = max(progress.current, 0)
        let ordinal = UInt32(min(units / 100, 5))
        let fraction = units >= 600 ? 1.0 : Double(units % 100) / 100
        return (PanoStage.fromFFIStage(ordinal), fraction)
    }

    static func alignmentOutcome(_ alignment: PanoServerJob.Alignment?) -> PanoAlignmentOutcome {
        switch alignment?.status {
        case "reused": return .reused
        case "stale": return .stale(reason: alignment?.staleReason ?? "the frames or options changed")
        default: return .solved
        }
    }

    static func matcher(_ result: PanoServerJob.Result?) -> PanoMatcherOutcome {
        if let note = result?.matcherNote, !note.isEmpty { return .serverClassicalFallback(note: note) }
        return .used(PanoFeatureEngine(rawValue: result?.matcher ?? "") ?? .classical)
    }

    /// A dropped connection or a server that is restarting; a refusal is final.
    static func isTransient(_ error: any Error) -> Bool {
        if error is URLError { return true }
        if let refusal = error as? PanoServerError { return refusal.statusCode >= 500 }
        return false
    }
}
