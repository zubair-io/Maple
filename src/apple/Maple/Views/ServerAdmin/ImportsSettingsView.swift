// ImportsSettingsView.swift — Settings → Cloud → Manage → Imports (#2773).
//
// Three-step wizard: pick a target library and a server-local source folder
// → review capture-date buckets → watch progress. Persists no settings of
// its own — every action here creates or advances an import job on the
// server. Mirrors the web page at src/web/.../settings/imports; see
// `imports.component.ts` for the reference flow this ports.
//
// Deep link: constructing this view with a non-nil `jobID` (the native
// equivalent of the web's `?job=<id>` query param) lands directly on step 3
// and starts polling that job — the entry point T2's Workers "Import" group
// is expected to use once it exists (#2765).

import SwiftUI
import MapleCore

struct ImportsSettingsView: View {
    let client: ImportsClient

    private enum Step: Equatable {
        case pick
        case review
        case progress
    }

    private let jobID: String?

    @State private var step: Step
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var queuedNotice: ImportsQueuedNotice?

    // Step 1 — library + source picker.
    @State private var libraries: [CloudFolder] = []
    @State private var roots: [String] = []
    @State private var targetLibraryID = ""
    @State private var listing: ImportsDirListing?
    @State private var selectedSource: String?

    // Step 2 — scan + review.
    @State private var scanResult: ImportScanResult?
    @State private var reviewForm = ImportReviewForm()

    // Step 3 — progress.
    @State private var activeSummary: ImportSummary?
    @State private var pollTask: Task<Void, Never>?

    init(client: ImportsClient, jobID: String? = nil) {
        self.client = client
        self.jobID = jobID
        _step = State(
            initialValue: ImportsSettingsVM.startsOnProgress(jobID: jobID) ? .progress : .pick)
    }

    private var targetLibraryRoot: String? {
        libraries.first(where: { $0.id == targetLibraryID })?.path
    }

    var body: some View {
        Form {
            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("imports.error")
                }
                .listRowBackground(MapleTokens.surface)
            }

            switch step {
            case .pick:
                ImportsPickStepView(
                    libraries: libraries,
                    targetLibraryID: targetLibraryID,
                    listing: listing,
                    selectedSource: selectedSource,
                    busy: busy,
                    queuedNotice: ImportsSettingsVM.queuedNoticeText(queuedNotice),
                    blocked: ImportsSettingsVM.currentBlocked(
                        listingPath: listing?.path, libraryRoot: targetLibraryRoot),
                    onSelectLibrary: { id in Task { await selectLibrary(id) } },
                    onOpen: { path in Task { await open(path) } },
                    onUp: { Task { await up() } },
                    onUseFolder: { path in useFolder(path) },
                    onChangeSource: { selectedSource = nil },
                    onScan: { Task { await runScan() } },
                    onAutoImport: { Task { await autoImport() } })
            case .review:
                if let scanResult {
                    ImportsReviewStepView(
                        scan: scanResult,
                        libraryLabel: ImportsSettingsVM.libraryLabel(
                            libraries: libraries, id: targetLibraryID),
                        form: $reviewForm,
                        busy: busy,
                        onBack: backToPick,
                        onImport: { Task { await startImport() } })
                }
            case .progress:
                ImportsProgressStepView(
                    summary: activeSummary,
                    onCancel: { Task { await cancel() } },
                    onRetry: { Task { await retry() } },
                    onNewImport: reset)
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await initialLoad() }
        .onDisappear { pollTask?.cancel() }
    }

    // MARK: - Load

    private func initialLoad() async {
        busy = true
        errorMessage = nil
        do {
            async let libs = client.libraries()
            async let fsRoots = client.roots()
            libraries = try await libs
            roots = try await fsRoots
        } catch {
            errorMessage = error.localizedDescription
        }
        busy = false

        if let jobID {
            startPolling(jobID)
        }
    }

    // MARK: - Step 1: library + picker

    private func selectLibrary(_ id: String) async {
        targetLibraryID = id
        selectedSource = nil
        errorMessage = nil
        // Open at the filesystem root so the source is chosen from outside
        // any library, not from inside the one just picked.
        await open(roots.first ?? "/")
    }

    private func open(_ path: String) async {
        busy = true
        errorMessage = nil
        do {
            listing = try await client.browse(path: path)
        } catch {
            errorMessage = error.localizedDescription
        }
        busy = false
    }

    private func up() async {
        guard let parent = listing?.parent else { return }
        await open(parent)
    }

    private func useFolder(_ path: String) {
        guard !ImportsSettingsVM.currentBlocked(listingPath: path, libraryRoot: targetLibraryRoot)
        else { return }
        queuedNotice = nil  // committing to a new import — drop the prior notice
        selectedSource = path
    }

    // MARK: - Step 2: scan

    private func runScan() async {
        guard let source = selectedSource, !targetLibraryID.isEmpty else { return }
        busy = true
        errorMessage = nil
        do {
            let result = try await client.scan(sourceRoot: source, libraryID: targetLibraryID)
            if result.totals.files == 0 {
                // Stay on step 1 rather than advancing to an empty review.
                errorMessage = "No importable photos, sidecars, or movies in that folder."
            } else {
                scanResult = result
                reviewForm = ImportReviewForm()
                step = .review
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        busy = false
    }

    private func backToPick() {
        scanResult = nil
        step = .pick
    }

    // MARK: - Step 3: create + progress

    private func startImport() async {
        await queue(labels: reviewForm.requestLabels(), auto: nil, notice: .manual)
    }

    private func autoImport() async {
        await queue(labels: nil, auto: true, notice: .auto)
    }

    /// Shared create + return-to-start-with-notice for both import paths,
    /// mirroring the web's `queue()`.
    private func queue(labels: [String: String]?, auto: Bool?, notice: ImportsQueuedNotice) async {
        guard let source = selectedSource, !targetLibraryID.isEmpty else { return }
        busy = true
        errorMessage = nil
        do {
            _ = try await client.create(
                sourceRoot: source, libraryID: targetLibraryID, labels: labels, auto: auto)
            queuedNotice = notice
            selectedSource = nil
            scanResult = nil
            reviewForm = ImportReviewForm()
            step = .pick
        } catch {
            errorMessage = error.localizedDescription
        }
        busy = false
    }

    /// Polls at 1500ms against the `summary=1` variant and self-terminates
    /// at done/failed/cancelled — see `ImportsClient.status` and
    /// `ImportSummary.isTerminal`. Runs as a plain loop rather than a timer
    /// publisher so it can `await` each request and back off implicitly:
    /// the next tick never fires until the previous one has returned.
    private func startPolling(_ id: String) {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                do {
                    let summary = try await client.status(id: id)
                    activeSummary = summary
                    if summary.isTerminal { return }
                } catch {
                    errorMessage = error.localizedDescription
                    return
                }
                try? await Task.sleep(for: .milliseconds(1500))
            }
        }
    }

    private func cancel() async {
        guard let id = activeSummary?.id else { return }
        do {
            try await client.cancel(id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func retry() async {
        guard let id = activeSummary?.id else { return }
        do {
            try await client.retry(id: id)
            startPolling(id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Start over with a fresh pick, mirroring the web's `reset()`.
    private func reset() {
        pollTask?.cancel()
        activeSummary = nil
        scanResult = nil
        selectedSource = nil
        reviewForm = ImportReviewForm()
        errorMessage = nil
        step = .pick
    }
}

#Preview("Unreachable server") {
    ImportsSettingsView(client: .preview())
        .frame(width: 680, height: 640)
}
