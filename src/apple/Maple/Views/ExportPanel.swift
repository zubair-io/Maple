// ExportPanel.swift — Export panel presented from the editor's Share button.
//
// macOS: `NSSavePanel` picks the destination. iOS / iPadOS: the render is
// staged as a file and handed to the system share sheet so it can land in
// Files, Photos, AirDrop, etc. (#3403). State + the staging logic live in
// `ExportPanel+VM.swift`.
//
// #3450: a full-quality bake is seconds of work, so the panel says so — a
// Maple UI Spinner row while it runs (spinner.md § inline-next-to-a-label,
// the same treatment the folder-move sheet uses) and a Cancel that cancels
// the task rather than only closing the sheet.

import MapleCore
import MapleUI
import SwiftUI

struct ExportPanel: View {
  let session: EditSession
  @Environment(\.dismiss) private var dismiss
  @State private var vm = ExportPanelVM()

  var body: some View {
    NavigationStack {
      Form {
        Section("Format") {
          Picker("Format", selection: $vm.format) {
            ForEach(ExportFileFormat.allCases, id: \.self) { fmt in
              Text(fmt.displayName).tag(fmt)
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
                .frame(width: 36)
            }
          }
        }

        Section("Output") {
          Text("File: \(vm.outputFileName(for: session.asset))")
            .foregroundStyle(.secondary)
        }

        if vm.isExporting {
          Section {
            HStack(spacing: MapleTokens.Spacing.iconLabelGap) {
              MuiSpinner(size: .sm, label: "Exporting")
              MuiText("Rendering at full quality…", color: .muted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("export-progress")
          }
        }

        if let err = vm.exportError {
          Section {
            Text(err).foregroundStyle(.red).font(.caption)
          }
        }
      }
      .navigationTitle("Export")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          // While a bake is running the same slot stops it instead of
          // closing the sheet — a sheet dismissed mid-export would leave
          // the render burning CPU for a file nobody will receive.
          Button("Cancel") {
            if vm.isExporting {
              vm.cancelExport()
            } else {
              dismiss()
            }
          }
          .accessibilityIdentifier("export-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(vm.isExporting ? "Exporting…" : "Export") { export() }
            .disabled(vm.isExporting)
            .accessibilityIdentifier("export-confirm")
        }
      }
    }
    #if os(macOS)
      // Window-sheet floor on the Mac only: a 420pt minimum is wider than
      // an iPhone sheet and pushed the toolbar buttons past its edges (#3403).
      .frame(minWidth: 420, minHeight: 280)
    #else
      .sheet(item: $vm.stagedFile) { file in
        ExportShareSheet(fileURL: file.url) { completed in
          vm.stagedFile = nil
          if completed { dismiss() }
        }
        .presentationDetents([.medium, .large])
      }
    #endif
  }

  private func export() {
    #if os(macOS)
      // The save panel is modal and owns its own destination, so the Mac
      // keeps its one-shot shape; the render + encode behind it now hop
      // off the main actor too (`MapleExporter.encodeOffMainActor`).
      Task { @MainActor in
        await vm.begin {
          try await MapleExporter.exportWithSavePanel(session: session, options: vm.options)
        }.value
        if vm.exportError == nil { dismiss() }
      }
    #else
      vm.beginStagingForSharing(session: session)
    #endif
  }
}

// MARK: - Previews
//
// Issue #139 — Export sheet against a stub EditSession. Real export is
// gated behind the user pressing the toolbar button, which would fail
// because the preview asset has no bytes — that's intentional, the
// preview is for layout/state coverage only.

#Preview("Default") {
  ExportPanel(session: EditSession.preview())
}
