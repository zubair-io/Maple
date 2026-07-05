// SearchFilterPanel.swift
//
// The full filter surface for cloud search — popover content presented
// from CloudSearchView's "filters" button. Mirrors the web search filter
// sidebar: rating, flag, color, camera/lens, scene/activity, screenshot,
// subjects, extensions, and ISO / aperture / focal / date ranges.
//
// Discrete controls (stars, chips, menus) re-run the search immediately on
// change. Free-text numeric / date fields apply on commit (Return) and on
// panel dismiss, so a typed-but-not-submitted value still lands.

import SwiftUI
import MapleCore

struct SearchFilterPanel: View {
  @Bindable var vm: SearchViewModel

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(MapleTokens.border)
      ScrollView {
        VStack(alignment: .leading, spacing: MapleTokens.Spacing.sectionGap) {
          // Grouped to stay within the @ViewBuilder 10-subview limit.
          Group {
            ratingSection
            flagSection
            colorSection
            cameraSection
            lensSection
            sceneSection
            activitySection
          }
          Group {
            screenshotSection
            hiddenSection
            subjectsSection
            extensionsSection
            rangeSection(title: "ISO",
                         min: intBinding(\.isoMin), max: intBinding(\.isoMax))
            rangeSection(title: "Aperture (f)",
                         min: doubleBinding(\.apertureMin), max: doubleBinding(\.apertureMax))
            rangeSection(title: "Focal length (mm)",
                         min: doubleBinding(\.focalMin), max: doubleBinding(\.focalMax))
            dateSection
          }
        }
        .padding(MapleTokens.Spacing.panelInset)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(MapleTokens.surface)
    // Apply any typed-but-not-committed text fields when the panel closes —
    // but only if something actually changed, so closing an untouched panel
    // doesn't fire a redundant search + facets round-trip.
    .onDisappear { Task { await vm.submitIfChanged() } }
  }

  // MARK: - Header

  private var header: some View {
    HStack {
      Text("Filters")
        .font(MapleTokens.Typography.sheetTitle)
        .foregroundStyle(MapleTokens.textMain)
      Spacer()
      if vm.hasActiveFilters {
        Button("Clear all") { vm.clearFilters() }
          .font(MapleTokens.Typography.body)
          .buttonStyle(.plain)
          .foregroundStyle(MapleTokens.primary)
          .accessibilityIdentifier("search-clear-filters")
      }
    }
    .padding(.horizontal, MapleTokens.Spacing.panelInset)
    .padding(.vertical, 10)
  }

  // MARK: - Rating

  private var ratingSection: some View {
    section("Rating") {
      HStack(spacing: 4) {
        ForEach(1...5, id: \.self) { star in
          Button {
            // Tapping the active threshold clears it; otherwise set it.
            vm.params.rating = (vm.params.rating == star) ? nil : star
            Task { await vm.submit() }
          } label: {
            Image(systemName: (vm.params.rating ?? 0) >= star ? "star.fill" : "star")
              .foregroundStyle((vm.params.rating ?? 0) >= star
                               ? MapleTokens.star : MapleTokens.textMuted)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(star) star\(star == 1 ? "" : "s") and up")
        }
        if vm.params.rating != nil {
          Text("& up")
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.textMuted)
        }
      }
    }
  }

  // MARK: - Flag

  private var flagSection: some View {
    section("Flag") {
      HStack(spacing: 6) {
        chip("Any", selected: vm.params.flag == nil) {
          vm.params.flag = nil; Task { await vm.submit() }
        }
        ForEach(SearchFlag.allCases, id: \.self) { flag in
          chip(flag.label, selected: vm.params.flag == flag) {
            vm.params.flag = flag; Task { await vm.submit() }
          }
        }
      }
    }
  }

  // MARK: - Color

