// ImportsReviewStepView.swift — Imports wizard step 2: review capture-date
// buckets before creating the import (#2773).
//
// A bucket's label field starts BLANK: leaving it blank means "use the
// server's default" shown in the destination preview below the field. The
// nearby-match note only shows while there's no override — an explicit
// label always outranks a nearby match server-side. `ImportReviewForm`
// (MapleCloudKit) owns both rules; this view only renders their result.

import SwiftUI
import MapleCore

struct ImportsReviewStepView: View {
    let scan: ImportScanResult
    let libraryLabel: String
    @Binding var form: ImportReviewForm
    let busy: Bool

    let onBack: () -> Void
    let onImport: () -> Void

    var body: some View {
        Section("3 · Review groups") {
            Text(
                "\(scan.totals.images) photos · \(scan.totals.movies) movies · "
                    + "\(scan.totals.sidecars) sidecars → \(libraryLabel)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(
                "Groups are by capture date. Leave a folder name blank to use the default "
                    + "destination shown below each row — an already-indexed photo captured "
                    + "within 30 minutes of one of these files always takes priority, for just "
                    + "those files.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .listRowBackground(MapleTokens.surface)

        Section("Buckets") {
            ForEach(scan.buckets) { bucket in
                bucketRow(bucket)
            }
        }
        .listRowBackground(MapleTokens.surface)

        Section {
            HStack {
                Button("Back", action: onBack)
                    .disabled(busy)
                    .accessibilityIdentifier("imports.backToPick")
                Spacer()
                Button {
                    onImport()
                } label: {
                    Text(busy ? "Starting…" : "Import \(scan.totals.files) files")
                }
                .disabled(busy)
                .accessibilityIdentifier("imports.startImport")
            }
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private func bucketRow(_ bucket: ImportScanBucket) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(bucket.key)
                    .font(.system(.body, design: .monospaced))
                Spacer()
                Text(
                    "\(bucket.imageCount) photos · \(bucket.movieCount) movies · "
                        + "\(bucket.sidecarCount) sidecars")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextField(
                "Folder name", text: labelBinding(for: bucket),
                prompt: Text("(leave blank for the default)")
            )
            .accessibilityIdentifier("imports.bucketLabel.\(bucket.key)")

            HStack(spacing: 4) {
                Text("→")
                Text(form.effectiveDest(for: bucket))
                    .font(.system(.caption, design: .monospaced))
                if bucket.nearbyMatchCount > 0, !form.hasOverride(for: bucket) {
                    Text(
                        "(\(bucket.nearbyMatchCount) will instead join existing photos in "
                            + bucket.nearbyMatchFolders.joined(separator: ", ") + ")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("imports.nearbyNote.\(bucket.key)")
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func labelBinding(for bucket: ImportScanBucket) -> Binding<String> {
        Binding(
            get: { form.label(for: bucket.key) },
            set: { form.setLabel($0, for: bucket.key) })
    }
}
