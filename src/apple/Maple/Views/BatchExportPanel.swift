// BatchExportPanel.swift — batch photo output to Files/Photos/share (#3852).

#if os(iOS)
  import MapleCore
  import MapleUI
  import SwiftUI
  import UIKit

  /// Present with the checked AssetRefs and a resolver that returns each
  /// asset's real EditSession (including its source-specific sidecar store).
  /// The panel hydrates each session and never exports a preview seed.
  struct BatchExportPanel: View {
    let assets: [AssetRef]
    @Environment(\.dismiss) private var dismiss
    @State private var vm: BatchExportPanelVM

    init(assets: [AssetRef], resolveSession: @escaping BatchExportPanelVM.SessionResolver) {
      self.assets = assets
      _vm = State(initialValue: BatchExportPanelVM(resolveSession: resolveSession))
    }

    var body: some View {
      NavigationStack {
        Form {
          Section("Format") {
            Picker("Format", selection: $vm.format) {
              ForEach(ExportFileFormat.allCases, id: \.self) { format in
                Text(format.displayName).tag(format)
              }
            }
          }
          Section("Resolution") {
            Picker("Resolution", selection: $vm.sizeOption) {
              ForEach(ExportSizeOption.allCases, id: \.self) { option in
                Text(option.displayName).tag(option)
              }
            }
            .pickerStyle(.segmented)
          }
          if vm.showsQualityControl {
            Section("Quality") {
              HStack {
                Slider(value: $vm.quality, in: 0.5...1.0)
                Text("\(Int(vm.quality * 100))%")
                  .font(.system(.caption, design: .monospaced))
                  .frame(width: 40)
              }
            }
          }
          Section("Output") {
            Text("\(assets.count) photos")
            Text("Each photo is exported with its saved adjustments. Files remain separate.")
              .foregroundStyle(.secondary)
          }
          if vm.isExporting {
            Section {
              HStack(spacing: MapleTokens.Spacing.iconLabelGap) {
                MuiSpinner(size: .sm, label: "Exporting")
                Text("Rendering \(vm.completedCount + 1) of \(assets.count)…")
              }
              .accessibilityIdentifier("batch-export-progress")
            }
          }
          if let error = vm.exportError {
            Section { Text(error).foregroundStyle(.red) }
          }
        }
        .navigationTitle("Export Photos")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
              if vm.isExporting { vm.cancelExport() } else { dismiss() }
            }
            .accessibilityIdentifier("batch-export-cancel")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(vm.isExporting ? "Exporting…" : "Export") {
              vm.begin(assets: assets)
            }
            .disabled(vm.isExporting || assets.isEmpty || vm.stagedBatch != nil)
            .accessibilityIdentifier("batch-export-confirm")
          }
        }
      }
      .sheet(
        item: Binding(
          get: { vm.stagedBatch },
          set: { if $0 == nil { vm.discardStagedBatch() } }
        )
      ) { batch in
        BatchExportShareSheet(fileURLs: batch.files) { completed, error in
          vm.finishSharing(completed: completed, error: error)
          if completed && error == nil { dismiss() }
        }
      }
      .onDisappear {
        vm.cancelExport()
        vm.discardStagedBatch()
      }
    }
  }

  private struct BatchExportShareSheet: UIViewControllerRepresentable {
    let fileURLs: [URL]
    let onFinish: (Bool, Error?) -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
      let controller = UIActivityViewController(activityItems: fileURLs, applicationActivities: nil)
      controller.completionWithItemsHandler = { _, completed, _, error in
        onFinish(completed, error)
      }
      return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
  }
#endif
