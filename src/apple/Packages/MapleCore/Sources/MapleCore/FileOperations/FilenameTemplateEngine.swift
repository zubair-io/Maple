// FilenameTemplateEngine.swift — Swift wrapper over the shared `raw-core`
// filename-template engine (`maple_render_filename_template`, #2628),
// issue #2641 (Apple batch-rename sheet).
//
// This is the ONE piece of the File Management epic that IS shared code
// (docs/superpowers/specs/2026-08-04-file-management-design.md § "Core
// architecture"): the same `raw_core::filename` module backs Apple (this
// file, via the RawPipeline xcframework's C-FFI), Windows (P/Invoke over the
// identical C ABI), and Web/the Self Hosted API (`raw-wasm`). A template
// like `"{date:%Y%m%d}_{original}_{n}.{ext}"` renders byte-identically on
// every surface because there is exactly one implementation of the token
// grammar, not three hand-written parsers that could drift.
//
// Tokens: `{original}` (source stem, no extension), `{n}` (sequence number),
// `{date:FORMAT}` (EXIF `DateTimeOriginal`, strftime-style), `{ext}` (source
// extension, no leading dot), and literal text for everything else — see
// `raw_core::filename` module doc for the exact grammar and validation
// rules (Windows' reserved-name / trailing-dot-or-space rules are enforced
// on every platform, deliberately, since a template is typically authored
// once and reused on a library that may later be opened on any OS).

import Foundation
import RawPipeline

// MARK: - FilenameTemplateError

/// Mirrors `maple_render_filename_template`'s documented `error_code`
/// values 1-9 (an FFI-level `-1` for a bad input pointer never reaches
/// Swift — `render` guards every string with `withCString` before the call,
/// so it can't happen here).
public enum FilenameTemplateError: Error, LocalizedError, Equatable {
    case unterminatedToken
    case unknownToken
    case emptyResult
    case pathSeparator
    case leadingDot
    case trailingDotOrSpace
    case reservedName
    case sequencePadWidthTooLarge
    case renderedNameTooLong
    case unknown(Int32)

    init(code: Int32) {
        switch code {
        case 1: self = .unterminatedToken
        case 2: self = .unknownToken
        case 3: self = .emptyResult
        case 4: self = .pathSeparator
        case 5: self = .leadingDot
        case 6: self = .trailingDotOrSpace
        case 7: self = .reservedName
        case 8: self = .sequencePadWidthTooLarge
        case 9: self = .renderedNameTooLong
        default: self = .unknown(code)
        }
    }

    public var errorDescription: String? {
        switch self {
        case .unterminatedToken: return "Template has an unterminated \"{\"."
        case .unknownToken: return "Template contains an unrecognized {…} token."
        case .emptyResult: return "The rendered filename is empty."
        case .pathSeparator: return "The rendered filename contains a path separator."
        case .leadingDot: return "The rendered filename can't start with a dot."
        case .trailingDotOrSpace: return "The rendered filename can't end with a dot or space."
        case .reservedName: return "The rendered filename is a reserved device name (like CON or COM1)."
        case .sequencePadWidthTooLarge: return "Sequence padding width is too large."
        case .renderedNameTooLong: return "The rendered filename is too long."
        case .unknown(let code): return "Template render failed (code \(code))."
        }
    }
}

// MARK: - FilenameTemplateEngine

public enum FilenameTemplateEngine {

