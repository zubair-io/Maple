import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }
  func applicationWillTerminate(_ notification: Notification) { ResearchProcess.shared.cancel() }
}

@main struct RemovalLabApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
  @State private var state = LabState()
  var body: some Scene {
    Window("Maple Removal Lab", id: "removal-lab") {
      LabView(state: state)
        .frame(minWidth: 1050, minHeight: 720)
        .onDisappear { state.cancel() }
        .task {
          let arguments = ProcessInfo.processInfo.arguments
          if let index = arguments.firstIndex(of: "--session"),
            arguments.indices.contains(index + 1), state.photo == nil
          {
            state.reopen(URL(fileURLWithPath: arguments[index + 1]))
          } else if let index = arguments.firstIndex(of: "--raw"),
            arguments.indices.contains(index + 1),
            state.photo == nil
          {
            state.open(URL(fileURLWithPath: arguments[index + 1]))
          }
        }
    }
    .defaultSize(width: 1400, height: 920)
    .commands {
      CommandGroup(replacing: .newItem) {
        Button("Open RAW…") { state.choosePhoto() }.keyboardShortcut("o").disabled(state.busy)
      }
    }
  }
}

struct LabView: View {
  @Environment(\.displayScale) private var displayScale
  @Bindable var state: LabState
  var body: some View {
    HStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text("Removal Lab").font(.title2.bold())
          Text("LaMa + Qwen · Guided texture transfer").font(.caption).foregroundStyle(.secondary)
          Button("Open RAW…") { state.choosePhoto() }.disabled(state.busy)
          Button("Open saved session…") { state.chooseSession() }.disabled(state.busy)
          if let photo = state.photo {
            Text(URL(fileURLWithPath: photo.raw).lastPathComponent).font(.headline).textSelection(
              .enabled)
            Text("\(photo.displayWidth) × \(photo.displayHeight) native pixels").font(.caption)
          }
          Divider()
          Picker("Brush", selection: $state.brush) {
            Text("Remove").tag("remove")
            Text("Erase").tag("erase")
            Text("Protect").tag("protect")
          }.pickerStyle(.segmented).disabled(state.busy || state.showResults)
          Text("Brush size").font(.caption)
          Slider(value: $state.radius, in: 0.001...0.05).accessibilityLabel("Brush size").disabled(
            state.busy || state.showResults)
          HStack {
            Button("Undo") { state.undo() }.disabled(
              state.strokes.isEmpty || state.busy || state.showResults)
            Button("Redo") { state.redoStroke() }.disabled(
              state.redo.isEmpty || state.busy || state.showResults)
            Button("Clear") {
              state.strokes = []
              state.redo = []
            }.disabled(state.busy || state.showResults)
          }
          Text(
            "Red removes · Green protects\nPaint over the object and its shadow. A small margin is added automatically."
          ).font(.caption).foregroundStyle(.secondary)
          Text("Qwen description").font(.caption.bold())
          TextEditor(text: $state.prompt).frame(height: 105).border(.quaternary).disabled(
            state.busy
          ).accessibilityLabel("Qwen description")
          Button("Generate both candidates") { state.generate() }
            .buttonStyle(.borderedProminent).disabled(
              !state.canGenerate
                || state.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          if state.busy {
            HStack {
              ProgressView().controlSize(.small)
              Button("Cancel generation") { state.cancel() }
            }
          }
          Text(state.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled).accessibilityIdentifier("research-status")
          if !state.candidates.isEmpty {
            Button(state.showResults ? "Back to selection" : "Review candidates") {
              state.showResults.toggle()
              state.actualSize = false
            }
            Divider()
            reviewControls
          }
          ForEach(Array(state.failures.enumerated()), id: \.offset) { _, failure in
            DisclosureGroup("\(failure.model.capitalized) failed") {
              Text(failure.message).font(.caption).textSelection(.enabled)
            }
          }
          Button("Show session files") { state.reveal() }.disabled(state.sourceFolder == nil)
          Text(
            "Research app · Opens the unedited RAW. Preferences and results stay in research sessions; your RAW and existing edits are untouched."
          ).font(.caption).foregroundStyle(.secondary)
          Text(
            "Keyboard painting: focus the canvas, use arrows to move, Space to start/finish, Return for a dot. Shift moves faster."
          ).font(.caption).foregroundStyle(.secondary)
        }.padding(20)
      }.frame(width: 300).background(.regularMaterial)
      Divider()
      VStack {
        if state.showResults, !state.candidates.isEmpty {
          results
        } else if let photo = state.photo {
          LoadedImage(path: photo.preview) { image in
            PaintCanvas(
              image: image, strokes: state.strokes, radius: state.radius, mode: state.brush,
              enabled: !state.busy, onStroke: state.addStroke)
          }
        } else {
          VStack(spacing: 12) {
            Text("Open a RAW photo").font(.title2)
            Text("Paint a selection and compare two local removal candidates.")
          }.foregroundStyle(.white)
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(16).background(
        Color.black.opacity(0.85))
    }
  }

