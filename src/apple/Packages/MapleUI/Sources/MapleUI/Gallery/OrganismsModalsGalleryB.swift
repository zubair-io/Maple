// OrganismsModalsGalleryB.swift — Organisms §4.4 (Modals), remaining six:
// Add Server, Pair Device, Share, Template Gallery, Card Detail, Result
// Report. See OrganismsGallerySection.swift for the tab this feeds into,
// and OrganismsModalsGalleryA.swift for the first seven.

import SwiftUI

struct OrganismsModalsGalleryB: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            GallerySpecimenCard(name: "Add Server", purpose: "Sign-in and registration", builtFrom: "Form Field, Button, Banner") { AddServerModalDemo() }
            GallerySpecimenCard(name: "Pair Device", purpose: "Multi-step pairing flow", builtFrom: "QR Code, QR Scanner, Progress, Progress Step") { PairDeviceModalDemo() }
            GallerySpecimenCard(name: "Share", purpose: "Manage members and access", builtFrom: "Avatar Group, Form Field, List Row") { ShareModalDemo() }
            GallerySpecimenCard(name: "Template Gallery", purpose: "Browse and apply templates", builtFrom: "Card, Search Bar, Empty State") { TemplateGalleryModalDemo() }
            GallerySpecimenCard(name: "Card Detail", purpose: "Expanded board-card editor", builtFrom: "Form Field, Chip Row, Rich Text Editor") { CardDetailModalDemo() }
            GallerySpecimenCard(name: "Result Report", purpose: "Per-item batch outcome", builtFrom: "List Row, Badge, Empty State") { ResultReportModalDemo() }
        }
    }
}

private struct AddServerModalDemo: View {
    @State private var open = false
    @State private var host = ""
    @State private var username = ""
    @State private var password = ""
    var body: some View {
        ZStack {
            MuiButton(label: "Open Add Server", variant: .secondary) { open = true }
            MuiAddServerModal(isPresented: open, contained: true, host: $host, username: $username, password: $password, dismissed: { open = false })
        }
        .frame(height: 260)
    }
}

private struct PairDeviceModalDemo: View {
    @State private var open = false
    @State private var step = 0
    var body: some View {
        ZStack {
            MuiButton(label: "Open Pair Device", variant: .secondary) { open = true }
            MuiPairDeviceModal(
                isPresented: open, contained: true, step: step, pairingCode: "MAPLE-7XQ2",
                stepChanged: { step = $0 }, dismissed: { open = false }
            )
        }
        .frame(height: 340)
    }
}

private struct ShareModalDemo: View {
    @State private var open = false
    @State private var invite = ""
    var body: some View {
        ZStack {
            MuiButton(label: "Open Share", variant: .secondary) { open = true }
            MuiShareModal(
                isPresented: open, contained: true,
                members: [MuiShareMember(id: "1", name: "Ada Lovelace", role: "Editor")],
                inviteValue: $invite, dismissed: { open = false }
            )
        }
        .frame(height: 300)
    }
}

private struct TemplateGalleryModalDemo: View {
    @State private var open = false
    @State private var search = ""
    var body: some View {
        ZStack {
            MuiButton(label: "Open Template Gallery", variant: .secondary) { open = true }
            MuiTemplateGalleryModal(
                isPresented: open, contained: true,
                templates: [
                    MuiGalleryTemplate(id: "1", name: "Moody Landscape", thumbnailUrl: nil, category: "Landscape"),
                    MuiGalleryTemplate(id: "2", name: "Portrait Warm", thumbnailUrl: nil, category: "Portrait"),
                ],
                search: $search, dismissed: { open = false }
            )
        }
        .frame(height: 320)
    }
}

private struct CardDetailModalDemo: View {
    @State private var open = false
    @State private var title = "Retouch hero shot"
    @State private var priority: String? = "high"
    @State private var bodyText = "Client wants the sky punchier."
    var body: some View {
        ZStack {
            MuiButton(label: "Open Card Detail", variant: .secondary) { open = true }
            MuiCardDetailModal(
                isPresented: open, contained: true, title: $title,
                selectedPriority: $priority, bodyText: $bodyText, dismissed: { open = false }
            )
        }
        .frame(height: 360)
    }
}

private struct ResultReportModalDemo: View {
    @State private var open = false
    var body: some View {
        ZStack {
            MuiButton(label: "Open Result Report", variant: .secondary) { open = true }
            MuiResultReportModal(
                isPresented: open, contained: true,
                results: [
                    MuiResultItem(id: "1", label: "IMG_0042.dng", status: .success),
                    MuiResultItem(id: "2", label: "IMG_0043.dng", status: .error, detail: "Disk full"),
                ],
                dismissed: { open = false }
            )
        }
        .frame(height: 300)
    }
}
