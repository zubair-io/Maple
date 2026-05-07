// CloudServerSection.swift
//
// One sidebar section per connected cloud server: collapsible header with
// a Timeline | Folder segmented control on the right, and a list of
// libraries (folders) underneath. Clicking a library row sets the
// LibrarySelection to .cloudLibrary(serverID, folderID) and fires the
// onPickLibrary callback.

import SwiftUI
import MapleCore

struct CloudServerSection: View {
  let serverURL: URL
  let folders: [CloudFolder]
  let viewMode: CloudViewMode
  @Binding var isExpanded: Bool
  @Binding var selection: LibrarySelection
  let onSetViewMode: (CloudViewMode) -> Void
  let onPickLibrary: (URL, String) -> Void
  let onSignOut: () -> Void
  let onRemoveServer: () -> Void

  var body: some View {
    DisclosureGroup(isExpanded: $isExpanded) {
      ForEach(folders) { folder in
        Button {
          selection = .cloudLibrary(serverID: serverURL, folderID: folder.id)
          onPickLibrary(serverURL, folder.id)
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "folder.fill")
              .foregroundStyle(.secondary)
            Text(folder.displayName)
              .lineLimit(1)
            Spacer()
            if folder.file_count > 0 {
              Text("\(folder.file_count)")
                .foregroundStyle(.tertiary)
                .font(.caption.monospacedDigit())
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
          isSelected(folder)
          ? Color.accentColor.opacity(0.18)
          : .clear,
          in: RoundedRectangle(cornerRadius: 6)
        )
      }
    } label: {
      HStack {
        Text(serverURL.host ?? serverURL.absoluteString)
          .font(.headline)
          .lineLimit(1)
        Spacer()
        Picker("", selection: Binding(
          get: { viewMode },
          set: onSetViewMode
        )) {
          Image(systemName: "calendar").tag(CloudViewMode.timeline)
          Image(systemName: "folder").tag(CloudViewMode.folder)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 80)
      }
      .contextMenu {
        Button("Sign out", action: onSignOut)
        Button("Remove server", role: .destructive, action: onRemoveServer)
      }
    }
  }

  private func isSelected(_ folder: CloudFolder) -> Bool {
    if case .cloudLibrary(let s, let f) = selection {
      return s == serverURL && f == folder.id
    }
    return false
  }
}
