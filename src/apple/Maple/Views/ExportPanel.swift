// ExportPanel.swift — Export panel presented from the editor's Share button.
//
// macOS: `NSSavePanel` picks the destination. iOS / iPadOS: the render is
// staged as a file and handed to the system share sheet so it can land in
// Files, Photos, AirDrop, etc. (#3403). State + the staging logic live in
// `ExportPanel+VM.swift`.

import MapleCore
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
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(vm.isExporting ? "Exporting…" : "Export") {
            Task { await export() }
          }
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

  private func export() async {
    #if os(macOS)
      await vm.perform {
        try await MapleExporter.exportWithSavePanel(session: session, options: vm.options)
      }
      if vm.exportError == nil { dismiss() }
    #else
      await vm.stageForSharing(session: session)
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