  private var colorSection: some View {
    section("Color label") {
      HStack(spacing: 8) {
        // "Any" — hollow circle.
        Button {
          vm.params.color = nil; Task { await vm.submit() }
        } label: {
          Circle()
            .strokeBorder(MapleTokens.textMuted, lineWidth: 1.5)
            .frame(width: 22, height: 22)
            .overlay {
              if vm.params.color == nil {
                Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                  .foregroundStyle(MapleTokens.textMain)
              }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Any color")

        ForEach(SearchColor.allCases, id: \.self) { color in
          Button {
            vm.params.color = (vm.params.color == color) ? nil : color
            Task { await vm.submit() }
          } label: {
            Circle()
              .fill(Color(hex: color.swatchHex))
              .frame(width: 22, height: 22)
              .overlay {
                if vm.params.color == color {
                  Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                }
              }
          }
          .buttonStyle(.plain)
          .accessibilityLabel(color.label)
        }
      }
    }
  }

  // MARK: - Camera / Lens / Scene / Activity menus

  private var cameraSection: some View {
    section("Camera") {
      facetMenu(
        current: vm.params.camera,
        options: (vm.facets?.cameras ?? []).compactMap { cam in
          let value = cam.model ?? cam.make
          guard let value, !value.isEmpty else { return nil }
          let label = [cam.make, cam.model].compactMap { $0 }.joined(separator: " ")
          return MenuOption(label: "\(label.isEmpty ? value : label) (\(cam.count))",
                            value: value)
        },
        onPick: { vm.params.camera = $0; Task { await vm.submit() } })
    }
  }

  private var lensSection: some View {
    section("Lens") {
      facetMenu(
        current: vm.params.lens,
        options: valueOptions(vm.facets?.lenses),
        onPick: { vm.params.lens = $0; Task { await vm.submit() } })
    }
  }

  private var sceneSection: some View {
    section("Scene type") {
      Menu {
        Button { vm.params.sceneType = nil; Task { await vm.submit() } } label: {
          menuRow("Any", selected: vm.params.sceneType == nil)
        }
        ForEach(SearchSceneType.allCases, id: \.self) { scene in
          let count = facetCount(vm.facets?.scene_types, scene.rawValue)
          Button { vm.params.sceneType = scene; Task { await vm.submit() } } label: {
            menuRow("\(scene.label)\(count.map { " (\($0))" } ?? "")",
                    selected: vm.params.sceneType == scene)
          }
        }
      } label: {
        menuLabel(vm.params.sceneType?.label ?? "Any")
      }
    }
  }

  private var activitySection: some View {
    section("Activity") {
      facetMenu(
        current: vm.params.activity,
        options: valueOptions(vm.facets?.activities),
        onPick: { vm.params.activity = $0; Task { await vm.submit() } })
    }
  }

  // MARK: - Screenshot

  private var screenshotSection: some View {
    section("Type") {
      HStack(spacing: 6) {
        chip("Any", selected: vm.params.isScreenshot == nil) {
          vm.params.isScreenshot = nil; Task { await vm.submit() }
        }
        chip("Photos", selected: vm.params.isScreenshot == false) {
          vm.params.isScreenshot = false; Task { await vm.submit() }
        }
        chip("Screenshots", selected: vm.params.isScreenshot == true) {
          vm.params.isScreenshot = true; Task { await vm.submit() }
        }
      }
    }
  }

  // MARK: - Hidden

  private var hiddenSection: some View {
    section("Hidden") {
      HStack(spacing: 6) {
        ForEach(SearchHidden.allCases, id: \.self) { opt in
          chip(opt.label, selected: vm.params.hidden == opt) {
            vm.params.hidden = opt; Task { await vm.submit() }
          }
        }
      }
    }
  }

  // MARK: - Subjects / Extensions (multi-select chips)

  private var subjectsSection: some View {
    let options = (vm.facets?.subjects ?? []).compactMap { $0.value }
    return Group {
      if options.isEmpty {
        EmptyView()
      } else {
        section("Subjects") {
          chipGrid(options, isOn: { vm.params.subjects.contains($0) }) { value in
            toggle(&vm.params.subjects, value); Task { await vm.submit() }
          }
        }
      }
    }
  }

  private var extensionsSection: some View {
    let options = (vm.facets?.extensions ?? []).compactMap { $0.value }
    return Group {
      if options.isEmpty {
        EmptyView()
      } else {
        section("File type") {
          chipGrid(options.map { $0.uppercased() },
                   isOn: { vm.params.ext.contains($0.lowercased()) }) { value in
            toggle(&vm.params.ext, value.lowercased()); Task { await vm.submit() }
          }
        }
      }
    }
  }

  // MARK: - Numeric ranges

  private func rangeSection(title: String,
                            min: Binding<String>,
                            max: Binding<String>) -> some View {
    section(title) {
      HStack(spacing: 8) {
        rangeField("Min", text: min)
        Text("–").foregroundStyle(MapleTokens.textMuted)
        rangeField("Max", text: max)
      }
    }
  }

  private func rangeField(_ placeholder: String, text: Binding<String>) -> some View {
    TextField(placeholder, text: text)
      .textFieldStyle(.plain)
      .foregroundStyle(MapleTokens.textMain)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(MapleTokens.inputBg, in: RoundedRectangle(cornerRadius: 4))
      .frame(maxWidth: .infinity)
      .onSubmit { Task { await vm.submit() } }
      #if os(iOS)
      .keyboardType(.numbersAndPunctuation)
      #endif
  }

  // MARK: - Date range

  private var dateSection: some View {
    section("Captured date") {
      HStack(spacing: 8) {
        dateField("From", text: stringBinding(\.from))
        Text("–").foregroundStyle(MapleTokens.textMuted)
        dateField("To", text: stringBinding(\.to))
      }
    }
  }

  private func dateField(_ placeholder: String, text: Binding<String>) -> some View {
    TextField("\(placeholder) (YYYY-MM-DD)", text: text)
      .textFieldStyle(.plain)
      .foregroundStyle(MapleTokens.textMain)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(MapleTokens.inputBg, in: RoundedRectangle(cornerRadius: 4))
      .frame(maxWidth: .infinity)
      .onSubmit { Task { await vm.submit() } }
  }

  // MARK: - Reusable building blocks

  @ViewBuilder
  private func section<Content: View>(_ title: String,
                                      @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased())
        .font(MapleTokens.Typography.eyebrow)
        .foregroundStyle(MapleTokens.textMuted)
      content()
    }
  }

