// MoleculesL2FormGallery.swift — Molecules L2 tab, catalog §3 form/shell
// group: Dialog, Settings Row, Embed Shell, Endpoint Form, Response
// Viewer. Dialog is pinned open via `isPresented: true`, the same "static
// grid, panel pinned open" convention MoleculesL1OverlaysMenusGallery uses
// for Popover/Context Menu/Suggestion Menu/Command Menu.

import SwiftUI

extension MoleculesL2GallerySection {
    var dialogCard: some View {
        GallerySpecimenCard(name: "Dialog", purpose: "Prompt, confirm, or choice", builtFrom: "Popover, Text, Input, Button") {
            ZStack {
                MuiDialog(isPresented: true, title: "Delete 3 photos?", message: "This can't be undone.", confirmLabel: "Delete", destructive: true)
            }
            .frame(height: 160)
        }
    }

    var settingsRowCard: some View {
        GallerySpecimenCard(name: "Settings Row", purpose: "Collapsible labeled setting", builtFrom: "Collapsible, Icon, Text, Divider") {
            VStack(spacing: 0) {
                MuiSettingsRow(label: "Denoise", icon: "wand.and.stars", description: "Reduce sensor noise on import.", open: .constant(true)) {
                    MuiText("Strength: Medium", variant: .body, color: .muted)
                }
                MuiSettingsRow(label: "Backups", icon: "externaldrive", open: .constant(false), showDivider: false)
            }
        }
    }

    var embedShellCard: some View {
        GallerySpecimenCard(name: "Embed Shell", purpose: "Frame for embedded content", builtFrom: "Page Header, Progress, Icon") {
            MuiEmbedShell(title: "Live view", statusIcon: "dot.radiowaves.left.and.right", statusLabel: "Connected") {
                MuiText("Embedded content", variant: .body, color: .muted)
            }
        }
    }

    var endpointFormCard: some View {
        GallerySpecimenCard(name: "Endpoint Form", purpose: "Interactive request builder", builtFrom: "Form Field, Button, Badge") {
            MuiEndpointForm(method: .constant("GET"), url: .constant("/api/photos"))
        }
    }

    var responseViewerCard: some View {
        GallerySpecimenCard(name: "Response Viewer", purpose: "Formatted response with status", builtFrom: "Code Block, Badge, Tabs") {
            MuiResponseViewer(status: 200, statusText: "OK", body: "{\n  \"id\": \"IMG_0042\"\n}", headers: "content-type: application/json", activeId: .constant("body"))
        }
    }
}
