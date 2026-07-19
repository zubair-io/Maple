// src/apple/Maple TV/LibraryPickerScreen.swift
import MapleCloudKit
import SwiftUI

/// Shown when `TVCloudSession.resolveLibraries()` returns `.many` — the
/// connected server has more than one registered library and no
/// previously-selected one is still valid. A focus-navigable list; picking
/// a row calls `session.select(_:)`, which persists the choice via
/// `CloudServerRegistry` so this screen doesn't reappear next launch.
struct LibraryPickerScreen: View {
  let session: TVCloudSession
  let folders: [CloudFolder]

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 32) {
        Text("Choose a library")
          .font(.system(size: 40, weight: .semibold))
          .foregroundStyle(MapleTVTheme.textPrimary)
          .accessibilityAddTraits(.isHeader)

        ScrollView {
          VStack(spacing: 20) {
            ForEach(folders) { folder in
              LibraryRow(folder: folder) { session.select(folder) }
            }
          }
        }
      }
      .padding(72)
    }
  }
}

private struct LibraryRow: View {
  let folder: CloudFolder
  let onSelect: () -> Void

  private var subtitle: String {
    let count = folder.file_count
    return count == 1 ? "1 photo" : "\(count) photos"
  }

  var body: some View {
    Button(action: onSelect) {
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          Text(folder.displayName)
            .font(.system(size: 26, weight: .medium))
            .foregroundStyle(MapleTVTheme.textPrimary)
          Text(subtitle)
            .font(.system(size: 18))
            .foregroundStyle(MapleTVTheme.textMuted)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .foregroundStyle(MapleTVTheme.textMuted)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, 28)
      .padding(.vertical, 20)
      .frame(maxWidth: .infinity)
      .background(MapleTVTheme.surface)
      .clipShape(RoundedRectangle(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16)
          .stroke(MapleTVTheme.border, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(folder.displayName), \(subtitle)")
  }
}
