// WorkersStageRow.swift — one stage line in the Workers table.
//
// Two layouts, not one layout that shrinks. The wide form is a metric strip
// — four fixed-width columns plus an icon and a button — which needs more
// horizontal room than an iPhone has. Squeezing it there left nothing for
// the name column, and SwiftUI resolved that by wrapping `exif` to "ex/if",
// the status label to one letter per line, and the button title to
// "Pa/us/e" (#2889). The compact form stacks instead: identity on top,
// metrics inline beneath.
//
// Split from WorkersSettingsView so both files stay well inside the
// 400-line soft budget as #2770 grows the row.

import SwiftUI
import MapleCore

struct WorkersStageRow: View {
    let stage: StageStatus
    /// Nil while a pause/resume for this stage is in flight.
    let onTogglePause: (() -> Void)?
    let isBusy: Bool
    /// Nil when the stage has no dead jobs — the count is the affordance,
    /// so there's nothing to open (#2769).
    var onShowDeadJobs: (() -> Void)?
    /// False while only the registry snapshot has arrived, so the count
    /// columns render as unknown rather than as a confident zero (#2910).
    var counted: Bool = true

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var isCompact: Bool { sizeClass == .compact }
    #else
    private var isCompact: Bool { false }
    #endif

    private var meta: StageMeta { StageCatalog.meta(for: stage.name) }

    var body: some View {
        Group {
            if isCompact {
                compactBody
            } else {
                wideBody
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workers.stage.\(stage.name)")
    }

    // MARK: - Layouts

    /// iPhone. Identity and action share the top line, status sits under
    /// the name, and the metrics run inline as text so a long stage name
    /// like `sidecar-metadata-index` has the full width to wrap across.
    private var compactBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: meta.icon)
                    .foregroundStyle(.secondary)
                Text(stage.name)
                    .font(.system(.callout, design: .monospaced))
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                pauseButton
                    .fixedSize()
            }
            HStack(spacing: 5) {
                statusDot
                Text(StageCatalog.statusLabel(stage.status))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            inlineMetrics
        }
    }

    /// macOS and regular-width iPad: the metric strip.
    private var wideBody: some View {
        HStack(spacing: 10) {
            Image(systemName: meta.icon)
                .frame(width: 18)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 2) {
                Text(stage.name)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                HStack(spacing: 5) {
                    statusDot
                    Text(StageCatalog.statusLabel(stage.status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            // The name owns the slack, so the metric columns can't crowd it
            // out the way they did before #2889.
            .layoutPriority(1)

            Spacer(minLength: 8)

            metric(WorkersSettingsVM.inFlightLabel(stage, counted: counted), caption: "in flight")
            metric(WorkersSettingsVM.pendingLabel(stage, counted: counted), caption: "ready")
                .help(StageCatalog.pendingDetail(stage))
            deadMetric
            metric(WorkersSettingsVM.throughputLabel(stage.throughput), caption: "rate")

            pauseButton
        }
    }

    // MARK: - Pieces

    private var statusDot: some View {
        Circle()
            .fill(toneColor)
            .frame(width: 7, height: 7)
    }

    private var pauseButton: some View {
        Button(WorkersSettingsVM.pauseActionLabel(stage.status)) {
            onTogglePause?()
        }
        // .borderless is what stops a List row from routing every tap in
        // the card to this button — the default style made the whole row a
        // Pause target, including the areas that read as plain data (#2910).
        .buttonStyle(.borderless)
        .controlSize(.small)
        .lineLimit(1)
        .disabled(onTogglePause == nil || isBusy)
        .accessibilityIdentifier("workers.toggle.\(stage.name)")
    }

    /// Compact metrics as one wrapping line — "0 / 8 in flight · 9 ready ·
    /// 1 dead · 12 /min". Dead stays tappable when there is something to
    /// open, so the drawer from #2769 is still reachable on iPhone.
    private var inlineMetrics: some View {
        HStack(spacing: 6) {
            Text(WorkersSettingsVM.inFlightLabel(stage, counted: counted) + " in flight")
            Text("·")
            Text(WorkersSettingsVM.pendingLabel(stage, counted: counted) + " ready")
            Text("·")
            if let onShowDeadJobs {
                Button(action: onShowDeadJobs) {
                    Text(WorkersSettingsVM.deadLabel(stage, counted: counted) + " dead")
                        .foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("workers.dead.\(stage.name)")
            } else {
                Text(WorkersSettingsVM.deadLabel(stage, counted: counted) + " dead")
            }
            Text("·")
            Text(WorkersSettingsVM.throughputLabel(stage.throughput))
            Spacer(minLength: 0)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }

    @ViewBuilder
    private var deadMetric: some View {
        if let onShowDeadJobs {
            Button(action: onShowDeadJobs) {
                metric(WorkersSettingsVM.deadLabel(stage, counted: counted), caption: "dead")
                    .foregroundStyle(.red)
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("workers.dead.\(stage.name)")
            .help("Show the failed jobs for this stage")
        } else {
            metric(WorkersSettingsVM.deadLabel(stage, counted: counted), caption: "dead")
        }
    }

    private var toneColor: Color {
        switch WorkersSettingsVM.statusTone(stage.status) {
        case .active: return .green
        case .idle: return .secondary
        case .fault: return .red
        }
    }

    @ViewBuilder
    private func metric(_ value: String, caption: String) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(value)
                .font(.system(.callout, design: .monospaced))
                .lineLimit(1)
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .fixedSize(horizontal: true, vertical: false)
    }
}
