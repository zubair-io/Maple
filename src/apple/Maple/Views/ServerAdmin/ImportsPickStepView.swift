// ImportsPickStepView.swift — Imports wizard step 1: choose a target
// library, then browse the server's filesystem for a source folder (#2773).
//
// Up is disabled at the MAPLE_ROOTS jail root, signalled by
// `listing.parent == nil` (mirrors the web's `atRoot()`). `blocked` disables
// "Use this folder" and shows the hint when the picker is sitting inside
// the target library — the actual rule (`ImportSourceGuard.isInsideLibrary`)
// lives one layer down in MapleCloudKit; this view only renders its result.

import SwiftUI
import MapleCore
import MapleUI

struct ImportsPickStepView: View {
    let libraries: [CloudFolder]
    let targetLibraryID: String
    let listing: ImportsDirListing?
    let selectedSource: String?
    let busy: Bool
    let queuedNotice: String?
    let blocked: Bool

    let onSelectLibrary: (String) -> Void
    let onOpen: (String) -> Void
    let onUp: () -> Void
    let onUseFolder: (String) -> Void
    let onChangeSource: () -> Void
    let onScan: () -> Void
    let onAutoImport: () -> Void

    var body: some View {
        if let queuedNotice {
            Section {
                MuiBanner(variant: .success, message: queuedNotice)
                    .accessibilityIdentifier("imports.queuedNotice")
            }
            .listRowBackground(MapleTokens.surface)
        }

        Section("1 · Target library") {
            Picker(
                "Library",
                selection: Binding(get: { targetLibraryID }, set: onSelectLibrary)
            ) {
                Text("Choose a library…").tag("")
                ForEach(libraries) { library in
                    Text("\(library.displayName) — \(library.path)").tag(library.id)
                }
            }
            .accessibilityIdentifier("imports.librarySelect")
        }
        .listRowBackground(MapleTokens.surface)

        if !targetLibraryID.isEmpty {
            Section("2 · Source folder") {
                if let selectedSource {
                    pickedSourceRow(selectedSource)
                } else {
                    browser
                }
            }
            .listRowBackground(MapleTokens.surface)
        }
    }

    @ViewBuilder
    private func pickedSourceRow(_ path: String) -> some View {
        HStack {
            Image(systemName: "checkmark.circle").foregroundStyle(.green)
            Text(path)
                .font(.system(.body, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button("Change", action: onChangeSource)
        }
        .accessibilityIdentifier("imports.selectedSource")

        HStack {
            Button {
                onScan()
            } label: {
                Text(busy ? "Scanning…" : "Pick Folder Name(s)")
            }
            .disabled(busy)
            .accessibilityIdentifier("imports.scan")

            Button("Auto Import", action: onAutoImport)
                .disabled(busy)
                .help(
                    "Queue immediately — the worker scans and files everything under the "
                        + "default folder.")
                .accessibilityIdentifier("imports.autoImport")
        }
    }

    @ViewBuilder
    private var browser: some View {
        HStack {
            Button {
                onUp()
            } label: {
                Label("Up", systemImage: "chevron.up")
            }
            .disabled(busy || listing?.parent == nil)
            .accessibilityIdentifier("imports.up")

            Text(listing?.path ?? "/")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }

        if let dirs = listing?.dirs, !dirs.isEmpty {
            ForEach(dirs, id: \.path) { dir in
                Button {
                    onOpen(dir.path)
                } label: {
                    HStack {
                        Image(systemName: "folder")
                        Text(dir.name)
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }
                }
                .disabled(busy)
                .accessibilityIdentifier("imports.dir.\(dir.name)")
            }
        } else if listing != nil {
            Text("No subfolders here.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        if blocked {
            Text("This folder is inside the target library — pick a source outside it.")
                .font(.caption)
                .foregroundStyle(.orange)
                .accessibilityIdentifier("imports.blockedHint")
        }

        Button("Use this folder") {
            if let path = listing?.path { onUseFolder(path) }
        }
        .disabled(busy || blocked || listing == nil)
        .accessibilityIdentifier("imports.useFolder")
    }
}