    /// Render one filename from a batch-rename `template` for one file.
    ///
    /// - Parameters:
    ///   - capturedAtExifString: EXIF `DateTimeOriginal` verbatim in its
    ///     `"YYYY:MM:DD HH:MM:SS"` wire format — see
    ///     `ImageMetadataReader.readRawCaptureDateStrings`. `nil` when
    ///     unavailable (or unparseable): the engine renders every
    ///     `{date:FORMAT}` token as its documented fallback text rather than
    ///     failing the whole call, so a mixed folder (some files with EXIF
    ///     dates, some without) still produces a name for every file.
    ///   - sequenceStart: the value `{n}` takes for `sequenceIndex == 0`.
    ///     Plain `Int` because it's UI-typed (a `TextField(value:)` can hand
    ///     back a negative number) — clamped to `0` here, at the FFI
    ///     boundary, before it ever reaches the `UInt64` the C ABI expects.
    ///     `UInt64(negative)` traps unconditionally, so this clamp is not
    ///     optional defense-in-depth; it is what keeps a stray "-1" in the
    ///     sheet's sequence-start field from crashing the app instead of
    ///     just rendering `{n}` as if the field had read `0`.
    ///   - sequenceIndex: zero-based position of this file within its batch
    ///     — combined with `sequenceStart` to produce `{n}`'s value
    ///     (`sequenceStart + sequenceIndex`). Always caller-controlled (a
    ///     loop index), never UI-typed, so this stays `UInt64` with no
    ///     clamp needed.
    ///   - sequencePadWidth: minimum digit width for `{n}`; `0` means no
    ///     padding. Same UI-typed/negative-clamp reasoning as
    ///     `sequenceStart` applies below `0`. Above the engine's own bound
    ///     (`MAX_SEQUENCE_PAD_WIDTH`, 32) this is deliberately NOT clamped —
    ///     a too-large value is passed through so the engine rejects it with
    ///     the typed `.sequencePadWidthTooLarge` error, which the batch-
    ///     rename sheet surfaces inline per item rather than silently
    ///     capping the user's requested width to something they didn't ask
    ///     for.
    public static func render(
        template: String,
        originalStem: String,
        ext: String,
        capturedAtExifString: String?,
        sequenceStart: Int,
        sequenceIndex: UInt64,
        sequencePadWidth: Int
    ) throws -> String {
        let clampedSequenceStart = UInt64(max(0, sequenceStart))
        let clampedPadWidthFloor = max(0, sequencePadWidth)
        return try template.withCString { templateC in
            try originalStem.withCString { stemC in
                try ext.withCString { extC in
                    if let capturedAtExifString {
                        return try capturedAtExifString.withCString { dateC in
                            try renderRaw(
                                templateC: templateC, stemC: stemC, extC: extC, dateC: dateC,
                                sequenceStart: clampedSequenceStart, sequenceIndex: sequenceIndex,
                                sequencePadWidth: clampedPadWidthFloor)
                        }
                    }
                    return try renderRaw(
                        templateC: templateC, stemC: stemC, extC: extC, dateC: nil,
                        sequenceStart: clampedSequenceStart, sequenceIndex: sequenceIndex,
                        sequencePadWidth: clampedPadWidthFloor)
                }
            }
        }
    }

    /// Same rule set `render`'s output is checked against — exposed so a
    /// caller can validate a rendered/typed name without a template render.
    /// Thin re-export: `FilenameValidation.isValidPathComponent` already wraps
    /// `maple_validate_filename` for the New Folder / single-rename prompts;
    /// this keeps the batch-rename call sites reading from the engine that
    /// actually produced the name.
    public static func isValidName(_ name: String) -> Bool {
        FilenameValidation.isValidPathComponent(name)
    }

    private static func renderRaw(
        templateC: UnsafePointer<CChar>,
        stemC: UnsafePointer<CChar>,
        extC: UnsafePointer<CChar>,
        dateC: UnsafePointer<CChar>?,
        sequenceStart: UInt64,
        sequenceIndex: UInt64,
        sequencePadWidth: Int
    ) throws -> String {
        var result = maple_render_filename_template(
            templateC, stemC, extC, dateC,
            sequenceStart, sequenceIndex, UInt(sequencePadWidth))
        defer { maple_free_filename_result(&result) }
        guard result.error_code == 0, let namePtr = result.name_ptr else {
            throw FilenameTemplateError(code: result.error_code)
        }
        return String(
            decoding: UnsafeBufferPointer(start: namePtr, count: Int(result.name_len)),
            as: UTF8.self)
    }
}
