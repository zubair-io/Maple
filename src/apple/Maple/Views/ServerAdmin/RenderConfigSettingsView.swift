// RenderConfigSettingsView.swift — the GPU live render panel on the
// Workers page (T5b, #2772). Mirrors GpuLiveRenderSettingsComponent
// (src/web/.../workers/gpu-live-render-settings.component.ts): a single
// toggle for the web GPU live-render ramp/kill switch, a status label, and
// the local GPU capability readout.
//
// "Local" here is THIS app's own render path, not a probe of the server or
// of a browser's WebGPU support — see RenderConfig.swift's file comment.
// The toggle saves immediately, matching the web panel: a kill switch you
// have to remember to commit is a kill switch that gets left half-thrown.

import SwiftUI
import MapleCore
import MapleUI

struct RenderConfigSettingsView: View {
    let client: RenderConfigClient

    @State private var config: RenderConfig?
    @State private var loading = true
    @State private var loadError: String?
    @State private var saving = false
    /// Distinct from `loadError`: that banner replaces the whole panel body
    /// (there is nothing to show once the initial GET fails), while a save
    /// failure happens with a perfectly good `config` already on screen — so
    /// it renders inline, next to the toggle, instead of hiding the panel.
    @State private var saveError: String?

    var body: some View {
        Section("GPU live render") {
            if loading {
                HStack {
                    Text("Loading…").foregroundStyle(.secondary)
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            } else if let loadError {
                MuiBanner(
                    variant: .error, message: "Failed to load render config: \(loadError)",
                    actionLabel: "Retry", actionPressed: { Task { await load() } }
                )
                .accessibilityIdentifier("workers.renderConfig.loadError")
            } else {
                MuiToggle(
                    checked: Binding(
                        get: { config?.gpuLiveRenderEnabled ?? true },
                        set: { next in Task { await setEnabled(next) } }),
                    label: "Web GPU live render", disabled: saving
                )
                .accessibilityIdentifier("workers.renderConfig.enabled")

                if let saveError {
                    MuiStatusText(state: .error, text: saveError)
                        .accessibilityIdentifier("workers.renderConfig.saveError")
                }

                LabeledContent("This app") {
                    Text(MaintenancePanelsVM.renderStatusLabel(localGpuEnabled: GpuLiveFlag.isEnabled))
                        .foregroundStyle(GpuLiveFlag.isEnabled ? .green : .secondary)
                }
                .accessibilityIdentifier("workers.renderConfig.localCapability")

                Text(MaintenancePanelsVM.renderProvenanceLine(config))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("workers.renderConfig.provenance")
            }
        }
        .listRowBackground(MapleTokens.surface)
        .task { await load() }
    }

    // @MainActor — see MirrorSettingsView's identical note.
    @MainActor
    private func load() async {
        loading = true
        loadError = nil
        do {
            config = try await client.fetch()
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }

    @MainActor
    private func setEnabled(_ next: Bool) async {
        guard !saving else { return }
        saving = true
        saveError = nil
        let previous = config
        do {
            config = try await client.save(RenderConfigPatch(gpuLiveRenderEnabled: next))
        } catch {
            config = previous
            saveError = error.localizedDescription
        }
        saving = false
    }
}
