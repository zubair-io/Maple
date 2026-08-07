// BatchRenameTypes.cs — shared vocabulary for the batch-rename dialog
// (#2642): preview rows, apply outcomes, and the template-render function
// signature the dialog's ViewModel wires to the shared raw-core engine
// (Services/FilenameTemplateEngine.cs -> maple_render_filename_template_buf,
// #2628). WinUI-free by construction, like RenameLogic.cs, so it links into
// Maple.WinUI.Tests via this directory's wildcard include (see that
// project's .csproj header comment). The render step itself is injected as
// a delegate rather than called directly, so BatchRenameLogic — and its
// Maple.WinUI.Tests coverage — never needs to reference Native/RawFfi.cs,
// which IS unsafe P/Invoke code and must stay out of the test project (the
// project header comment documents a prior PR that broke the whole Windows
// build by linking Native\*.cs into it).

using System;

namespace Maple.WinUI.Services.FileOperations
{
    /// <summary>Result of rendering one filename from a template — mirrors
    /// the raw-core engine's `MapleFilenameResult` / the Self Hosted API's
    /// `RenderTemplatedNameResult` (filename-template.ts), so Windows'
    /// preview/apply agrees with Web/Apple/API byte-for-byte on both
    /// success and rejection reason.</summary>
    public readonly record struct FilenameRenderOutcome(bool Ok, string? Name, int ErrorCode, string? Error)
    {
        public static FilenameRenderOutcome Success(string name) => new(true, name, 0, null);
        public static FilenameRenderOutcome Failure(int code, string error) => new(false, null, code, error);
    }

    /// <summary>Renders one filename from a batch-rename template — the
    /// shared raw-core engine's signature
    /// (`raw_core::filename::render_filename` via
    /// `maple_render_filename_template_buf`). <paramref
    /// name="sequenceIndex"/> is the file's zero-based position within the
    /// batch; <paramref name="capturedAtWire"/> is EXIF
    /// `DateTimeOriginal` in its `"YYYY:MM:DD HH:MM:SS"` wire format, or
    /// null.</summary>
    public delegate FilenameRenderOutcome RenderFilenameTemplateFunc(
        string template,
        string originalStem,
        string ext,
        string? capturedAtWire,
        ulong sequenceStart,
        ulong sequenceIndex,
        int sequencePadWidth);

    /// <summary>One source file going into a batch rename — the pure input
    /// BatchRenameLogic needs, decoupled from PhotoItem (a WinUI/MVVM
    /// Toolkit type) so this stays linkable into Maple.WinUI.Tests.
    /// <paramref name="Key"/> is the caller's stable identifier for this
    /// item (Windows uses the photo's pre-batch FilePath) — carried through
    /// to <see cref="BatchRenamePreviewRow"/> / <see
    /// cref="BatchRenameItemOutcome"/> so the caller can map a row/outcome
    /// back to its PhotoItem.</summary>
    public sealed record BatchRenameSourceItem(
        string Key,
        string Directory,
        string CurrentFileName,
        string CurrentPath,
        string OriginalStem,
        string Ext,
        string? CapturedAtWire);

    /// <summary>One row of the live before/after preview list.</summary>
    public sealed record BatchRenamePreviewRow(
        string Key,
        string OldFileName,
        string? NewFileName,
        string? Error,
        bool IsDuplicateWithinBatch,
        bool ExtensionChanged)
    {
        /// <summary>True when this row would actually be attempted at apply
        /// time — a rendered name with no error. A duplicate row still
        /// counts: the collision policy chosen at apply time (auto-suffix /
        /// replace / fail) is what actually resolves a self-collision: the
        /// preview's <see cref="IsDuplicateWithinBatch"/> flag is a warning,
        /// not a hard stop, matching the Self Hosted API's
        /// `previewBatchRename` semantics.</summary>
        public bool WouldApply => Error == null;
    }

    public enum BatchRenameOutcomeKind
    {
        /// <summary>Renamed — or already had this exact name (a no-op is
        /// reported the same way; see this ticket's "report per-file
        /// outcomes" requirement).</summary>
        Relocated,
        /// <summary>Rejected before any filesystem write — a template
        /// render error or a MAX_PATH violation.</summary>
        Invalid,
        /// <summary>The filesystem relocate itself failed (collision under
        /// the "stop and show an error" policy, verification failure,
        /// permissions, a vanished source, …).</summary>
        Error,
    }

    /// <summary>One item's outcome from a sequential batch-rename apply.</summary>
    public sealed record BatchRenameItemOutcome(
        string Key,
        BatchRenameOutcomeKind Kind,
        string? OldFileName = null,
        string? NewFileName = null,
        string? NewPath = null,
        bool RenamedOnCollision = false,
        bool ExtensionChanged = false,
        string? Error = null);
}