  private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(label)
        .font(MapleTokens.Typography.body)
        .foregroundStyle(selected ? .white : MapleTokens.textMain)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(selected ? MapleTokens.primary : MapleTokens.surfaceAlt,
                    in: Capsule())
    }
    .buttonStyle(.plain)
  }

  private func chipGrid(_ options: [String],
                        isOn: @escaping (String) -> Bool,
                        toggle: @escaping (String) -> Void) -> some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 6)],
              alignment: .leading, spacing: 6) {
      ForEach(options, id: \.self) { option in
        chip(option, selected: isOn(option)) { toggle(option) }
      }
    }
  }

  // MARK: - Facet menu helpers

  private struct MenuOption: Identifiable {
    let label: String
    let value: String
    var id: String { value }
  }

  private func valueOptions(_ facets: [ValueFacet]?) -> [MenuOption] {
    (facets ?? []).compactMap { facet in
      guard let value = facet.value, !value.isEmpty else { return nil }
      return MenuOption(label: "\(value) (\(facet.count))", value: value)
    }
  }

  private func facetCount(_ facets: [ValueFacet]?, _ value: String) -> Int? {
    facets?.first { $0.value == value }?.count
  }

  @ViewBuilder
  private func facetMenu(current: String?,
                         options: [MenuOption],
                         onPick: @escaping (String?) -> Void) -> some View {
    Menu {
      Button { onPick(nil) } label: {
        menuRow("Any", selected: current == nil)
      }
      ForEach(options) { option in
        Button { onPick(option.value) } label: {
          menuRow(option.label, selected: current == option.value)
        }
      }
    } label: {
      menuLabel(current ?? "Any")
    }
    .disabled(options.isEmpty)
  }

  @ViewBuilder
  private func menuRow(_ label: String, selected: Bool) -> some View {
    if selected { Label(label, systemImage: "checkmark") } else { Text(label) }
  }

  private func menuLabel(_ text: String) -> some View {
    HStack {
      Text(text)
        .font(MapleTokens.Typography.rowLabel)
        .foregroundStyle(MapleTokens.textMain)
        .lineLimit(1)
      Spacer()
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 11))
        .foregroundStyle(MapleTokens.textMuted)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(MapleTokens.inputBg, in: RoundedRectangle(cornerRadius: 4))
  }

  // MARK: - Binding helpers

  private func toggle(_ array: inout [String], _ value: String) {
    if let idx = array.firstIndex(of: value) { array.remove(at: idx) }
    else { array.append(value) }
  }

  private func intBinding(_ keyPath: WritableKeyPath<SearchParams, Int?>) -> Binding<String> {
    Binding(
      get: { vm.params[keyPath: keyPath].map(String.init) ?? "" },
      set: { newValue in
        let trimmed = newValue.trimmingCharacters(in: .whitespaces)
        vm.params[keyPath: keyPath] = trimmed.isEmpty ? nil : Int(trimmed)
      })
  }

  private func doubleBinding(_ keyPath: WritableKeyPath<SearchParams, Double?>) -> Binding<String> {
    Binding(
      get: { vm.params[keyPath: keyPath].map { String($0) } ?? "" },
      set: { newValue in
        let trimmed = newValue.trimmingCharacters(in: .whitespaces)
        vm.params[keyPath: keyPath] = trimmed.isEmpty ? nil : Double(trimmed)
      })
  }

  private func stringBinding(_ keyPath: WritableKeyPath<SearchParams, String?>) -> Binding<String> {
    Binding(
      get: { vm.params[keyPath: keyPath] ?? "" },
      set: { newValue in
        let trimmed = newValue.trimmingCharacters(in: .whitespaces)
        vm.params[keyPath: keyPath] = trimmed.isEmpty ? nil : trimmed
      })
  }
}

// MARK: - Preview

#Preview("Filters") {
  SearchFilterPanel(vm: SearchViewModel.preview(.loaded))
    .frame(width: 340, height: 540)
}
