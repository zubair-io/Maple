// PanoContinuedProcessing.swift — runs a panorama stitch on in the background with system progress (#5663).

import MapleCore

#if os(iOS)
import BackgroundTasks
import Observation
import UIKit
import UserNotifications

@MainActor
final class PanoContinuedProcessing {
    static let shared = PanoContinuedProcessing()

    /// Must match the entry stamped into BGTaskSchedulerPermittedIdentifiers
    /// by the "Embed backup agent" build phase.
    static let taskIdentifier = "app.justmaple.aperture.pano.stitch"

    private struct Snapshot: Sendable {
        let state: PanoMergeSession.RunState
        let progress: PanoStitchProgress?
    }

    private weak var session: PanoMergeSession?
    private var observation: Task<Void, Never>?
    private var tracker = PanoSystemProgressTracker()
    private var handlerRegistered = false
    private var runActive = false
    private var latest: PanoSystemProgressTracker.Frame?
    private var endedBeforeTask: PanoSystemProgressTracker.Outcome?
    private var task: BGContinuedProcessingTask?

    private init() {}

    func attach(to session: PanoMergeSession) {
        guard self.session !== session else { return }
        observation?.cancel()
        self.session = session
        registerHandler()
        observation = Task { [weak self] in
            let snapshots = Observations {
                Snapshot(
                    state: session.state,
                    progress: session.stitchProgress(runsOnServer: session.stitcher is ServerPanoStitcher))
            }
            for await snapshot in snapshots {
                self?.consume(snapshot)
            }
        }
    }

    private func registerHandler() {
        guard !handlerRegistered else { return }
        handlerRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.taskIdentifier, using: nil
        ) { [weak self] task in
            guard let task = task as? BGContinuedProcessingTask else { return }
            task.expirationHandler = {
                Task { @MainActor in self?.session?.cancel() }
            }
            Task { @MainActor in self?.adopt(task) }
        }
    }

    private func consume(_ snapshot: Snapshot) {
        switch tracker.consume(snapshot.state, progress: snapshot.progress) {
        case .began(let frame):
            runActive = true
            endedBeforeTask = nil
            latest = frame
            submitRequest(subtitle: frame.subtitle)
            Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.provisional]) }
        case .progressed(let frame):
            latest = frame
            apply(frame)
        case .ended(let outcome):
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
            try? BGTaskScheduler.shared.submit(request)
        }
    }

    private func adopt(_ task: BGContinuedProcessingTask) {
        if let outcome = endedBeforeTask {
            endedBeforeTask = nil
            complete(task, with: outcome)
            return
        }
        guard runActive else { return task.setTaskCompleted(success: false) }
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
        switch outcome {
        case .finished:
            task.progress.completedUnitCount = Int64(PanoSystemProgressTracker.totalUnits)
            task.updateTitle("Panorama ready", subtitle: "Open Maple to add it to your library")
        case .failed(let message):
            task.updateTitle("Panorama failed", subtitle: message)
        case .stopped:
            break
        }
        task.setTaskCompleted(success: outcome == .finished)
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

#else

@MainActor
final class PanoContinuedProcessing {
    static let shared = PanoContinuedProcessing()
    private init() {}
    func attach(to session: PanoMergeSession) {}
}

#endif
