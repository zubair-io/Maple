// MuiStructuredDataEditor.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). A flat key/value object (string/
// number/boolean leaves only — no nesting, v1 scope) editable either as
// raw JSON or as a generated form, built from Code Block, Form Field, Tabs.
//
// The Code tab uses a plain `TextEditor` rather than `MuiCodeBlock` — that
// molecule is read-only (a display box with a copy button), and there's no
// editable code-block atom to reuse, same gap the web reference notes.

import SwiftUI

public struct MuiStructuredDataEditor: View {
    @Binding public var fields: [MuiStructuredDataField]
    public let parseErrorChanged: ((String?) -> Void)?

    @State private var viewMode = "code"
    @State private var codeText: String
    @State private var error: String?

    private static let tabs = [MuiTab(id: "code", label: "Code"), MuiTab(id: "form", label: "Form")]

    public init(fields: Binding<[MuiStructuredDataField]>, parseErrorChanged: ((String?) -> Void)? = nil) {
        self._fields = fields
        self.parseErrorChanged = parseErrorChanged
        self._codeText = State(initialValue: MuiStructuredDataMath.jsonText(from: fields.wrappedValue))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiTabs(tabs: Self.tabs, activeId: $viewMode)

            if viewMode == "code" {
                codeEditor
            } else {
                formEditor
            }

            if let error {
                MuiText(error, variant: .body, color: .error, block: true)
            }
        }
        .onChange(of: fields) { _, next in
            guard error == nil else { return }
            codeText = MuiStructuredDataMath.jsonText(from: next)
        }
    }

    private var codeEditor: some View {
        TextEditor(text: $codeText)
            .scrollContentBackground(.hidden)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(MuiTokens.textMain)
            .frame(minHeight: 140)
            .padding(MuiTokens.spacingSm)
            .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
            .onChange(of: codeText) { _, newValue in
                switch MuiStructuredDataMath.parseFields(from: newValue) {
                case .success(let parsed):
                    error = nil
                    fields = parsed
                    parseErrorChanged?(nil)
                case .failure(let parseError):
                    error = parseError.message
                    parseErrorChanged?(parseError.message)
                }
            }
    }

    private var formEditor: some View {
        VStack(spacing: MuiTokens.spacingSm) {
            ForEach(fields) { field in
                MuiFormField(
                    label: field.key,
                    value: Binding(
                        get: { field.value.displayString },
                        set: { commitField(key: field.key, raw: $0) }
                    )
                )
            }
        }
    }

    private func commitField(key: String, raw: String) {
        guard let idx = fields.firstIndex(where: { $0.key == key }) else { return }
        fields[idx] = MuiStructuredDataField(key: key, value: MuiStructuredDataMath.coerceLike(fields[idx].value, raw: raw))
    }
}

#Preview("MuiStructuredDataEditor") {
    struct Demo: View {
        @State private var fields: [MuiStructuredDataField] = [
            MuiStructuredDataField(key: "camera", value: .string("Sony A7 IV")),
            MuiStructuredDataField(key: "iso", value: .number(400)),
            MuiStructuredDataField(key: "flagged", value: .bool(false)),
        ]
        var body: some View {
            MuiStructuredDataEditor(fields: $fields)
                .frame(width: 320)
                .padding()
                .background(MuiTokens.bg)
        }
    }
    return Demo()
}
