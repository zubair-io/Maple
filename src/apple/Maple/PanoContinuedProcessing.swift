// PanoContinuedProcessing.swift — runs a panorama stitch on in the background with system progress (#5663).

import MapleCore

#if os(iOS)
import BackgroundTasks
import Observation
import os
import UIKit
import UserNotifications

private let log = Logger(subsystem: "app.justmaple.aperture", category: "pano-continued")

@MainActor
final class PanoContinuedProcessing {
    static let shared = PanoContinuedProcessing()

    /// Must match the entry stamped into BGTaskSchedulerPermittedIdentifiers
    /// by the "Embed backup agent" build phase.
    static let taskIdentifier = "app.justmaple.aperture.pano.stitch"

    private static let screenClosedMessage = "The merge screen closed while the panorama was stitching."

    private struct Snapshot: Sendable {
        let state: PanoMergeSession.RunState
        let progress: PanoStitchProgress?
    }

    private weak var ownerSession: PanoMergeSession?
    private var arbiter = PanoSystemProgressArbiter<ObjectIdentifier>()
    private var handlerRegistered = false
    private var runActive = false
    private var latest: PanoSystemProgressTracker.Frame?
    private var endedBeforeTask: PanoSystemProgressTracker.Outcome?
    private var task: BGContinuedProcessingTask?
    private var runStartedAt: ContinuousClock.Instant?

    private init() {}

    func observe(_ session: PanoMergeSession) async {
        registerHandler()
        let id = ObjectIdentifier(session)
        let snapshots = Observations {
            Snapshot(
                state: session.state,
                progress: session.stitchProgress(runsOnServer: session.stitcher is ServerPanoStitcher))
        }
        for await snapshot in snapshots {
            let event = arbiter.consume(id, state: snapshot.state, progress: snapshot.progress)
            handle(event, from: session)
        }
        let released = arbiter.release(id)
        log.notice("observation ended; run released=\(released != nil, privacy: .public)")
        let stillRunning = session.isRunning && released != nil
        handle(stillRunning ? .ended(.failed(Self.screenClosedMessage)) : released, from: session)
    }

    private func registerHandler() {
        guard !handlerRegistered else { return }
        handlerRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.taskIdentifier, using: nil
        ) { [weak self] task in
            guard let task = task as? BGContinuedProcessingTask else { return }
            task.expirationHandler = {
                Task { @MainActor in self?.expire(task) }
            }
            Task { @MainActor in self?.adopt(task) }
        }
    }

    private func handle(_ event: PanoSystemProgressTracker.Event?, from session: PanoMergeSession) {
        switch event {
        case .began(let frame):
            log.notice("run began: \(frame.subtitle, privacy: .public)")
            ownerSession = session
            runActive = true
            runStartedAt = .now
            endedBeforeTask = nil
            latest = frame
            submitRequest(subtitle: frame.subtitle)
            Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.provisional]) }
        case .progressed(let frame):
            latest = frame
            apply(frame)
        case .ended(let outcome):
            log.notice("run ended: \(outcome.logName, privacy: .public)")
            ownerSession = nil
            runActive = false
            latest = nil
            finish(outcome)
        case nil:
            break
        }
    }

    private func submitRequest(subtitle: String) {
        let identifier = Self.taskIdentifier
        Task.detached {
            let request = BGContinuedProcessingTaskRequest(
                identifier: identifier, title: "Creating panorama", subtitle: subtitle)
            request.strategy = .fail
            do {
                try BGTaskScheduler.shared.submit(request)
                log.notice("task request submitted")
            } catch {
                log.error("task request rejected: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func expire(_ task: BGContinuedProcessingTask) {
        log.error("system expired the task; run active=\(self.runActive, privacy: .public)")
        guard runActive, let ownerSession else { return }
        let ran = runStartedAt.map { ContinuousClock.now - $0 } ?? .zero
        let elapsed = ran.formatted(.units(allowed: [.minutes, .seconds], width: .abbreviated))
        let phase = latest?.subtitle ?? "starting"
        let message =
            "The background task ended after \(elapsed), during \"\(phase)\". Keep Maple open while it stitches, then try again."
        log.error("expiry reason: \(message, privacy: .public)")
        guard ownerSession.abort(because: message) else { return }
    }

    private func adopt(_ task: BGContinuedProcessingTask) {
        if let outcome = endedBeforeTask {
            endedBeforeTask = nil
            complete(task, with: outcome)
            return
        }
        guard runActive else {
            log.error("system started the task but no run is active")
            return task.setTaskCompleted(success: false)
        }
        log.notice("system started the task")
        self.task = task
        task.progress.totalUnitCount = Int64(PanoSystemProgressTracker.totalUnits)
        if let latest { apply(latest) }
    }

    private func apply(_ frame: PanoSystemProgressTracker.Frame) {
        guard let task else { return }
        task.progress.completedUnitCount = Int64(frame.units)
        task.updateTitle(task.title, subtitle: frame.subtitle)
    }

    private func finish(_ outcome: PanoSystemProgressTracker.Outcome) {
        notify(outcome)
        guard let task else {
            endedBeforeTask = outcome
            return
        }
        self.task = nil
        complete(task, with: outcome)
    }

    private func complete(_ task: BGContinuedProcessingTask, with outcome: PanoSystemProgressTracker.Outcome) {
        log.notice("completing task: \(outcome.logName, privacy: .public)")
        switch outcome {
        case .finished:
            task.progress.completedUnitCount = Int64(PanoSystemProgressTracker.totalUnits)
            task.updateTitle("Panorama ready", subtitle: "Open Maple to add it to your library")
        case .failed(let message):
            task.updateTitle("Panorama failed", subtitle: message)
        case .stopped:
            task.updateTitle("Panorama stopped", subtitle: "Stopped from Maple")
        }
        task.setTaskCompleted(success: !outcome.isFailure)
    }

    private func notify(_ outcome: PanoSystemProgressTracker.Outcome) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        switch outcome {
        case .finished:
            content.title = "Panorama ready"
            content.body = "Open Maple to add it to your library."
        case .failed(let message):
            content.title = "Panorama failed"
            content.body = message
        case .stopped:
            return
        }
        let request = UNNotificationRequest(
            identifier: "app.justmaple.aperture.pano.result", content: content, trigger: nil)
        Task { try? await UNUserNotificationCenter.current().add(request) }
    }
}

extension PanoSystemProgressTracker.Outcome {
    fileprivate var logName: String {
        switch self {
        case .finished: "finished"
        case .failed: "failed"
        case .stopped: "stopped"
        }
    }
}

#else

@MainActor
final class PanoContinuedProcessing {
    static let shared = PanoContinuedProcessing()
    private init() {}
    func observe(_ session: PanoMergeSession) async {}
}

#endif
