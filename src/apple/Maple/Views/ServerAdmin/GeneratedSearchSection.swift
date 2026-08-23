// GeneratedSearchSection.swift — the generated-search worker on the native
// Workers settings page.
//
// The web panel existed first; this closes the "I don't see it in the iOS
// settings" gap. Scope mirrors what an operator does from a phone: see the
// state, flip Run daily, kick Run now, and read today's collections. The
// numeric knobs stay web-side — retuning retry budgets from a phone keyboard
// is nobody's workflow, and every knob the phone doesn't show is one it
// cannot mis-set.
//
// Collections come from the same read API the widget and TV shelf use, with
// the same first-library fallback the widget needed (only tvOS ever writes a
// registry library selection).

import MapleCore
import SwiftUI

struct GeneratedSearchSection: View {
    let admin: GeneratedSearchAdminClient
    let collectionsClient: GeneratedSearchClient
    let foldersClient: CloudFoldersClient

    @State private var config: GeneratedSearchAdminConfig?
    @State private var collections: [GeneratedSearchCard] = []
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var isBusy = false
    @State private var isRunning = false

    var body: some View {
        Section("Generated searches") {
            if let config {
                Toggle("Run daily", isOn: Binding(
                    get: { !config.paused },
                    set: { enabled in Task { await setPaused(!enabled) } }
                ))
                .disabled(isBusy)
                .accessibilityIdentifier("generatedSearch.runDaily")

                Button {
                    Task { await runNow() }
                } label: {
                    HStack {
                        Text(isRunning ? "Running…" : "Run now")
                        if isRunning {
                            Spacer()
                            ProgressView().controlSize(.small)
                        }
                    }
                }
                .disabled(isBusy || isRunning)
                .accessibilityIdentifier("generatedSearch.runNow")

                if let actionError {
                    Text(actionError)
                        .foregroundStyle(.red)
                        .font(.caption)
                        .accessibilityIdentifier("generatedSearch.actionError")
                }

                if collections.isEmpty {
                    Text("No collections yet — they appear after the first run.")
                        .foregroundStyle(.secondary)
                        .font(.callout)
                } else {
                    ForEach(collections) { collection in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(collection.title)
                            HStack {
                                if let subtitle = collection.subtitle {
                                    Text(subtitle).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(collection.result_count) photos")
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                            .font(.caption)
                        }
                    }
                }
            } else if let loadError {
                Text("Generated searches unavailable: \(loadError)")
                    .foregroundStyle(.secondary)
                    .font(.callout)
            } else {
                HStack {
                    Text("Loading…").foregroundStyle(.secondary)
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            }
        }
        .listRowBackground(MapleTokens.surface)
        .task { await load() }
    }

    private func load() async {
        do {
            config = try await admin.fetchConfig()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
            return
        }
        await loadCollections()
    }

    /// Same resolution as the widget: registry selection when present (tvOS
    /// writes it), else the server's first registered library. A failure here
    /// leaves the config half working — an empty list is indistinguishable
    /// from "no run yet", which is the common case.
    private func loadCollections() async {
        let resolved: String?
        if let selected = CloudServerRegistry.shared.selectedLibraryID(for: admin.server) {
            resolved = selected
        } else {
            resolved = try? await foldersClient.listFolders().first?.id
        }
        guard let libraryID = resolved else { return }
        collections = (try? await collectionsClient.collections(libraryID: libraryID)) ?? []
    }

    private func setPaused(_ paused: Bool) async {
        isBusy = true
        defer { isBusy = false }
        do {
            // Adopt the server's stored config, not the optimistic local value.
            config = try await admin.save(GeneratedSearchAdminPatch(paused: paused))
            actionError = nil
        } catch {
            // Keep the last known config — nulling it collapsed the whole
            // section back to an indefinite Loading… with no way to retry.
            actionError = error.localizedDescription
        }
    }

    private func runNow() async {
        isRunning = true
        defer { isRunning = false }
        do {
            // `started: false` (already-running) means a pass IS in flight —
            // it takes the same wait-and-refresh path so the indicator stays
            // honest, mirroring the web panel's behaviour.
            _ = try await admin.runNow()
            actionError = nil
        } catch {
            actionError = error.localizedDescription
            return
        }
        // A pass takes minutes; a short wait catches fast runs, and a still-
        // running pass simply shows on the next visit to this page.
        try? await Task.sleep(for: .seconds(4))
        await loadCollections()
    }
}