  private var reviewControls: some View {
    VStack(alignment: .leading, spacing: 10) {
      Toggle("100% native crop", isOn: $state.actualSize)
      Picker("Candidate", selection: $state.selectedModel) {
        ForEach(state.candidates) { candidate in Text(candidate.label).tag(candidate.id) }
      }.pickerStyle(.segmented)
      Toggle("Show original", isOn: $state.original)
      Picker("Profile", selection: $state.profile) {
        Text("Auto").tag("auto")
        Text("Neutral").tag("neutral")
      }
      Picker("Exposure", selection: $state.exposure) {
        Text("−3 EV").tag(-3)
        Text("Original").tag(0)
        Text("+3 EV").tag(3)
      }
      Picker("White balance", selection: $state.whiteBalance) {
        Text("−1000 K").tag(-1000)
        Text("Original").tag(0)
        Text("+1000 K").tag(1000)
      }
      ForEach(state.candidates) { candidate in
        Button(
          state.preferredModel == candidate.id
            ? "Preferred: \(candidate.label)" : "Prefer \(candidate.label)"
        ) { state.prefer(candidate) }
      }
      Text(
        "Both candidates use the same selection. Preferences are recorded for comparison, not applied to the photo."
      ).font(.caption).foregroundStyle(.secondary)
    }
  }

  @ViewBuilder private var results: some View {
    if state.actualSize,
      let candidate = state.candidates.first(where: { $0.id == state.selectedModel })
    {
      Text("\(state.original ? "Original" : candidate.label) · native pixels · scroll to inspect")
        .foregroundStyle(.white)
      ScrollView([.horizontal, .vertical]) {
        LoadedImage(path: state.imagePath(candidate, before: state.original)) { image in
          Image(nsImage: image).resizable().interpolation(.none).frame(
            width: image.size.width / displayScale, height: image.size.height / displayScale)
        }
      }.id(state.jobFolder)
    } else {
      HStack(alignment: .top, spacing: 12) {
        if let first = state.candidates.first {
          imageCard("Original", path: state.imagePath(first, before: true))
        }
        ForEach(state.candidates) { candidate in
          imageCard(candidate.label, path: state.imagePath(candidate, before: state.original))
        }
      }
    }
  }

  private func imageCard(_ label: String, path: String) -> some View {
    VStack {
      Text(label).font(.headline).foregroundStyle(.white)
      LoadedImage(path: path) { image in
        Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
      }
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct LoadedImage<Content: View>: View {
  let path: String
  @ViewBuilder let content: (NSImage) -> Content
  @State private var image: NSImage?
  @State private var error: String?
  var body: some View {
    Group {
      if let image {
        content(image)
      } else if let error {
        Text(error).foregroundStyle(.white)
      } else {
        ProgressView()
      }
    }.task(id: path) {
      image = nil
      error = nil
      do {
        let data = try await ResearchDisk().data(path)
        try Task.checkCancellation()
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let raw = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let tagged = raw.copy(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        else {
          throw NSError(
            domain: "RemovalLab", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Cannot load result image."])
        }
        image = NSImage(cgImage: tagged, size: NSSize(width: tagged.width, height: tagged.height))
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
  }
}
