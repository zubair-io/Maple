// ExportPanel.swift — Export panel (basic version, full impl in P9).

import SwiftUI
import MapleCore

struct ExportPanel: View {
    let session: EditSession
    @Environment(\.dismiss) private var dismiss

    @State private var selectedFormat = ExportFormat.jpegSRGB
    @State private var isExporting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Format") {
                    Picker("Format", selection: $selectedFormat) {
                        ForEach(ExportFormat.allCases, id: \.self) { fmt in
                            Text(fmt.displayName).tag(fmt)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                Section("Output") {
                    Text("Exporting: \(session.asset.displayName)")
                        .foregroundStyle(.secondary)
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
        .frame(minWidth: 400, minHeight: 260)
    }

    private func export() async {
        isExporting = true
        defer { isExporting = false }
        // Full export logic in P9 (MapleExporter).
        // For now just render full-res and dismiss.
        await session.renderFull()
        dismiss()
    }
}

// MARK: - ExportFormat

public enum ExportFormat: String, CaseIterable {
    case jpegSRGB  = "jpeg_srgb"
    case jpegP3    = "jpeg_p3"
    case heicP3    = "heic_p3"
    case tiff16    = "tiff_16"
    case png       = "png"

    var displayName: String {
        switch self {
        case .jpegSRGB:  return "JPEG sRGB"
        case .jpegP3:    return "JPEG P3"
        case .heicP3:    return "HEIC P3"
        case .tiff16:    return "TIFF 16-bit"
        case .png:       return "PNG"
        }
    }

    var fileExtension: String {
        switch self {
        case .jpegSRGB, .jpegP3: return "jpg"
        case .heicP3:            return "heic"
        case .tiff16:            return "tiff"
        case .png:               return "png"
        }
    }
}
