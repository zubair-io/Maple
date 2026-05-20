// ExportPanel.swift — Export panel (basic version, full impl in P9).

import SwiftUI
import MapleCore

struct ExportPanel: View {
    let session: EditSession
    @Environment(\.dismiss) private var dismiss

    @State private var selectedFormat = ExportFileFormat.jpegSRGB
    @State private var quality: Double = 0.92
    @State private var isExporting = false
    @State private var exportError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Format") {
                    Picker("Format", selection: $selectedFormat) {
                        ForEach(ExportFileFormat.allCases, id: \.self) { fmt in
                            Text(fmt.displayName).tag(fmt)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if selectedFormat == .jpegSRGB || selectedFormat == .jpegP3 || selectedFormat == .heicP3 {
                    Section("Quality") {
                        HStack {
                            Slider(value: $quality, in: 0.5...1.0)
                            Text("\(Int(quality * 100))%")
                                .font(.system(.caption, design: .monospaced))
                                .frame(width: 36)
                        }
                    }
                }

                Section("Output") {
                    Text("File: \(session.asset.displayName).\(selectedFormat.fileExtension)")
                        .foregroundStyle(.secondary)
                }

                if let err = exportError {
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
                    Button(isExporting ? "Exporting…" : "Export") {
                        Task { await export() }
                    }
                    .disabled(isExporting)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 280)
    }

    private func export() async {
        isExporting = true
        exportError = nil
        defer { isExporting = false }

        let options = ExportOptions(format: selectedFormat, quality: quality)

        do {
            #if os(macOS)
            try await MapleExporter.exportWithSavePanel(session: session, options: options)
            dismiss()
            #else
            let _ = try await MapleExporter.exportData(session: session, options: options)
            dismiss()
            #endif
        } catch {
            exportError = error.localizedDescription
        }
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
